# Application Development Handoff

**Date:** 2026-11-24
**From:** Database phase (closed and frozen; see [Database Integration Test Report](Database_Integration_Test_Report.md))
**To:** Application development, phases 1–5
**Scope source:** [PRD v1.2](PRD.md) · [System Architecture](System_Architecture.md) · [Financial Posting Rules](Financial_Posting_Rules.md) · [Shipment Tracking](Shipment_Tracking.md) · [Better Auth Compatibility](Better_Auth_Compatibility.md)

---

## 0. Ground rules carried over from the database phase

These apply to every phase. They are not suggestions.

1. **Migrations 0000–0008 are frozen.** Never edit them or their snapshots. `tests/baseline-migrations.json` and `npm run test:db:offline` enforce this. A schema change needs a concrete requirement or a reproduced defect, and ships as a new forward migration (`0009_*`) with tests. Never use `drizzle-kit push`.
2. **The database is the last line of defence, not the only one.** Triggers enforce balancing, immutability, caps, transitions and tenant *references*. They do **not** enforce *who may read what*. Every query needs a session-derived `account_id` predicate (§1).
3. **Zero cost.** No paid APIs, auth providers, job runners, monitoring or plan upgrades (PRD §7). If a free quota runs out, the affected feature must fail safely.
4. **Exact money.** Amounts are `numeric(19,4)` with an explicit currency. In TypeScript, carry them as strings or a decimal library, never as JS `number` arithmetic. Never add USD and PKR.
5. **Transactions and retries.** Every financial write runs in a single DB transaction. The service catches `40001` / `40P01`, retries the **whole** transaction with a bounded count (the concurrency suite shows the pattern), and reports success only **after COMMIT**, because deferred constraints fire at commit.
6. **Stable keys.** Every posting carries a deterministic `event_key` / idempotency key derived from the source event (e.g. `order:<id>:INITIAL`). Never use a random per-request value, or retries will double-post.
7. **No customer PII** (PRD §2). Filter free-text notes, locations and URLs during entry and import.
8. **Local DB tests only** via `scripts/local-db.cjs` (see [tests/README.md](../tests/README.md)). Never point tests at Neon or at `DATABASE_URL`.

### Before writing any feature code

- [ ] **Commit the database phase.** `drizzle/`, `src/db/`, `tests/`, `scripts/`, `docs/`, both drizzle configs and the package/eslint changes are currently untracked. Commit them as one baseline so the freeze is enforceable in git, not just by hash manifest.
- [ ] **Decide the runtime DB driver for Cloudflare Workers.** The app depends on `postgres` (postgres.js). Confirm it works under OpenNext + `nodejs_compat` against Neon, or choose Neon's serverless driver. This is a connection-layer decision only; the schema does not change.
- [ ] **Confirm the Workers CPU budget.** The architecture doc notes the free plan's 10 ms CPU per request. Password hashing (Better Auth's default is scrypt) and journal posting may exceed it. Measure early, in Phase 1.

---

## Phase 1: Authentication and security

**Goal:** a seller can register, log in and out, and reset a password. Every server operation knows the caller's tenant, and nothing can cross tenants.

### 1.1 Better Auth integration and the Drizzle Kit peer issue

