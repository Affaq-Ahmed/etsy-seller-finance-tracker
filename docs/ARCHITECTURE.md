# Architecture

**Last updated:** 2026-11-25

This is the baseline architecture document: system design, data and financial model, security, deployment, and the dated decision log. Product rules are in [PRODUCT.md](PRODUCT.md), workflow in [DEVELOPMENT.md](DEVELOPMENT.md), and progress in [STATUS.md](STATUS.md). The source-of-truth hierarchy is defined in [PRODUCT.md](PRODUCT.md#source-of-truth-hierarchy).

The owner's reference specifications are [System Architecture v1.1](System_Architecture.md) and [Database ERD v1.2](Database_ERD.md). This document consolidates them with what has been **implemented** and **decided** since. Each section states whether it is:

- **Implemented**: enforced in migrations 0000–0008 and verified.
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
- **Implementation state:** only the database layer exists. There are no domain services, route handlers, authentication or UI beyond the Next.js scaffold.

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

### 2.2 Operating rules

- Never enable paid plans, overages or paid services (System Architecture §14).
- When a free quota runs out, report it and stop the affected writes safely.
- Provide manual export, backup and restore in user-controlled storage, and test restores before release (§15).

## 3. Data architecture (Implemented)

Defined by `src/db/schema.ts`, `src/db/auth-schema.ts`, `src/db/sql/*.sql` and `drizzle/0000–0008`.

**Runtime catalog (verified 2026-11-24 on PostgreSQL 18.6):** 39 tables, 20 enums, 83 foreign keys, 135 indexes, 19 functions, 53 triggers, 9 recorded migrations.

### 3.1 Tenancy

- **Tenant root:** `business_accounts`, one per owner, enforced by unique `business_accounts.owner_user_id` (`business_accounts_owner_uq`).
- **34 business tables carry a non-null `account_id`** with a direct, restrictive tenant-root FK. Child relationships use **composite FKs** that include `account_id`, and `currency` where money is involved, so cross-tenant or cross-currency links are rejected. Every composite target has an exact table-level UNIQUE key; these are emitted inline so that key-before-FK ordering is correct in the initial migration.
- The auth tables `user`, `session`, `account` and `verification` are not tenant-scoped. **In the auth `account` table, `account_id` is the external provider identity, not a tenant.**
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
- **Auth identity:** default text IDs. The Drizzle objects map to Better Auth models via `betterAuthSchema` (`user→users`, `session→sessions`, `account→authAccounts`, `verification→verifications`), with camelCase properties over snake_case columns and `usePlural: false`. Never map auth `account` to `business_accounts`.
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
- `REFUND` may be an INCOME contra-revenue account or an EXPENSE account. Reports count a refund once in either representation.
- Legacy accounts are `UNCLASSIFIED`. Assign roles deliberately before standard postings; nothing is guessed or backfilled. A legacy account may receive its first role without changing its type or currency.
- **A used classified role cannot change.**

### 4.3 Standard source rules

Amounts are the source event's actual amount. A side may be split among accounts of the matching role. Standard entries cannot add compensating wash lines to the same account, or override these rules with a declaration.

| Source / event | Amount; currency | Debit | Credit |
| --- | --- | --- | --- |
| order / INITIAL | `net_payable_amount`; order currency | ETSY_RECEIVABLE | REVENUE |
| supplier_purchase / INITIAL | `total_amount`; purchase currency | SUPPLIER_COST | Asset or liability (payment/payable) |
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

## 5. Application layer (Proposed; pending approval)

- **API:** System Architecture §11 specifies **versioned Route Handlers** (`/api/v1/...`) with thin handlers over domain services. The proposed auth design also uses Server Actions for forms. **See conflict C2 (§10).**
- **Data Access Layer:** `src/server/dal/**` (`server-only`) is the only code allowed to query tenant data. Every function takes a `TenantContext` first and applies `account_id = ctx.accountId` to every WHERE, join, UPDATE and DELETE.
- **Errors:** map `23503`, `23514`, `23505` and `P0001` to 4xx responses with generic messages. Never expose SQL, stack traces or secrets.
- **Financial writes:**
  - Each runs in one transaction with a deterministic event key (e.g. `order:<id>:INITIAL`).
  - A bounded whole-transaction retry applies on `40001`/`40P01`.
  - Success is acknowledged only after COMMIT.
- **Configuration:** AGENTS.md requires a configuration module with injected configuration and startup validation of required environment variables. **Not yet designed. See conflict C4.**

## 6. Imports, exports and notifications (System Architecture v1.1 §9–10)

- **Imports** (CSV/Excel for Payoneer, products, orders): upload → parse/validate → preview → duplicate detection → invalid-row report → confirm → record results. Use provider external IDs for duplicate detection. Imports must declare principal/fee and net-statement conventions and filter PII.
- **Exports:** CSV and Excel.
- **Notifications:** in-app by default. Email (e.g. Brevo Free) only after verifying its terms, and the application must keep working without it.

## 7. Security model

### 7.1 Implemented (database)

- Composite tenant/currency FKs, restrictive deletes, immutability triggers, deferred integrity checks and security-invoker functions.
- **Runtime-role requirement (not yet configured):** the application role must not own tables and must not have `TRUNCATE`, trigger-disabling or trigger-creation privileges.
- **Read authorization is not implemented anywhere yet.**

### 7.2 Proposed: authentication and tenant isolation (pending approval)

**Non-negotiable rule.** Tenant identity comes **only** from the authenticated server-side session. Tenant IDs from bodies, query strings, route params, headers, non-session cookies or client state are never trusted.

**Tenant context**
- `requireSession()` and `requireTenant()` live in `src/server/auth/` (`server-only`) and are memoized per request.
- `requireTenant()` resolves `session.user.id → business_accounts.owner_user_id` and returns `{ userId, accountId: TenantId }`.
- `TenantId` is a branded type that only `requireTenant()` creates.

| Situation | Result |
| --- | --- |
| No session, or an invalid/tampered session | Page redirects to `/sign-in`; action/route returns 401 |
| Expired or revoked session (sign-out, password reset) | Treated as unauthenticated; cookie cleared |
| Signed in but no business yet | Redirect to `/onboarding`, or 409 for API calls |
| Signed in with a business | Returns `{ userId, accountId }` |

**Onboarding.** One idempotent transaction creates:
1. `business_accounts`.
2. `account_settings` (delay 14 days, weekday Monday; both configurable).
3. A starter chart of `financial_accounts` with explicit roles: `ETSY_RECEIVABLE`, `ETSY_PAYOUT_CLEARING`, `PAYONEER`, `TRANSFER_CLEARING` (USD **and** PKR), `BANK` (PKR), `SUPPLIER_COST`, `DIRECT_EXPENSE`, `SHARED_EXPENSE`, `REVENUE` and `REFUND` (representation is PRODUCT D5).

A unique-index conflict (`23505`) means the user is already onboarded. There is no tenant switching.

**Isolation rules**
- An ID belonging to another tenant returns the same **not-found** response as a non-existent ID.
- Inserts take `account_id` from context only.
- Zod input schemas are `.strict()` and never contain `accountId`, `account_id`, `tenantId` or `ownerUserId`.
- CI guards:
  - Only the DAL and auth code import the database.
  - Every Server Action and route handler calls `requireTenant()`/`requireSession()`, or is annotated `// public:`.
  - A meta-test checks that all 34 tenant tables have a DAL module and cross-tenant tests.

**Sessions**
- Database sessions, `expiresIn` 7 days, `updateAge` 1 day (to be confirmed).
- **Cookie cache disabled**, so revocation takes effect immediately.
- Cookies are `httpOnly`, `secure` and `sameSite=lax`, with a `__Secure-` prefix in production.
- Sign-out deletes the session. Password reset or change revokes the other sessions.

**Next.js 16 specifics**
- `proxy.ts` may only do an optimistic cookie-presence redirect. It is never authorization.
- Every protected page, action and route handler calls `requireTenant()` itself. Layouts are not a security boundary.
- With Cache Components on: never read cookies or headers inside `'use cache'`, and never cache tenant data in shared entries.

**Defense in depth (later; separate approval and forward migration).** A least-privilege runtime role, then optional RLS with **transaction-local** `set_config('app.account_id', …, true)`. The transaction-local form is required under Hyperdrive.

**Required security tests**

| # | Case |
| --- | --- |
| T1 | Cross-tenant SELECT |
| T2 | Cross-tenant UPDATE |
| T3 | Cross-tenant DELETE |
| T4 | Cross-tenant INSERT via the parent of another tenant |
| T5 | Forged tenant IDs in body, query, headers or cookies |
| T6 | Second business or tenant switching |
| T7 | Every unauthenticated route and action |
| T8 | Invalid or tampered sessions |
| T9 | Expired session |
| T10 | Logout replay |
| T11 | Reset revokes sessions |
| T12 | Concurrent onboarding |
| T13 | Signed in but not onboarded |
| T14 | CSRF and Origin |
| T15 | Account enumeration |
| T16 | Coverage meta-test |
| T17 | Static guards |
| T18 | Cache safety |
| T19 | Rate limiting |

## 8. Authentication (Proposed; pending approval)

**Library versions (researched 2026-11-24)**
- **Recommended:** `better-auth` 1.7.x, exact pin, ≥ 1.7.16, and a patch that has been public at least 7 days; `@better-auth/drizzle-adapter` at the same version; `drizzle-orm` 0.45.4; `drizzle-kit` 0.31.11. `postgres` 3.4.9, Next.js 16.4.6 and React 19.3.0 stay unchanged.
- **Why not 1.6.x:** better-auth 1.6.x requires `drizzle-kit >= 0.31.4` (the repo has 0.30.6). 1.6.35 and 1.7.x require `drizzle-orm ^0.45.2` (the repo has 0.44.7). The 1.6 line is inside the ranges of published advisories with no 1.6 backport: GHSA-965c-763c-88jm (critical, magic link + OAuth, fixed 1.7.7), GHSA-9hm7-xhfp-cx58 (OAuth email verification, fixed 1.7.16) and GHSA-44jh-23m7-hpcf (Postgres rate-limit race, fixed 1.7.7).
- **Rejected:** drizzle 1.0 RC (pre-release, with breaking postgres-js codec changes).
- **Upgrade risk:** drizzle-kit 0.30 → 0.31 changes how *future* enum migrations are generated. Snapshot and journal format changes were not ruled out, so the no-drift gate in DEVELOPMENT.md §6 is mandatory.

**Configuration**
- `drizzleAdapter(db, { provider: 'pg', schema: betterAuthSchema, usePlural: false, transaction: true })`, with default text IDs and `experimental.joins: false`.
- `emailAndPassword`: enabled, minimum password length 12, maximum 128, `revokeSessionsOnPasswordReset`.
- `nextCookies()` must be the **last** plugin. Route handler: `app/api/auth/[...all]/route.ts` via `toNextJsHandler(auth)`.
- **No** magic-link, OAuth, SSO, admin or organization plugins in V1.
- Direct `auth.api` calls bypass Better Auth's CSRF and `trustedOrigins` checks, so callers must assert the Origin themselves and allowlist any redirect targets.
- Return generic errors so account existence cannot be inferred.
- **Rate limiting:** memory storage is per-isolate and ineffective on Workers. Choose database storage (forward migration, ≥ 1.7.7) or a Cloudflare free rule.

**Schema and known issues**
- The auth-table schema matches the Better Auth **1.6.3** plugin-free manifest (`tests/fixtures/better-auth-1.6.3.json`). A 1.7.x manifest must be extracted and compared, and any missing column becomes a new forward migration (`0009+`).
- Better Auth issue #12837 holds a transaction open during password hashing, which matters for Hyperdrive's connection budget.

**Password hashing (Open, decision gate)**
- Better Auth's default is scrypt. The reported parameters are N=16384, r=16, p=1 with a 64-byte key; this is unverified from source. That is **about 32 MiB of memory per hash**.
- The pure-JS implementation was reported at seconds of CPU. Native scrypt at secure parameters is very likely above 10 ms. OWASP-strength PBKDF2 or Argon2 are also over budget.
- **Lowering work factors to fit is not acceptable.**
- Options, which need an owner decision (PRODUCT D1):
  1. Measure on a free Worker first.
  2. Passkeys.
  3. Email OTP or magic link.
  4. Auth on separate free compute.
  5. A different free host.

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
| A12 | 2026-11-24 | **Migrations 0000–0008 frozen**: forward-only, SHA-256 manifest, never `drizzle-kit push` | Accepted |
| A13 | 2026-11-24 | `drizzle.config.ts` loads environment via `@next/env` (Next.js precedence, `.env.local`); generation works offline without a URL | Implemented |
| A14 | 2026-11-24 | Database tests run only against a disposable, loopback-only Docker database through `scripts/local-db.cjs`; never `DATABASE_URL`, Neon or production | Implemented |
| P1 | 2026-11-24 | Better Auth 1.7.x + drizzle-orm 0.45.4 + drizzle-kit 0.31.11 (§8) | Proposed |
| P2 | 2026-11-24 | postgres.js via Hyperdrive, caching disabled, direct Neon endpoint (§2.1) | Proposed |
| P3 | 2026-11-24 | Session-derived tenant context, DAL, onboarding, session policy, test matrix (§7.2) | Proposed |

## 10. Open conflicts and decisions (do not resolve without the owner)

| ID | Conflict or decision | Documents |
| --- | --- | --- |
| C1 | **Test framework:** System Architecture §2/§12 specifies Vitest + Playwright, but the existing database suites use Node's built-in `node:test`. Neither Vitest nor Playwright is installed | System Architecture v1.1; `package.json` |
| C2 | **API style:** System Architecture §11 specifies versioned Route Handlers (`/api/v1/...`); the proposed auth design uses Server Actions for forms | System Architecture v1.1; §5, §7.2 |
| C3 | **Password hashing on Workers Free** (§8) | PRD §3.1; System Architecture §3.1, §8 |
| C4 | **Configuration module / dependency injection** required by AGENTS.md is not yet designed | AGENTS.md; §5 |
| C5 | Rate-limit storage (database table or Cloudflare rule) | System Architecture §8 |
| C6 | Worker bundle size limit (sources conflict) | §2 |

## 11. Redirects for removed documents

These files were consolidated into the baseline documents on 2026-11-25. Older references remain in frozen SQL and in the owner reference documents.

| Old reference | Now in |
| --- | --- |
| `docs/Financial_Posting_Rules.md` (cited in migrations 0001/0005 and `src/db/sql/financial-*.sql`; System Architecture §"Database hardening implementation note"; ERD §18) | §4 |
| `docs/Shipment_Tracking.md` (System Architecture note; ERD §18) | §4.7 |
| `docs/Better_Auth_Compatibility.md`, `Better_Auth_Compatibility_Review.md` (ERD §3; System Architecture note) | §3.2, §8 |
| `docs/Cloudflare_Compatibility_Review.md` | §2, §8 |
| `docs/Authentication_and_Tenant_Security_Plan.md` | §5, §7.2 |
| `docs/Database_Schema_Audit.md`, `Financial_Hardening_Review.md`, `Integrity_Followup_Review.md` | §3, §4, §9 |
| `docs/Database_Integration_Test_Report.md`, `Database_Phase_Handoff.md`, `Application_Development_Handoff.md` | [STATUS.md](STATUS.md) |
| `tests/README.md` (ERD §18) | [DEVELOPMENT.md](DEVELOPMENT.md) §4–5 |
