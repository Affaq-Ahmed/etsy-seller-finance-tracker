# Architecture

**Last updated:** 2026-11-25

This is the baseline architecture document: system design, data and financial model, security, deployment, and the dated decision log. Product rules are in [PRODUCT.md](PRODUCT.md), workflow in [DEVELOPMENT.md](DEVELOPMENT.md), and progress in [STATUS.md](STATUS.md). The source-of-truth hierarchy is defined in [PRODUCT.md](PRODUCT.md#source-of-truth-hierarchy).

The owner's reference specifications are [System Architecture v1.1](System_Architecture.md) and [Database ERD v1.2](Database_ERD.md). This document consolidates them with what has been **implemented** and **decided** since. Each section states whether it is:

- **Implemented**: enforced in migrations 0000–0009 (all frozen) and verified, or built in application code and verified by tests.
- **Proposed**: designed, not approved, not implemented.
- **Open**: needs an owner decision.

---

## 1. System overview (System Architecture v1.1 §1–4)

- **Modular monolith.** A single Next.js App Router application contains the UI, authentication, API, domain services, financial engine, imports, reports and job orchestration. No microservices.
- **Stack:** Next.js 16.4.6, React 19.3.0, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form, Zod, Recharts, PostgreSQL, Drizzle ORM, Better Auth. Cache Components are enabled in the Next.js config.
- **Domain modules** (System Architecture §4):
  1. Authentication
  2. Tenant/account management
  3. Orders
  4. Products
  5. Suppliers
  6. Supplier purchases
  7. Payout eligibility
  8. Payout batches
  9. Payoneer transactions
  10. Payoneer reconciliation
  11. Bank withdrawals
  12. Expenses
  13. Refunds
  14. Financial engine
  15. Expense allocation
  16. Reports
  17. Shipments
  18. Notifications
  19. Imports and exports
  20. Audit logging
  21. Background jobs

  Each module owns its services, schemas, repositories and validation. Business rules live in domain services, never directly in route handlers.
- **Background jobs** (System Architecture §7): a PostgreSQL-backed queue (`background_jobs`, tenant-owned) dispatched by a single Cloudflare Cron Trigger. Jobs are idempotent, short and chunked. External job services are not allowed.
- **Implementation state (2026-11-26):** the database layer (0000–0009), authentication, tenant resolution, onboarding and the tenant-scoped data access layer (§5, §7.2, §8), plus **Phase 2a**: suppliers, products, orders, supplier purchases with atomic confirmation and reversal, and profit before expenses and refunds (§5.1). Payouts, Payoneer, withdrawals, expenses, refunds, shipments and reports are not built.

## 2. Deployment and runtime (System Architecture v1.1 §3, §13–15)

Target: **Cloudflare Workers Free** via **OpenNext**, **Neon Free** PostgreSQL, the `workers.dev` domain, and zero mandatory cost. Findings were researched on 2026-11-24 and nothing has been deployed or measured.

| Fact | Status |
| --- | --- |
| Workers Free: 10 ms CPU per request and per cron run; 100,000 requests/day; 50 subrequests; 6 simultaneous outgoing connections; 128 MB memory; I/O wait does not count as CPU | Documented by Cloudflare |
| Worker size limit: Cloudflare's limits page says 64 MiB uncompressed, OpenNext's docs say 3 MiB compressed on Free | **Conflicting sources.** Measure with `wrangler deploy --dry-run` |
| `@opennextjs/cloudflare` supports all Next.js 16 versions; requires the Node.js runtime (no `edge`), `nodejs_compat` and Wrangler ≥ 3.99.0; Node `proxy.ts` support is experimental | Documented |
| Cloudflare guidance: authentication and SSR workloads typically use 10–20 ms CPU | Documented; the budget is tight |
| Cache Components under OpenNext | Untested |

### 2.1 Database connectivity (proposed)

Keep **postgres.js 3.4.9** (Hyperdrive requires > 3.4.5) and connect through **Cloudflare Hyperdrive**, which is included on Workers Free: 100,000 queries/day, about 20 origin connections, no egress charge. Point it at Neon's **direct, non-pooled** endpoint with a dedicated least-privilege role.

Connection rules:
- Create the client **per request** from the Hyperdrive binding, with `max: 5` and `fetch_types: false`. **Never** set `prepare: false`.
- Never create sockets in global scope.

The Neon serverless HTTP driver is **rejected**: it has no interactive transactions, which the posting, deferred-check and retry model requires.

Must be tested before adoption:
1. **Disable Hyperdrive query caching**, so cached balances or caps can never be served.
2. Transaction pooling means session state does not persist, so any tenant `set_config` must be transaction-local.
3. Re-run the concurrency suite through Hyperdrive.
4. Long-held transactions consume scarce origin connections.

### 2.2 Authentication compute (Accepted 2026-11-25, owner; not deployed)

Email/password hashing cannot run within Workers Free's 10 ms CPU limit (§8), so authentication is split (decision A19):

- The main application stays on Cloudflare Workers.
- `/api/auth/*` runs on **separate free Node.js compute**, using the same Better Auth code and database. The Worker proxies `/api/auth/*` to it, so the session cookie stays first-party on the application origin (`BETTER_AUTH_URL`).
- Session checks on the Worker are a database lookup plus an HMAC cookie check. They never hash a password.
- **No provider is selected or deployed.** At the deployment milestone, verify the provider's free-tier terms allow a commercial SaaS, and check reliability, cold starts and resource limits. The host needs about 32 MiB per concurrent hash (4 concurrent hashes peaked at about 150 MiB RSS locally).
- **Deployment is blocked** until the provider is validated. Further prerequisites:
  - Rate limiting needs a trusted client-IP header that clients cannot spoof (§8), and the auth service must accept traffic only from the Worker.
  - The Workers adapter must build the container per request (§5).
  - Hyperdrive and Neon behavior must be verified (§2.1).

### 2.3 Operating rules

- Never enable paid plans, overages or paid services (System Architecture §14).
- When a free quota runs out, report it and stop the affected writes safely.
- Provide manual export, backup and restore in user-controlled storage, and test restores before release (§15).

## 3. Data architecture (Implemented)

Defined by `src/db/schema.ts`, `src/db/auth-schema.ts`, `src/db/sql/*.sql` and `drizzle/0000–0009`.

**Runtime catalog (verified 2026-11-25 on PostgreSQL 18.6, fresh database, full chain):** 40 tables, 20 enums, 83 foreign keys, 137 indexes, 19 functions, 53 triggers, 10 recorded migrations. Migration 0009 (`0009_auth_rate_limit`) added only the auth-owned `rate_limit` table: `id` text PK, `key` text NOT NULL with unique index `rate_limit_key_uq`, `count` integer, and `last_request` bigint (epoch ms). This matches Better Auth 1.7.25's generated Drizzle model.

### 3.1 Tenancy

- **Tenant root:** `business_accounts`, one per owner, enforced by unique `business_accounts.owner_user_id` (`business_accounts_owner_uq`).
- **34 business tables carry a non-null `account_id`** with a direct, restrictive tenant-root FK. Child relationships use **composite FKs** that include `account_id`, and `currency` where money is involved, so cross-tenant or cross-currency links are rejected. Every composite target has an exact table-level UNIQUE key; these are emitted inline so that key-before-FK ordering is correct in the initial migration.
- The auth tables `user`, `session`, `account`, `verification` and `rate_limit` (0009) are not tenant-scoped. **In the auth `account` table, `account_id` is the external provider identity, not a tenant.**
- Deletion is **restrictive**, so business and financial history cannot cascade away. `audit_logs` actors are scoped to the account owner (V1).
- **Composite FKs prevent cross-tenant relationships on write. They do not authorize SELECT, UPDATE or DELETE.** Read isolation is an application responsibility (§7).

### 3.2 Values and identifiers

- **Money:** `NUMERIC(19,4)`. **FX:** `NUMERIC(19,8)`. Values are finite, carry sign checks, and complete fee amount/currency pairs.
- **Currency:** an uppercase three-letter format (not an ISO catalog). The withdrawal principal is fixed to USD and the receipt to PKR.
- Uniqueness covers:
  - one shop per owner
  - auth provider/account pairs
  - external payout and supplier references
  - allocation and reconciliation pairs
  - analytical scenario/order rows
  - financial source events
  - non-blank idempotency keys
- **Auth identity:** default text IDs. The Drizzle objects map to Better Auth models via `betterAuthSchema` (`user→users`, `session→sessions`, `account→authAccounts`, `verification→verifications`, `rateLimit→rateLimits`), with camelCase properties over snake_case columns and `usePlural: false`. Never map auth `account` to `business_accounts`.
- `exchange_rates` and `background_jobs` are **tenant-owned** (no global rows). Global scheduling dispatches per-tenant jobs. A shared reference-data model, if ever needed, must be separate from business records.

### 3.3 Naming differences from System Architecture v1.1 §5

| Older name | Implemented table |
| --- | --- |
| `users`, `sessions`, `accounts` (auth) | `user`, `session`, `account` |
| `accounts` (tenant) | `business_accounts` |
| `etsy_payout_items` | `etsy_payout_allocations` |
| `payout_reconciliations` | `payoneer_reconciliations` |

Added since then: `supplier_refunds`, `refund_adjustments`, `financial_posting_events`, `financial_posting_legs`, `shipments` and `shipment_events`.

## 4. Ledger and posting contract (Implemented)

The frozen migrations 0001 and 0005 and `src/db/sql/financial-*.sql` refer to `docs/Financial_Posting_Rules.md`. **That content now lives in this section.**

### 4.1 Invariants

- Every journal is tenant-owned and in one currency.
- Each line references a same-tenant, same-currency financial account, is finite and non-negative, and has exactly one non-zero side.
- Finalization requires at least two lines with equal non-zero debit and credit totals, validated by a deferred trigger at COMMIT.
- Finalized entries and lines are **immutable**, including legacy `REVERSED` rows. Status cannot be flipped.
- Source IDs resolve within the tenant, with source-specific currency rules.
- **Unsupported sources cannot post actual movements:** products, product default costs, expected payouts, allocations and reconciliation suggestions.
- **Canonical source types:** `order`, `supplier_purchase`, `supplier_refund`, `expense`, `refund`, `refund_adjustment`, `etsy_payout`, `payoneer_transaction`, `bank_withdrawal`, `adjustment`, `opening_balance`. Extending this list requires a reviewed migration.
- Source-event uniqueness plus a non-blank idempotency key prevents re-posting the same stored event. It **cannot** detect two manually entered rows for the same real-world fee or purchase. That needs provider external IDs and import duplicate review.

### 4.2 Financial account roles

`financial_accounts.account_role` makes accounting identity explicit, so the system never trusts editable names.

- **Asset roles:** `ETSY_RECEIVABLE`, `ETSY_PAYOUT_CLEARING`, `PAYONEER`, `BANK`, `TRANSFER_CLEARING`.
- `SUPPLIER_COST`, `DIRECT_EXPENSE` and `SHARED_EXPENSE` require EXPENSE accounts. `REVENUE` requires INCOME.
- `REFUND` may be an INCOME contra-revenue account or an EXPENSE account. Reports count a refund once in either representation. **Owner decision D5 = A (A34): the businesses use a contra-revenue INCOME account named *Etsy Refunds*.**
- Legacy accounts are `UNCLASSIFIED`. Assign roles deliberately before standard postings; nothing is guessed or backfilled. A legacy account may receive its first role without changing its type or currency.
- **A used classified role cannot change.**

### 4.3 Standard source rules

Amounts are the source event's actual amount. A side may be split among accounts of the matching role. Standard entries cannot add compensating wash lines to the same account, or override these rules with a declaration.

| Source / event | Amount; currency | Debit | Credit |
| --- | --- | --- | --- |
| order / INITIAL | `net_payable_amount`; order currency | ETSY_RECEIVABLE | REVENUE |
| supplier_purchase / INITIAL | `total_amount`; purchase currency | SUPPLIER_COST | Asset or liability (payment/payable). The application credits **Supplier Payable** (A25) |
| supplier_refund / INITIAL | `refund_amount`; purchase/refund currency | Asset receiving the refund | SUPPLIER_COST (reduces cost) |
| expense / INITIAL | `amount`; expense currency | DIRECT_EXPENSE or SHARED_EXPENSE per `expense_type` | Asset or liability (payment/payable) |
| refund / INITIAL | `refund_amount`; refund/order currency | REFUND (contra-revenue or expense) | Asset or liability (refunded/owed) |
| etsy_payout / INITIAL | `actual_amount`; payout currency | ETSY_PAYOUT_CLEARING | ETSY_RECEIVABLE |
| payoneer_transaction DEPOSIT / INITIAL | `amount`; transaction currency | PAYONEER | ETSY_PAYOUT_CLEARING |
| payoneer_transaction WITHDRAWAL / INITIAL | `amount`; transaction currency | TRANSFER_CLEARING | PAYONEER |
| payoneer_transaction FEE / INITIAL | `amount`; transaction currency | SHARED_EXPENSE | PAYONEER |
| payoneer_transaction / FEE (embedded) | `fee_amount`; `fee_currency` | SHARED_EXPENSE | PAYONEER (fee currency) |
| bank_withdrawal / INITIAL | `actual_pkr_received`; PKR | BANK | TRANSFER_CLEARING (PKR) |

**Supplier purchases.** Confirmation requires a purchase date, item totals that match, and the unique finalized INITIAL posting committed **atomically** (enforced by a deferred check). Costs and items then freeze, and only forward refund-status changes are allowed. A zero-cost purchase needs matching items but no journal. Supplier refunds require a previously confirmed purchase.

**Expenses** must be `CONFIRMED` before posting. **Partial refunds** post the recorded refund amount. No cumulative refund cap is imposed.

**Payouts, deposits and withdrawals.**
- Etsy payout and Payoneer deposit are distinct clearing events, and reconciliation never creates a second receipt.
- The USD principal stays on the Payoneer WITHDRAWAL; the PKR receipt is on `bank_withdrawals`.
- USD and PKR `TRANSFER_CLEARING` accounts are separate, and neither principal leg touches an expense account.
- **Actual PKR received is authoritative; `usd_amount × rate = actual_pkr_received` is not imposed.** FX gains and losses need their own explicit adjustment event.
- Bank fee fields are descriptive copies, not a posting source. Services must keep them consistent with the canonical Payoneer fee.

**Fees.** An embedded fee uses the transaction's FEE event in the fee currency. A standalone FEE transaction uses INITIAL and cannot also post an embedded fee. Imports must preserve principal/fee separation and declare net-statement conventions.

### 4.4 Declared instructions for ambiguous events (owner-approved)

`refund_adjustment`, Payoneer `ADJUSTMENT`/`OTHER`, `opening_balance` and generic `adjustment` cannot finalize without a `financial_posting_events` header and `financial_posting_legs`.

**Header:** tenant, source type/ID/event, a stable unique `event_key`, currency, `source_amount`, `amount_basis`, and an optional control account.
**Legs:** a tenant account, explicit currency, and exactly one non-zero debit or credit. Composite FKs enforce tenant and currency.

**Amount basis:**
- `TOTAL_DEBITS`: the sum of declared debits. `source_amount > 0`, and there is no control account.
- `NET_DEBIT` / `NET_CREDIT`: the net movement on the control account, which must appear in the legs. These support signed and compound journals.

Refund adjustments and Payoneer ADJUSTMENT/OTHER must match the signed source amount exactly. Opening balances measure the source account with a net basis; the caller supplies the offsets. Generic adjustments reference a different finalized same-currency journal, with an explicit correction-event name and amount basis.

**Matching.** The journal must match the declaration's source identity, currency, and `event_key` (used as the idempotency key), plus the **exact multiset** of legs. Event keys, source tuples and declaration references are unique per tenant. Instructions may be staged while in draft, but they become immutable once finalized, including adding or moving legs. A correction is a new event. **No accounting direction is inferred** from `adjustment_type`, descriptions, signs or `OTHER`.

### 4.5 Reversals (Implemented)

`SELECT reverse_journal_entry(tenant_id, original_entry_id, stable_event_key, reversal_timestamp)` runs inside the caller's transaction:
1. Lock the tenant and the original entry.
2. Create a draft with `source_event = REVERSAL` and `reversal_of_entry_id`.
3. Copy every line with debit and credit swapped.
4. Finalize.

The application must **commit before acknowledging success**.

- The original stays `FINALIZED` and immutable. The effective reversed state is derived from the finalized entry that references it. New `REVERSED` statuses are forbidden.
- A composite tenant/original/currency FK applies, and a unique index allows at most one reversal per original (including a draft).
- Self-reference, reversing a draft, reversing a reversal, and chains are rejected. Lines must be exact opposites, compared with `EXCEPT ALL`.
- A same-key retry returns the existing reversal. A different key fails.
- **A generic adjustment against an already reversed original is rejected**, including when the reversal is finalized later in the same transaction. A draft reversal alone does not block it.
- The function is **security-invoker**. Callers must pass the session-derived tenant.

### 4.6 Allocation, reconciliation and batch guards (Implemented)

Deferred, per-tenant checks:
- An expected batch total must equal the sum of its items.
- Etsy allocations cannot exceed either the actual payout or the expected item. Record an explicit adjustment first.
- Reconciliations must reference a **DEPOSIT**. Confirmed reconciliation totals cannot exceed the deposit or the payout. **Since 0008, only DEPOSIT transactions carry reconciliation capacity**, so signed ADJUSTMENT/OTHER amounts are unaffected.
- SUGGESTED and REVERSED reconciliations do not consume capacity.
- A bank withdrawal must match a USD WITHDRAWAL and its principal.
- Only confirmed SHARED expenses may be allocated, and allocations are capped per scenario (expense, period, method).
- An order may appear in only one active payout batch. Cancelled batches allow rebatching.

**Concurrency:**
- Aggregate writes serialize on the tenant row. A no-op tenant UPDATE makes repeatable-read transactions fail safely instead of validating stale sums.
- **Services must retry whole transactions on `40001` and `40P01`.** This model deliberately favors integrity over write throughput.
- Validators scan the tenant's related rows. Measure at realistic volume.

### 4.7 Shipments (Implemented)

- An order has zero or more shipments. Each shipment has an **append-only** event history.
- Restrictive tenant FKs and composite order/shipment FKs apply. Order deletion cannot erase shipments. Shipment deletion and event UPDATE/DELETE are rejected. Events carry no customer identity or address fields.
- A shipment is created as `PENDING`, and its initial PENDING event is appended automatically. Status changes **only** by appending events (`event_type`, `event_date`, optional description and location). A trigger validates the transition and updates `shipment_status`, `shipped_at` and `delivered_at` atomically. Direct status or timestamp writes are rejected.
- Carrier, tracking reference/URL, estimated delivery and notes are editable. Each edit appends a NOTE event plus an audit entry whose `before_data` and `after_data` include notes (explicit nulls on add or clear).

| Current | Allowed next |
| --- | --- |
| PENDING | SHIPPED, CANCELLED |
| SHIPPED | IN_TRANSIT, DELIVERED, EXCEPTION, RETURNED, CANCELLED |
| IN_TRANSIT | IN_TRANSIT, DELIVERED, EXCEPTION, RETURNED |
| EXCEPTION | IN_TRANSIT, DELIVERED, RETURNED, CANCELLED, EXCEPTION |
| DELIVERED | RETURNED |
| RETURNED / CANCELLED | Terminal; NOTE events still allowed |

- Status events cannot precede `shipment.created_at` or the last status event; events exactly at `created_at` are valid. Historical NOTE events may predate creation and never change state. Ties are ordered by the generated `event_sequence`. `delivered_at` cannot precede `shipped_at`.
- A terminal status is corrected with a **new shipment plus a NOTE**, never by rewriting history.
- **Shipment status is independent of `orders.status`, `orders.delivered_at`, payout eligibility and the ledger.**
- Indexes cover tenant/order, carrier/tracking, status/estimated delivery, and event sequence/date.

### 4.8 Data limitations (Implemented boundaries)

- **PII:** free text, JSON import payloads, URLs and audit copies cannot be guaranteed PII-free by the database. Ingestion must allowlist fields and redact before writing.
- **Pre-guard history:** existing finalized or malformed history is not rewritten. Review any legacy or imported history before deploying.
- **Service validation still required:** draft polymorphic source references, notification references and audit entity references. `updated_at` maintenance, audit-log creation and actor attribution are also service responsibilities.

## 5. Application layer (Implemented 2026-11-25)

| Path | Responsibility |
| --- | --- |
| `src/server/config/env.ts` | Zod validation of `NODE_ENV`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`. `ConfigError` lists variable **names** only. `getConfig()` is called only by the composition root. |
| `src/instrumentation.ts` | Startup validation: a Node server refuses to start with invalid configuration. It is skipped during `next build`, so builds need no runtime secrets. |
| `src/server/container.ts` | Composition root (plain factories, no DI library): `createContainer(config)` wires `createDb` and `createAuth`. On Node there is one container per process, kept on `globalThis`. **The Workers adapter must build it per request** (§2.1; deployment milestone). |
| `src/server/db/` | `createDb` (postgres.js, `max: 5`, prepared statements on), `runInTransaction` (bounded whole-transaction retry on `40001`/`40P01`, 3 attempts, resolves after COMMIT), and `getPostgresErrorCode`. |
| `src/server/dal/` | **The only code that queries tenant data.** `tenantScope(db, tenant)` adds `account_id = tenant.accountId` to every SELECT, UPDATE and DELETE, sets it on every INSERT, and throws `TenantScopeViolationError` if a caller supplies `accountId`, `account_id`, `tenantId` or `ownerUserId`. Modules: `business-accounts` (tenant root), `account-settings`, `financial-accounts`, `audit-logs`. |
| `src/server/auth/` | Better Auth configuration (§8), session and tenant resolution, and page guards (§7.2). |
| `src/server/http/` | `sessionRoute`/`tenantRoute` wrappers, the same-origin check, strict JSON bodies (16 KiB cap), generic error mapping and `Cache-Control: private, no-store`. |
| `src/server/onboarding/`, `src/server/business/`, `src/server/api/` | The onboarding service, the business summary, and thin route handlers. |

- **API style (decision A16):**
  - Better Auth's own handler (`/api/auth/*`), used through its browser client, keeps Better Auth's built-in Origin/CSRF checks and rate limits. Direct server-side `auth.api` calls would bypass them, so they are used only for `getSession`.
  - The app's own endpoints are versioned Route Handlers: `POST /api/v1/onboarding` and `GET /api/v1/business`.
  - **No Server Actions**, so Better Auth's `nextCookies()` plugin is not used.
- **Errors:**
  - `23505` → 409; `23503`, `23514` and `P0001` → 422; anything else → 500. All carry generic messages.
  - drizzle-orm 0.45's `DrizzleQueryError` embeds the **SQL and its parameters** in `message`, so error messages are never returned or logged. Only the error name and SQLSTATE are logged.
- **Static guards:** ESLint `@typescript-eslint/no-restricted-imports` allows the schema, `drizzle-orm`, `postgres` and value imports of the database client only in `src/db`, `src/server/{db,dal,auth}` and `src/server/container.ts`. `tests/app/unit/static-guards.test.ts` enforces the same rule plus the T16–T18 checks.
- **Financial writes:** each runs in one transaction with a deterministic event key (e.g. `supplier_purchase:<id>:INITIAL`) via `runInTransaction`, and is acknowledged only after COMMIT.

### 5.1 Orders and supplier purchases (Implemented 2026-11-26, Phase 2a)

No schema change: migrations 0000–0009 and their hashes are untouched, and `drizzle-kit generate` reports no changes.

| Path | Responsibility |
| --- | --- |
| `src/lib/money.ts` | Exact money: scale-4 `bigint` (the scale of NUMERIC(19,4)); inputs have at most 2 decimals; never rounds, never uses floating point. Limit 999,999,999,999.99 |
| `src/lib/dates.ts` | Calendar date ⇄ instant in the business timezone (Intl only, DST-safe) |
| `src/lib/validation.ts` | PII screening (email, phone), URL and identifier patterns, shared by forms and the server |
| `src/server/dal/{suppliers,products,orders,order-items,supplier-purchases,supplier-purchase-items,journal,order-profit}.ts` | Tenant-scoped data access. Joins and row locks use `scope.executor` with `tenantEq()` on every table, only inside the DAL |
| `src/server/{suppliers,products,orders,purchases}/service.ts` | Business rules, strict Zod input schemas, transactions and audit entries |
| `src/server/orders/{status,profit}.ts` | The status transition table and the profit view |
| `src/server/ledger/{accounts,posting}.ts` | Account resolution, the purchase posting and its reversal, deterministic event keys |
| `src/server/api/*.ts`, `src/app/api/v1/**/route.ts` | Thin handlers and routes, wrapped by `tenantRoute` with validated route parameters |
| `src/app/app/**`, `src/components/**` | Pages (list, detail, create) and accessible client forms that call the JSON API |

**API (all `private, no-store`, tenant from the session only, same-origin required for writes):**

| Method and path | Result |
| --- | --- |
| `GET`, `POST /api/v1/suppliers`; `GET`, `POST /api/v1/products` | List (`?limit=1..100&offset=`), create (201) |
| `GET`, `POST /api/v1/orders` | List with profit per order; create with items (201); duplicate Etsy ID is 409 naming `etsyOrderId` |
| `GET`, `PATCH /api/v1/orders/:orderId` | Detail (items, locked flags, purchases, profit, allowed next statuses); edit header and, while unlocked, items |
| `POST /api/v1/orders/:orderId/status` | One approved transition (A26); a repeat is a no-op |
| `GET`, `POST /api/v1/purchases`; `GET`, `PATCH /api/v1/purchases/:purchaseId` | List; create a DRAFT (posts nothing); detail (with `canConfirm` and `confirmBlockedReason`); edit a draft only. Create and edit reject a cancelled order's items: 422 `ORDER_CANCELLED` naming `lines.N.orderItemId` (A35) |
| `POST …/confirm`, `…/cancel`, `…/reverse` | Confirm (A25), cancel a draft, reverse with a required reason |

Errors are generic and name fields only. Unknown, malformed and other-tenant IDs all answer 404 `NOT_FOUND`; references to another tenant's product, supplier, order item or replaced purchase answer exactly like unknown ones (422).

**Confirmation algorithm (one transaction, whole-transaction retry on `40001`/`40P01`, resolves after COMMIT):**
1. Lock the purchase row `FOR UPDATE`. If it is already confirmed, return the existing posting (`alreadyConfirmed: true`) and write nothing.
2. Require status DRAFT, a purchase date, the business currency, at least one line, line currencies equal to the purchase currency, stored total equal to the exact sum of the lines, and a total above zero. Then lock the distinct orders of the lines in ID order (`FOR UPDATE`) **before any write**, and refuse with 409 `ORDER_CANCELLED` if any of them is cancelled (A35).
3. Resolve the single active `SUPPLIER_COST` account in the currency (none or several fails closed) and the Supplier Payable account.
4. Set CONFIRMED with `confirmed_at`; insert a DRAFT journal entry (key `supplier_purchase:<id>:INITIAL`, dated at the purchase date) with the two lines; finalize it.
5. Move each affected `NEW` order (already locked in step 2) to `SUPPLIER_ORDERED`, in ID order; write audit entries.
6. At COMMIT the database re-validates balance, the posting rules and that the confirmation and its journal commit together. Any failure rolls everything back.

**Reversal:** lock the purchase; require it to be confirmed; call `reverse_journal_entry` with the key `supplier_purchase:<id>:REVERSAL` (exact opposite lines; a retry returns the existing reversal); audit the reason. The original entry, the purchase row and its lines are never edited.

**Profit query** (`dal/order-profit.ts`): one tenant-constrained aggregate. Confirmed cost counts lines of purchases with status CONFIRMED, PARTIALLY_REFUNDED or REFUNDED that have **no finalized reversal**; draft lines are summed separately and never counted. **Supplier refunds (Phase 2b) must subtract refund amounts here**: purchases in the refunded statuses are currently counted at full cost. **Revenue** is the recorded net payable, or **zero for a CANCELLED order** (`orders/profit.ts`; the response keeps `netPayable` as recorded and adds `revenue` and `revenueExcluded`). Confirmed costs of a cancelled order keep counting, so it shows a loss; nothing is reversed automatically (A35).

**Known limits:**
- Purchases are created for one order at a time in the UI (the API accepts lines on several orders); order editing and draft-purchase editing have an API but no form yet; an order item referenced by any purchase line, including a cancelled draft, stays locked.
- "No new purchase on a cancelled order" and "no confirmation of a draft that covers one" are enforced by the **application** (A35), not by the database. A writer that bypasses the service (raw SQL) could still do it. Enforcing it in the database needs a trigger, which is a new migration and is not approved.
- There is **no application-level rate limiting on `/api/v1/*`**: Better Auth rate-limits only its own endpoints (T19). Rely on host-level limits at deployment, which are unverified.
- Creating a purchase checks its order items before inserting. If another request replaces those items in between, the foreign keys still prevent a dangling line and the loser receives a generic 422. There is no pre-check lock.
- Double submission of "create purchase" creates two drafts (the UI disables the button while pending); there is no natural key unless a supplier reference is given.

## 6. Imports, exports and notifications (System Architecture v1.1 §9–10)

- **Imports** (CSV/Excel for Payoneer, products, orders): upload → parse/validate → preview → duplicate detection → invalid-row report → confirm → record results. Use provider external IDs for duplicate detection. Imports must declare principal/fee and net-statement conventions and filter PII.
- **Exports:** CSV and Excel.
- **Notifications:** in-app by default. Email (e.g. Brevo Free) only after verifying its terms, and the application must keep working without it.

## 7. Security model

### 7.1 Implemented (database)

- Composite tenant/currency FKs, restrictive deletes, immutability triggers, deferred integrity checks and security-invoker functions.
- **Runtime-role requirement (not yet configured):** the application role must not own tables and must not have `TRUNCATE`, trigger-disabling or trigger-creation privileges.
- **Read authorization is enforced by the application** (the tenant-scoped data access layer, §5 and §7.2). It is not enforced in the database: there is no RLS yet.

### 7.2 Authentication and tenant isolation (Implemented 2026-11-25)

**Non-negotiable rule.** Tenant identity comes **only** from the authenticated server-side session. Tenant IDs from bodies, query strings, route params, headers, non-session cookies or client state are never trusted.

**Tenant context**
- `src/server/auth/session.ts` holds the request-agnostic logic:
  - `resolveSession(deps, headers)` reads the Better Auth session through `auth.api.getSession`.
  - `resolveTenant(deps, headers)` resolves `session.user.id → business_accounts.owner_user_id` and returns `unauthenticated`, `not_onboarded`, or `ok` with `{ userId, sessionId, accountId: TenantId }`.
- `TenantId` is a branded type created **only** in `session.ts`, either by `resolveTenant` or by `tenantForOwnedBusiness`, which first checks that the session user owns the business. The static guards enforce this.
- Page guards (`src/server/auth/page-guards.ts`): `requireSession()`, `requireTenant()` and `requireOnboardingSession()`, memoized per request with React `cache()`.
- Route wrappers (`src/server/http/routes.ts`): `sessionRoute()` and `tenantRoute()`.

| Situation | Page | API |
| --- | --- | --- |
| No session; invalid, tampered, expired or revoked session | Redirect to `/sign-in` | 401 `UNAUTHENTICATED`. A stale session cookie is cleared (`Max-Age=0`). Pages cannot clear cookies; the stale cookie is rejected on every request and replaced at the next sign-in |
| Signed in but no business yet | Redirect to `/onboarding` | 409 `ONBOARDING_REQUIRED` |
| Signed in with a business | Tenant context | Tenant context |

**Onboarding (decision A22).** `POST /api/v1/onboarding` (`sessionRoute`) takes `{ "shopName": string }`: trimmed, 1–160 characters, strict schema. One transaction (`runInTransaction`) creates:
1. `business_accounts`, via `INSERT … ON CONFLICT (owner_user_id) DO NOTHING`. A retry, a race or a second attempt returns the existing business unchanged (200, `created: false`). A new business returns 201. A concurrent request waits on the unique index and then sees the committed business. There is no tenant switching.
2. `account_settings` with documented keys: **`payout_eligibility_delay_days` = 14** and **`payout_weekday` = `"MONDAY"`** (JSONB values; configurable per business, PRODUCT.md §5 rule 15).
3. The starter chart of `financial_accounts`, with explicit roles. `TRANSFER_CLEARING` exists in USD (the Payoneer withdrawal principal) and PKR, `BANK` is PKR, and `ETSY_RECEIVABLE`, `ETSY_PAYOUT_CLEARING`, `PAYONEER`, `SUPPLIER_COST`, `DIRECT_EXPENSE`, `SHARED_EXPENSE` and `REVENUE` use the business base currency (USD by default). **No `REFUND` account yet.** D5 is decided (contra-revenue INCOME *Etsy Refunds*, A34) but the account arrives with the customer-refund slice (Phase 2b). There are no undocumented PKR expense accounts.
4. `audit_logs` entries (`CREATE`, actor = owner, `before_data` null) for the business, both settings and every account. The existing `audit_logs_owner_tenant_fk` makes the database reject any other actor.

Onboarding posts no journal entries. Any failure rolls the whole transaction back.

**Isolation rules**
- An ID belonging to another tenant returns the same **not-found** result as a non-existent ID (the DAL returns `null`; the API returns 404 `NOT_FOUND`).
- Inserts take `account_id` from the context only. Updates cannot change `account_id`.
- Zod input schemas are strict and never contain `accountId`, `account_id`, `tenantId` or `ownerUserId`. An unknown key returns 400 naming the field, never its value.
- State-changing app API requests must carry `Origin` equal to `BETTER_AUTH_URL`. If `Sec-Fetch-Site` is sent, it must be `same-origin`.
- Static guards:
  - Only the DAL, auth, db and container modules import the database.
  - Every route handler uses `sessionRoute`/`tenantRoute` or is annotated `// public:`; every page calls a page guard or is annotated `// public:`.
  - The T16 meta-test lists all 34 tenant tables. The **11 exposed tables** must have a DAL module and cross-tenant tests, and the other **23** must be imported by no application code. Exposed: `account_settings`, `financial_accounts`, `audit_logs` (M2) and `suppliers`, `products`, `orders`, `order_items`, `supplier_purchases`, `supplier_purchase_items`, `journal_entries`, `journal_lines` (Phase 2a; cross-tenant tests in `phase2-isolation`).
  - `scope.executor` may be used only inside `src/server/dal/`, and every DAL file that uses it must constrain tables to the session tenant (A33).

**Sessions (owner-confirmed 2026-11-25)**
- Database sessions: `expiresIn` 7 days, `updateAge` 1 day. **The cookie cache is disabled**, so sign-out and revocation take effect on the next request.
- Cookies are `HttpOnly` and `SameSite=Lax` with `Path=/`. `Secure` and the `__Secure-` prefix are used exactly when `BETTER_AUTH_URL` is https, which configuration requires in production.
- Sign-out deletes the session. `revokeSessionsOnPasswordReset` is configured; password reset itself is deferred (PRODUCT.md D2).

**Account enumeration (decision A20)**
- Sign-up uses `autoSignIn: false`. A duplicate sign-up returns the same 200 response shape as a new account (a synthetic user and `token: null`), runs a dummy hash to even out timing, sets no cookie and leaves the existing account untouched. Users then sign in.
- Sign-in returns the same 401 for an unknown email and for a wrong password, and Better Auth runs a dummy hash for unknown emails.
- Better Auth's logger is set to `warn` with a message-only sink, so duplicate attempts never log the email address.
- **Remaining limitation (accepted):** someone can still test whether an email is registered through the sign-in flow, for example by signing up with a password of their choice and then trying to sign in. Rate limiting slows this down. Full mitigation requires email verification, which is deferred with PRODUCT.md D2.

**Next.js 16 specifics**
- There is no `proxy.ts`. Every protected page and route handler calls its guard itself; layouts are not a security boundary.
- Cache Components:
  - Session reads happen inside `<Suspense>`, so `/app` and `/onboarding` build as partial prerenders.
  - Guards and route wrappers read `headers()`/`request.headers` **before** anything else, so nothing session-dependent is prerendered at build time.
  - There are **no cache directives** (`'use cache'` in any form) in `src`.
  - Every app and auth API response is `Cache-Control: private, no-store`.

**Defense in depth (later; separate approval and forward migration).** A least-privilege runtime role, then optional RLS with **transaction-local** `set_config('app.account_id', …, true)`. The transaction-local form is required under Hyperdrive.

**Security tests (status 2026-11-26; all against the disposable PostgreSQL 18.6 database).** T1–T5 and T7 also run for every Phase 2a endpoint and table in `db/phase2-isolation`: reads, writes and state changes across tenants answer like a missing record and change nothing; references to another tenant's records are rejected like unknown IDs; forged tenant fields are refused on every write endpoint; unauthenticated (401), not-onboarded (409) and foreign-origin (403) requests are checked on all 16 routes.

| # | Case | Status | Where (`tests/app/`) |
| --- | --- | --- | --- |
| T1 | Cross-tenant SELECT | Pass | `db/tenant-isolation` |
| T2 | Cross-tenant UPDATE | Pass | `db/tenant-isolation` |
| T3 | Cross-tenant DELETE | Pass | `db/tenant-isolation` |
| T4 | Cross-tenant INSERT (forged tenant keys; child row referencing another tenant's parent → `23503`) | Pass | `db/tenant-isolation` |
| T5 | Forged tenant IDs in body, query, headers and cookies | Pass | `db/tenant-isolation`, `unit/onboarding-rules` |
| T6 | Second business / tenant switching | Pass | `db/onboarding` |
| T7 | Unauthenticated routes and pages | Pass | `db/api-routes`, `unit/page-guards` |
| T8 | Invalid or tampered sessions (signature altered at five positions, truncated, extended, empty; token without signature) | Pass | `db/auth-flows`, `db/api-routes` |
| T9 | Expired session | Pass | `db/auth-flows`, `db/api-routes` |
| T10 | Logout replay | Pass | `db/auth-flows`, `db/api-routes` |
| T11 | Reset revokes sessions | **Deferred**: reset is out of scope until PRODUCT.md D2. The option is configured and asserted in `unit/auth-config` | — |
| T12 | Concurrent onboarding (parallel requests, plus an observed lock wait with COMMIT and ROLLBACK) | Pass | `db/onboarding` |
| T13 | Signed in but not onboarded | Pass | `db/onboarding`, `db/api-routes`, `unit/page-guards` |
| T14 | CSRF and Origin (Better Auth and app API) | Pass | `db/origin-csrf`, `unit/http` |
| T15 | Account enumeration | Pass, with the documented limitation | `db/auth-flows` |
| T16 | Coverage meta-test | Pass | `unit/static-guards` |
| T17 | Static guards | Pass | `unit/static-guards`, ESLint |
| T18 | Cache safety | Pass | `unit/static-guards`, `db/api-routes` |
| T19 | Rate limiting (database storage, per IP and path, concurrent burst, window reset) | Pass | `db/rate-limit` |

## 8. Authentication (Implemented 2026-11-25)

**Pinned versions (owner-approved; decision A21).** All were rechecked against the GitHub advisory database and the npm registry on 2026-11-25 before installation: none is deprecated and no advisory affects any of them.

| Package | Version | Notes |
| --- | --- | --- |
| `better-auth`, `@better-auth/drizzle-adapter` | 1.7.25 | Newest patch that had been public for at least 7 days. Above every published fix (GHSA-965c-763c-88jm, GHSA-r4xp-prcw-77qf, GHSA-44jh-23m7-hpcf: all fixed in 1.7.7) |
| `drizzle-orm` | 0.45.4 | The previous 0.44.7 was affected by GHSA-gpj5-g38j-94v9 (high; SQL injection via identifiers; fixed 0.45.2) |
| `drizzle-kit` | 0.31.11 | The no-drift gate passed (DEVELOPMENT.md §7) |
| `postgres` | 3.4.9 | Unchanged; now exact. The 4.x line exists but was not evaluated |
| `zod` | 4.6.7 | Now a direct dependency (config and input validation) |
| `vitest` / `vite` (dev) | 4.1.12 / 7.3.8 | Vite 7 brings its own esbuild 0.28; vite 8 left an invalid optional esbuild peer |
| `overrides` (owner-approved) | `@better-auth/core` 1.7.25, `better-call` 1.4.5, `vite` → `$vite` | Without the first two, npm resolved an unapproved core 1.7.28 / `better-call` 1.4.6 as a *second* copy: two transaction contexts and two `APIError` classes. `$vite` makes vitest's own dependency use the root vite 7.3.8 pin |

- **Correction (2026-11-25):** GHSA-9hm7-xhfp-cx58, cited in the 2026-11-24 research, does not exist in the GitHub advisory database.
- **Rejected:** drizzle 1.0 RC (pre-release, breaking postgres-js codec changes).
- **Known audit findings (pre-existing, not fixable within the pinned set):** 4 moderate, all from GHSA-67mh-4wv8-2f99 in esbuild 0.18.20 nested under drizzle-kit's `@esbuild-kit` loader. They affect only esbuild's dev server, which this project never runs. The committed baseline lockfile has the same versions, and npm's only "fix" is a downgrade to drizzle-kit 0.18.1. GHSA-gv7w-rqvm-qjhr was withdrawn (it was filed against the wrong package).

**Configuration (`src/server/auth/auth.ts`)**
- `drizzleAdapter(db, { provider: 'pg', schema: betterAuthSchema, usePlural: false, transaction: true })`, with default text IDs. Joins are off via `advanced.database.joins: false`; in 1.7.25 the option lives there, not under `experimental`.
- `emailAndPassword`: enabled, 12–128 characters, `autoSignIn: false`, `requireEmailVerification: false` (D2), `revokeSessionsOnPasswordReset: true`. **Default hasher** (no custom `password` option).
- `baseURL` and `trustedOrigins` are set to `BETTER_AUTH_URL`.
- **`advanced.disableOriginCheck: false` and `disableCSRFCheck: false` are set explicitly.** Better Auth 1.7.25 skips its origin check whenever `NODE_ENV=test` unless this is set (`skipOriginCheck = isTest()`), so the tests would otherwise run against a weaker configuration than production.
- `useSecureCookies` is true exactly when `BETTER_AUTH_URL` is https.
- Telemetry is explicitly off (it defaults to off).
- Logger: `level: 'warn'`, plus a sink that writes the message only and reduces attached errors to their name. Better Auth's default sink would print errors whose messages contain SQL parameters.
- **No plugins.** In particular, no `nextCookies()`, because there are no Server Actions (A16). No magic-link, OAuth, SSO, admin or organization plugins in V1.
- The route handler `src/app/api/auth/[...all]/route.ts` calls `auth.handler` and marks responses no-store.

**Rate limiting (decision A18; migration 0009)**
- `rateLimit: { enabled: true, storage: 'database' }` applies in every environment; Better Auth's default is production only.
- The window and limits are **Better Auth's defaults, unchanged**: 100 requests per 10 s overall, and 3 per 10 s on `/sign-in*` and `/sign-up*`, per client IP and path.
- Storage uses atomic conditional increments on the unique `key`. A concurrent burst of 12 requests let through exactly 3 (T19).
- **Deployment prerequisite:**
  - Better Auth trusts a single-value `x-forwarded-for` by default (`advanced.ipAddress.ipAddressHeaders`). Anyone who can reach the auth service directly can spoof that header, and with no IP header at all every request shares one bucket (outside dev and test).
  - Before deployment, configure the trusted header the Worker proxy sets (for example `cf-connecting-ip`), and accept auth traffic only from the Worker.

**Schema**
- `tests/fixtures/better-auth-1.7.25.json` is generated from the installed `getAuthTables({ rateLimit: { storage: 'database' } })`.
- The `user`, `session`, `account` and `verification` fields are **identical to the earlier 1.6.3 manifest**; only `rateLimit` was added (0009). The offline test checks the pinned version against this manifest.
- The adapter also includes a runtime schema check (`findDrizzleSchemaProblems`).
- **Better Auth issue #12837 is confirmed in 1.7.25:** sign-up hashes the password inside the adapter transaction (`runWithTransaction`), holding a database connection for roughly 45 ms. That is acceptable locally; it must be counted in the auth host's connection budget at deployment.

**Password hashing (gate resolved by decision A19)**
- **Verified from source** (`@better-auth/utils@0.5.1`): scrypt with N=16384, r=16, p=1 and a 64-byte key (`maxmem` 64 MiB), which is **32 MiB per hash**.
- Under the `node` and `workerd` export conditions it uses native `node:crypto` scrypt; pure-JS `@noble/hashes` is only a fallback. The earlier "seconds of CPU" concern was about the pure-JS path.
- Stored format: `<16-byte hex salt>:<64-byte hex key>` (asserted in `db/auth-flows`).
- **Benchmark (2026-11-25, installed hasher, Node 26.10.0, Apple M4, 30 runs):**
  - `hashPassword`: CPU p50 43.8 ms, p95 44.4 ms.
  - `verifyPassword`: CPU p50 43.9 ms, p95 45.6 ms.
  - Peak RSS 54 MiB for one hash at a time; 4 concurrent hashes took 59.7 ms wall and 218.8 ms total CPU, with 150.5 MiB RSS.
- That is about 4.4× the Workers Free 10 ms limit on a faster core than Cloudflare's, so the work factor was kept and authentication moves to separate Node compute (§2.2). **Not measured on Workers itself.** That measurement is no longer needed, because auth does not run there.

## 9. Architecture decision log

| ID | Date | Decision | Status |
| --- | --- | --- | --- |
| A1 | 2026-11-23 | Modular monolith on Next.js; Workers Free + OpenNext; Neon Free; Drizzle; Better Auth; PostgreSQL job queue + one cron trigger; zero cost (System Architecture v1.1 §17) | Accepted (owner) |
| A2 | 2026-11-24 | `business_accounts` is the tenant root; one shop per owner; 34 tenant tables with non-null `account_id`; restrictive deletes; composite tenant/currency FKs with inline UNIQUE targets | Implemented (0000) |
| A3 | 2026-11-24 | Exact decimals (19,4) and FX (19,8); three-letter currency format; USD and PKR never mixed in one journal | Implemented |
| A4 | 2026-11-24 | Tenant-owned `exchange_rates` and `background_jobs` (owner requirement over the global rows in ERD v1.1) | Implemented |
| A5 | 2026-11-24 | Double-entry ledger: deferred balance validation, immutability, source-event uniqueness, canonical source types, atomic supplier confirmation | Implemented (0000–0001) |
| A6 | 2026-11-24 | Explicit financial account roles | Implemented (0004) |
| A7 | 2026-11-24 | Declared instructions for ambiguous events (owner-approved); standard source leg rules; atomic `reverse_journal_entry` | Implemented (0002–0003, 0005) |
| A8 | 2026-11-24 | Manual shipments with append-only, event-projected state, independent of order delivery and payouts | Implemented (0002, 0006) |
| A9 | 2026-11-24 | Shipment creation-date floor; adjustments rejected against reversed originals; complete notes audit | Implemented (0007) |
| A10 | 2026-11-24 | Tenant-row serialization for aggregate checks; services retry `40001`/`40P01` | Implemented / service requirement |
| A11 | 2026-11-24 | Reconciliation capacity applies only to DEPOSIT transactions (defect fix) | Implemented (0008) |
| A12 | 2026-11-24 | **Migrations 0000–0008 frozen**: forward-only, SHA-256 manifest, never `drizzle-kit push` | Accepted; extended to 0000–0009 by A24 |
| A13 | 2026-11-24 | `drizzle.config.ts` loads environment via `@next/env` (Next.js precedence, `.env.local`); generation works offline without a URL | Implemented |
| A14 | 2026-11-24 | Database tests run only against a disposable, loopback-only Docker database through `scripts/local-db.cjs`; never `DATABASE_URL`, Neon or production | Implemented |
| P1 | 2026-11-24 | Better Auth 1.7.x + drizzle-orm 0.45.4 + drizzle-kit 0.31.11 (§8) | Superseded by A21 |
| P2 | 2026-11-24 | postgres.js via Hyperdrive, caching disabled, direct Neon endpoint (§2.1) | Proposed; verification deferred (A23) |
| P3 | 2026-11-24 | Session-derived tenant context, DAL, onboarding, session policy, test matrix (§7.2) | Implemented (A22) |
| A15 | 2026-11-25 | Vitest 4.1.12 for application tests (`tests/app/`). The existing `node:test` database suites stay. Playwright is deferred to the frontend phase (resolves C1) | Accepted (owner); implemented |
| A16 | 2026-11-25 | Better Auth's own handler plus browser client for sign-up, sign-in and sign-out; versioned Route Handlers `POST /api/v1/onboarding` and `GET /api/v1/business`; no Server Actions, so no `nextCookies()` (resolves C2) | Accepted (owner); implemented |
| A17 | 2026-11-25 | Configuration: Zod-validated environment, startup validation in `instrumentation.ts` (skipped at build), plain factories and a composition root, no DI library (resolves C4) | Accepted (owner); implemented |
| A18 | 2026-11-25 | Database-backed Better Auth rate limiting through forward migration **0009** (`rate_limit`), enabled in all environments, with Better Auth's default limits (resolves C5) | Accepted (owner); implemented |
| A19 | 2026-11-25 | Email/password with Better Auth's default scrypt (work factor unchanged). `/api/auth/*` runs on separate free Node compute behind the Worker proxy; the main app stays on Workers. No provider selected; deployment blocked until one is validated (§2.2; resolves C3 and PRODUCT D1) | Accepted (owner); code implemented, not deployed |
| A20 | 2026-11-25 | Enumeration resistance: `autoSignIn: false`, a generic duplicate sign-up response, no cookie at sign-up, users sent to sign-in, logger at `warn`. The sign-in-flow limitation is documented and accepted until email verification (D2) | Accepted (owner); implemented |
| A21 | 2026-11-25 | Exact pins: better-auth and drizzle-adapter 1.7.25, drizzle-orm 0.45.4, drizzle-kit 0.31.11, postgres 3.4.9, zod 4.6.7, vitest 4.1.12, vite 7.3.8; `overrides` for `@better-auth/core` 1.7.25, `better-call` 1.4.5 and `vite` → `$vite` (all owner-approved; `$vite` confirmed 2026-11-25). Installed with `--ignore-scripts --userconfig /dev/null` | Accepted (owner); implemented |
| A22 | 2026-11-25 | Separate idempotent onboarding transaction: settings `payout_eligibility_delay_days`/`payout_weekday`; explicit-role starter chart without REFUND (D5) and without undocumented PKR expense accounts; audit entries using the existing `audit_logs` schema | Accepted (owner); implemented |
| A23 | 2026-11-25 | Hyperdrive and Neon checks deferred to the deployment milestone. Only the disposable local database is used; Hyperdrive and Neon behavior is **unverified** | Accepted (owner) |
| A24 | 2026-11-25 | **Migration 0009 frozen.** Its SQL and snapshot SHA-256 values are in `tests/baseline-migrations.json` (20 entries, 0000–0009). It is never edited, reordered or regenerated; later changes are forward-only from 0010 | Accepted (owner) |
| A25 | 2026-11-26 | **Supplier Payable.** Confirming a purchase debits `SUPPLIER_COST` and credits a USD (base currency) LIABILITY account named *Supplier Payable* with the existing `UNCLASSIFIED` role. No new role exists, so the account is found by exact name, type and currency; accounts are never renamed or retyped by the application. It is part of the starter chart, and a business onboarded earlier gets it created, once and audited, inside its first confirmation. **PAYONEER is not credited**, so a later Payoneer import cannot double-count the payment. Phase 3 settlement (proposed, to confirm as D7): record the payment with explicit posting legs (`payoneer_transaction` OTHER/ADJUSTMENT or a manual adjustment), debit Supplier Payable and credit the paying asset; declared legs place no account-type restriction, so the existing rules allow it, and `SUPPLIER_COST` is never posted again | Accepted (owner); implemented |
| A26 | 2026-11-26 | Order status changes: NEW → SUPPLIER_ORDERED → SHIPPED → IN_TRANSIT → DELIVERED, one step at a time; CANCELLED from any status before DELIVERED; DELIVERED requires a delivery date not before the order date; a repeated request is a no-op; DELIVERED and CANCELLED are terminal for status (cancelled orders cannot be edited). Confirming a purchase moves NEW to SUPPLIER_ORDERED. Payout and refund statuses cannot be set | Accepted (owner); implemented |
| A27 | 2026-11-26 | Orders are not posted to the ledger in Phase 2a (decision D8). Profit is computed from order and purchase records | Accepted (owner); implemented |
| A28 | 2026-11-26 | Corrections: reversal with a required, PII-screened reason through `reverse_journal_entry`; derived REVERSED state; replacement purchases note `Replaces purchase <id>.`, must use a blank or new reference, and supplier-reference uniqueness is not relaxed | Accepted (owner); implemented |
| A29 | 2026-11-26 | Calendar dates are stored as the instant of local midnight in `business_accounts.timezone` and displayed by converting back, so the date never shifts. Intl only, no dependency. If local midnight does not exist (DST gap) the first valid instant of the date is used. A purchase's journal `transaction_date` equals its purchase date | Accepted (owner); implemented |
| A30 | 2026-11-26 | Money (PRODUCT D3 open): scale-4 `bigint` helpers, at most 2 input decimals, line total = quantity × unit cost exactly (guaranteed by construction in the service, not by a database constraint), uneven totals split into lines, shipping, tax and discounts allocated by the user, a purchase needs a total above zero to confirm, amounts at most 999,999,999,999.99. Amounts travel as strings, never JSON numbers | Accepted (owner); implemented |
| A31 | 2026-11-26 | PII screening of free text (email and phone patterns), URL validation, strict schemas, and generic errors that name fields only. Limitations: postal addresses and names are not detectable; long digit runs in notes can be flagged by mistake, so reference numbers belong in their own fields | Accepted (owner); implemented |
| A32 | 2026-11-26 | Phase 2a scope: no order item price; business currency only (no FX); minimal product catalog (name, SKU, optional default supplier, informational default cost) with snapshots on items; marketplace validated in the application (EBAY, AMAZON, ALIEXPRESS, CUSTOM; no CHECK); no hard deletes; items lock once a purchase line references them; purchase quantity may exceed ordered quantity with a warning; no migration 0010 | Accepted (owner); implemented |
| A33 | 2026-11-26 | Data-layer rule: joins, ordering, locks and aggregates use `scope.executor` and constrain **every** table with `tenantEq()` or the session tenant, only inside `src/server/dal/**`. Static guards enforce both; mutation testing confirmed the isolation tests fail when the predicate is removed | Implemented |
| A34 | 2026-11-26 | **D5 = A: refunds are contra-revenue.** The `REFUND` account is an INCOME account named *Etsy Refunds* in the business base currency. The starter-chart addition (new businesses) and its **lazy creation inside the transaction of an existing business's first refund** (find by role, else create and audit) arrive with the customer-refund slice (Phase 2b). Nothing changes now and no migration is needed, because an INCOME account with role `REFUND` is already valid (§4.2). A used ledger account's type cannot change, so this is final once the first refund posts | Decided; implemented with Phase 2b |
| A35 | 2026-11-26 | **D9: cancelled orders.** A cancelled order counts **zero** Etsy revenue; confirmed, unreversed supplier costs keep counting and nothing is reversed automatically. New purchases (and edits that add a cancelled order's items) are rejected with 422 `ORDER_CANCELLED`; a draft that already covers a cancelled order cannot be confirmed (409); re-confirming an already confirmed purchase stays a 200 no-op. The rule lives in the service, so every caller is covered, and is **application-level** (the database has no such constraint; see Known limits). **Lock-order rule: purchase row → order rows (`ORDER BY id FOR UPDATE`, DAL `lockOrdersForUpdate`) → first write** (the first write takes the tenant lock through the posting triggers). An order is never locked after a write: the first version took order locks after the first write and deadlocked against a concurrent cancellation (1 in 60 rounds measured), which a deterministic lock test now guards | Implemented |

## 10. Open conflicts and decisions (do not resolve without the owner)

| ID | Conflict or decision | Status |
| --- | --- | --- |
| C1 | Test framework (System Architecture §2/§12 vs `node:test`) | **Resolved** 2026-11-25 by A15 |
| C2 | API style (versioned Route Handlers vs Server Actions) | **Resolved** 2026-11-25 by A16 |
| C3 | Password hashing on Workers Free | **Resolved** 2026-11-25 by A19 (hosting split); provider validation pending |
| C4 | Configuration module / dependency injection | **Resolved** 2026-11-25 by A17 |
| C5 | Rate-limit storage | **Resolved** 2026-11-25 by A18 |
| C6 | Worker bundle size limit (sources conflict) | Open; measure with `wrangler deploy --dry-run` at deployment |
| C7 | Auth Node host: commercial-use terms, reliability, cold starts, memory (≥ ~32 MiB per concurrent hash) and the trusted client-IP header | Open; deployment milestone (§2.2) |

## 11. Redirects for removed documents

These files were consolidated into the baseline documents on 2026-11-25. Older references remain in frozen SQL and in the owner reference documents.

| Old reference | Now in |
| --- | --- |
| `docs/Financial_Posting_Rules.md` (cited in migrations 0001/0005 and `src/db/sql/financial-*.sql`; System Architecture §"Database hardening implementation note"; ERD §18) | §4 |
| `docs/Shipment_Tracking.md` (System Architecture note; ERD §18) | §4.7 |
| `docs/Better_Auth_Compatibility.md`, `Better_Auth_Compatibility_Review.md` (ERD §3; System Architecture note) | §3.2, §8 |
| `tests/fixtures/better-auth-1.6.3.json` (removed 2026-11-25; its four core models are identical in the replacement) | `tests/fixtures/better-auth-1.7.25.json`, §8 |
| `docs/Cloudflare_Compatibility_Review.md` | §2, §8 |
| `docs/Authentication_and_Tenant_Security_Plan.md` | §5, §7.2 |
| `docs/Database_Schema_Audit.md`, `Financial_Hardening_Review.md`, `Integrity_Followup_Review.md` | §3, §4, §9 |
| `docs/Database_Integration_Test_Report.md`, `Database_Phase_Handoff.md`, `Application_Development_Handoff.md` | [STATUS.md](STATUS.md) |
| `tests/README.md` (ERD §18) | [DEVELOPMENT.md](DEVELOPMENT.md) §4–5 |