- The existing auth tables (`user`, `session`, `account`, `verification`) match the **Better Auth 1.6.3** plugin-free schema. This is verified offline by `tests/fixtures/better-auth-1.6.3.json`.
- **Peer conflict to resolve first:** better-auth 1.6.3 declares optional `drizzle-kit >= 0.31.4`, but the repo pins `0.30.6`. Newer Better Auth (1.7.x) requires `drizzle-orm ^0.45.2`, but the repo has `0.44.7`.
- Pick **one** consistent set (auth version + drizzle-orm + drizzle-kit), checking current security releases. Upgrade explicitly; never use `--force` or `--legacy-peer-deps`.
- After any drizzle-kit or drizzle-orm upgrade, rerun the full local validation: `db:migrate` on a fresh container, `verify-local-db.cjs`, integration, concurrency, and the no-drift `generate`. A kit upgrade can change snapshot format. If it reports "drift", stop and investigate; do **not** regenerate historical migrations.
- If the auth version changes, refresh the field manifest fixture and the offline test. A missing auth column becomes a new forward migration.
- Use the configuration in [Better_Auth_Compatibility.md](Better_Auth_Compatibility.md): `provider: 'pg'`, `schema: betterAuthSchema` from `src/db/auth-schema.ts`, `usePlural: false`, default text IDs. **Do not** map the auth `account` model to `business_accounts`.
- Secrets (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) are server-only, and `.env*` stays git-ignored.

### 1.2 Session-derived tenant identification

- The auth `user` and the business tenant (`business_accounts`) are different things. They are linked by `business_accounts.owner_user_id`, which is unique (`business_accounts_owner_uq`), so V1 allows one business per user. Onboarding (§1.5) creates the link.
- Build a single server helper (e.g. `requireTenant()`) that reads the Better Auth session, resolves the caller's `business_accounts.id`, and throws 401/403 otherwise. **Tenant ID is never accepted from the client** (body, query or header).
- V1 has one owner per account and no teams (PRD §2), so do not build role-based access.

### 1.3 Authorization on every tenant-owned operation

- Every read **and** write on a tenant-owned table filters by `account_id = <session tenant>`. That covers the 34 business tables carrying a tenant `account_id`; `business_accounts` itself is scoped by `owner_user_id`. Watch the name clash: in the Better Auth `account` table, `account_id` is the external provider identity, **not** a tenant.
- Prefer a thin data-access layer that requires the tenant argument, so a query without one does not type-check.
- Call DB functions such as `reverse_journal_entry(tenant_id, …)` only with the session tenant.
- Validate all input with Zod at the server boundary, including server actions and route handlers.

### 1.4 Prevent cross-tenant reads and writes

- **Writes:** composite FKs already reject cross-tenant references, so treat a DB FK error as a 4xx, not a 500.
- **Reads:** nothing in the DB stops them today. Add an automated **two-tenant leak test** for every list and detail endpoint: tenant A must get not-found for every tenant B ID.
- Optional hardening, evaluated rather than assumed: a least-privilege runtime role (no `TRUNCATE`, no trigger DDL, no `ALTER TABLE ... DISABLE TRIGGER`) and/or PostgreSQL RLS keyed on a per-transaction `set_config`. Either one is a new forward migration with its own tests.

### 1.5 Account creation and onboarding

In **one transaction**, create:

1. `business_accounts` (one per Etsy shop) linked to the auth user.
2. `account_settings`, with defaults for the PRD's payout eligibility: delivered + 14 days, Monday payout batch, both configurable.
3. The starter chart of `financial_accounts` with **explicit `account_role`s** (§2.1).

Onboarding must be idempotent: a retried request must not create a second tenant. The unique `owner_user_id` index rejects a duplicate, so treat that conflict as "already onboarded".

**Phase 1 done when:** register, login, logout and reset work (reset depends on free email availability); `requireTenant()` is used by every server entry point; the two-tenant leak tests pass; the auth CPU cost on Workers is measured.

---

## Phase 2: Financial services

All services follow §0 rules 4–6. The source of truth for every posting is [Financial_Posting_Rules.md](Financial_Posting_Rules.md).

### 2.1 Financial account initialization and explicit roles

- Seed one account per required role and currency. The roles are `ETSY_RECEIVABLE`, `ETSY_PAYOUT_CLEARING`, `PAYONEER`, `BANK`, `TRANSFER_CLEARING` (separate USD **and** PKR accounts), `SUPPLIER_COST`, `DIRECT_EXPENSE`, `SHARED_EXPENSE`, `REVENUE` and `REFUND`.
- Role and type must agree: expense roles go on `EXPENSE` accounts and `REVENUE` on `INCOME`; `REFUND` can be either, and reporting counts it once.
- Never post to `UNCLASSIFIED` accounts. A role becomes immutable once used.

### 2.2 Orders (create and update)

- Store only the **Etsy net payable** amount (PRD §3.2): no gross value, no fees, no customer data. Orders support multiple items and quantities through `order_items`.
- Creating an order posts `order / INITIAL`: Dr ETSY_RECEIVABLE, Cr REVENUE.
- Once an order's journal is finalized, financial changes go through reversal or adjustment (§2.8). Non-financial fields (notes, status) remain editable.

### 2.3 Supplier management

- Covers suppliers (eBay, Amazon, AliExpress, custom) and products (manual entry, CSV/Excel bulk import). Products never post to the ledger.

### 2.4 Supplier purchase confirmation

- A purchase starts as `DRAFT`. Confirmation **in one transaction** sets the purchase date, makes the items match the total, and creates the unique finalized `INITIAL` posting (Dr SUPPLIER_COST). The deferred trigger rejects mismatches at COMMIT.
- Zero-cost purchases need matching items but no journal. Items and costs freeze at confirmation. A supplier refund requires a confirmed purchase.

### 2.5 Atomic journal posting

- One posting service per source type, driven by the standard-rules table.
- Ambiguous events (signed adjustments, FX gain or loss, net-statement imports) use an **explicit declaration** (`financial_posting_events` + `financial_posting_legs`). The journal must match it exactly.
- Always use the stable `event_key` as the idempotency key. A duplicate key on retry means "already done": return the existing result.

### 2.6 Expense management

- Categories are system or custom. An expense's type is `DIRECT` (order-linked) or `SHARED`. It must be `CONFIRMED` before posting.
- Shared-expense allocation (proportional / equal / manual / custom) writes `expense_allocations` and is **analytical only**. It never creates a second expense or journal.

### 2.7 Refund processing

- Covers full and partial order refunds (`refund / INITIAL`, Dr REFUND), supplier refunds and non-refundable fees.
- Post the recorded refund amount, never the original total.

### 2.8 Immutable financial corrections

- Never UPDATE or DELETE finalized journals; the DB rejects both. Correct a posting with `SELECT reverse_journal_entry(tenant, original_id, stable_key, ts)` inside the service's transaction, then post the corrected event under a **new** event key.
- Write an `audit_logs` row for every financial mutation, attributed to the session user.

**Phase 2 done when:** each service has integration tests against the local disposable DB (happy path + rejection + retry/idempotency), and an end-to-end order → supplier purchase → refund flow balances.

---

## Phase 3: Payout operations

### 3.1 Payout eligibility

- An order becomes eligible after **order-level** delivery (`orders.delivered_at`, not an individual shipment) plus the configured number of days. It is then assigned to the configured weekday batch.
- Use idempotent scheduled jobs (Workers cron + `background_jobs`) processed in small batches to stay within the CPU limit.

### 3.2 Expected Etsy payout batches

- `payout_batches` / `payout_batch_items` are **forecasts**. They never post to the ledger.
- The batch total must equal the sum of its items, and an order may appear in only one active batch (both enforced by the DB).

### 3.3 Actual Etsy payout records

- Recording an `etsy_payouts` row posts Dr ETSY_PAYOUT_CLEARING, Cr ETSY_RECEIVABLE using the **actual** amount.
- Allocating it to expected items via `etsy_payout_allocations` is capped by both the actual payout and each expected item; differences become explicit adjustments.
- Partial, missing and corrected payouts must all be representable (PRD §3.4).

### 3.4 Payoneer transaction imports

- Covers CSV/Excel import through `import_jobs` / `import_rows` with duplicate detection on provider external IDs, plus manual entry.
- Keep **principal and fee separate**. If a statement reports net amounts, declare that convention; never subtract the fee twice. Do not also enter a Payoneer fee as a manual expense.
- Filter PII from imported free text.

### 3.5 Reconciliation

- `payoneer_reconciliations` links a Payoneer **DEPOSIT** to one or more Etsy payouts.
- Confirmed totals are capped per deposit and per payout. Since 0008, only deposits carry reconciliation capacity, so negative adjustments and OTHER transactions are unaffected.
- Reconciliation never creates a second receipt.
- Surface unmatched transactions as alerts.

### 3.6 USD → PKR withdrawals

- The Payoneer `WITHDRAWAL` posts the USD principal: Dr TRANSFER_CLEARING (USD), Cr PAYONEER.
- `bank_withdrawals` posts the **actual PKR received**: Dr BANK, Cr TRANSFER_CLEARING (PKR).
- A withdrawal is a transfer, not an expense; only its fee is an expense.

### 3.7 FX and realized conversion reporting

- The actual PKR received is authoritative. No `usd × rate = pkr` equality is imposed.
- Report the realized rate per withdrawal. Book FX gains or losses only as explicit declared adjustment events.
- `exchange_rates` holds reference rates for reporting only.

**Phase 3 done when:** the PRD success path (order → delivery → expected payout → actual payout → Payoneer deposit → reconciliation → PKR withdrawal) runs end to end in an integration test, and every ledger account nets correctly.

---

## Phase 4: Shipment operations

Follow [Shipment_Tracking.md](Shipment_Tracking.md); the database already enforces it.

- **Multiple shipments per order.** Create each shipment as `PENDING`; its initial event is appended automatically.
- **Manual tracking updates.** Status changes happen **only** by appending `shipment_events`; the trigger validates the transition and projects state. Carrier, tracking reference/URL, ETA and notes stay editable, and each edit auto-appends a NOTE plus an audit entry.
- **Event history.** History is append-only and ordered by `event_sequence`. Correct a terminal status with a new shipment plus a NOTE.
- **Operational alerts** (PRD §5) go into `notifications` via idempotent jobs: overdue unshipped orders, delayed deliveries, exceptions.
- Shipment delivery **does not** set order delivery or payout eligibility. Order-level delivery confirmation is a separate, explicit action.

---

## Phase 5: Frontend

Next.js App Router, Tailwind, shadcn/ui, React Hook Form + Zod, Recharts, a responsive PWA, and light and dark themes (PRD §6, §8). **This repo runs a newer Next.js (16.4.6) than most references: read `node_modules/next/dist/docs/` before writing routes or server actions (see AGENTS.md).**

| Area | Scope |
| --- | --- |
| Dashboard | PRD §3.11 metrics. Expected, realized and cash profit shown separately. Delayed shipments and unmatched transactions. |
| Orders | Quick and detailed entry forms, items, linked purchases, expenses, refunds and shipments |
| Products & suppliers | CRUD and bulk import, supplier purchases with a confirm action |
| Expenses | Direct and shared entry, categories, analytical allocation view |
| Payouts | Expected batches, actual payouts, allocation UI |
| Payoneer | Import wizard with duplicate review, manual entry, reconciliation workspace, withdrawals |
| Shipments | Per-order shipment list, event timeline, append-event form |
| Financial reports | Order-date and cash-date perspectives, all PRD §3.12 date filters, USD and PKR never summed |
| CSV exports | Every report and list; Excel export per PRD; PDF deferred |

Server components and actions always go through the Phase 1 tenant helper and the Phase 2/3 services. The UI never writes ledger tables directly.

---

## Recommended first task

**Commit the database baseline, then resolve the Better Auth / drizzle version set and deliver Phase 1.1–1.2:** auth working locally, plus a `requireTenant()` helper with a two-tenant leak test.

Every later phase depends on a trustworthy session tenant, and the peer-dependency choice may move drizzle-orm or drizzle-kit. Settling it first means the frozen chain is re-validated once, before any feature code relies on it.
