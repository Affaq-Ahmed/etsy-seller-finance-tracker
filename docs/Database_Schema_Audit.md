# Database schema audit

Reviewed 2026-11-24, before migration generation. Inputs: PRD v1.2, System Architecture v1.1, Database ERD v1.1, schema.ts, drizzle.config.ts, package.json, installed Next.js environment-variable guide. No database connection or migration execution is authorized or performed.

## Critical findings (original schema)

1. Invalid composite FK targets: `order_items(account_id,id)`, `expenses(account_id,id)`, and `refunds(account_id,id)` lack matching unique keys. Generation alone may not detect this; PostgreSQL would reject these FKs.
2. Finalized ledger entries/lines can be updated, deleted, or cascade-deleted. No balance validation; entries lack a currency; zero-value lines are allowed; account and line currencies can differ.
3. Confirmed supplier purchases/items remain editable. Confirmation metadata is only required for CONFIRMED, so refund statuses can bypass it. A caller can recognize a draft cost through the generic ledger source. Arbitrary idempotency keys permit duplicate postings of the same event.
4. Allocations/reconciliations permit duplicate pairs, nonpositive amounts, mismatched currencies and over-allocation. Reconciliations can reference withdrawals. Withdrawal records can reference deposits or non-USD transactions.
5. Nullable account IDs in exchange rates and jobs conflict with the strict tenant requirement. NULL tenant job keys also bypass ordinary uniqueness. ERD permits global rates/system jobs, but the user's explicit requirement takes precedence: keep these tables tenant-owned; global scheduling may dispatch tenant jobs without storing tenantless rows.

## Important findings

1. `orders.account_id` **already has** a direct non-null FK to business_accounts. Preserve it. Child tenant IDs generally derive ownership through mandatory composite FKs, but explicit tenant-root FKs improve consistency. Optional reference IDs may remain NULL; tenant IDs may not.
2. Monetary NUMERIC(19,4) is appropriate and stays exact (Drizzle strings). Many amounts lack sign checks; currency VARCHARs accept arbitrary strings; fee amount/currency pairs can be incomplete; FX permits identical currency pairs.
3. Expense DIRECT/SHARED classification does not constrain order association. Analytical allocation lacks a repeatable unique key, date validation and shared-expense restriction. Never post allocations as new expenses.
4. No stable source-event uniqueness independent of journal idempotency key; external Etsy payout references and supplier references lack duplicate protection. Manual/import duplicate review remains necessary when no provider ID exists.
5. Financial account/business deletion cascades risk erasing financial history. Replace business cascades with restrictive deletion and protect posted records at the database layer.
6. Better Auth is not installed or pinned. All four baseline tables and expected camelCase properties exist; text IDs are appropriate. Missing provider/account uniqueness; adapter must map user/session/account/verification to users/sessions/authAccounts/verifications. Exact version/plugin compatibility cannot be certified before choosing that version. Do not install or upgrade it during this audit.
7. dotenv/config reads .env by default, not Next.js .env.local precedence. Use Next's installed @next/env loader and allow generation without credentials; database operations still require real credentials through Drizzle Kit.
8. Expected payout batching lacks retry uniqueness and protection against an order appearing in multiple active batches. Cancellation/rebatching must remain possible.

## Improvements and boundaries

- Index FK lookup paths, constrain counters/dates and require nonblank financial keys.
- Audit actor must be the tenant owner in V1, rather than an arbitrary other user's identity.
- No dedicated customer PII columns exist. Notes, JSON import payloads, URLs, audit payloads and descriptions can still contain PII; ingestion must allowlist fields and redact before persistence. Seller authentication email/IP are identity data, not customer data.
- Composite FKs prevent cross-tenant relationships; they do not authorize SELECT/UPDATE/DELETE. Session-derived tenant predicates remain required; RLS and restricted runtime privileges need database testing later.
- Allocation method/reporting-period variants are alternative analytical scenarios, not additive expenses. Reporting must choose one scenario and deduct the actual shared expense once.
- Settings validation, configurable eligibility schedules, FX rounding, actual-vs-expected profit and transaction orchestration need domain services. Do not hard-code a Monday or 14-day CHECK.

## Implementation and validation

Implemented in `src/db/schema.ts`, `src/db/auth-schema.ts`, `drizzle.config.ts`, and `src/db/sql/financial-integrity.sql`.

- All 30 tenant-owned tables now have a direct non-null tenant-root FK with restrictive deletion. Auth identity tables and the tenant root are the five exceptions. Optional parent references remain nullable and retain tenant-scoped FKs.
- Added missing tenant/id UNIQUE constraints for order_items, expenses, refunds. All composite FK targets are now table-level UNIQUE constraints. **SQL inspection caught an additional critical issue:** installed Kit 0.30.6 emits unique indexes after ALTER TABLE foreign keys; referenced unique indexes therefore do not exist when those FKs execute in an initial migration. Inline UNIQUE constraints fix this ordering issue. No dependency upgrade was needed.
- Added tenant/id/currency UNIQUE constraints and matching currency FKs for purchase costs, expected/actual payout allocations, reconciliations, refunds, expense allocations and journal lines. Cross-currency order cost attribution remains possible; reporting must convert explicitly.
- Kept exact NUMERIC(19,4) money and NUMERIC(19,8) FX. Added finite values, sign checks, uppercase three-letter currency format, complete optional fee pairs, valid date ranges and counters. Currency format is not an ISO currency catalog; broader supplier currencies remain possible. USD and PKR ledger entries cannot mix. Fixed withdrawal principal/receipt columns retain their explicit USD/PKR meaning.
- Added one-shop-per-owner uniqueness, auth provider/account uniqueness, external payout/supplier reference uniqueness, active schedule uniqueness, allocation/reconciliation pair uniqueness, analytical scenario/order uniqueness, source-event uniqueness and nonblank idempotency keys. Added refund and ledger-account lookup indexes.
- Retained the existing direct orders account FK through the shared tenantId helper. Scoped audit actor to the account owner for V1.
- Added journal currency and sourceEvent. Nonzero one-sided lines and same-currency financial accounts are mandatory. Deferred trigger validates at least two balanced lines at finalization. Entries and lines cannot mutate after finalization, including REVERSED entries. Reversals/corrections use new entries; status cannot be flipped on a finalized record.
- Deferred supplier confirmation requires item totals to match and a unique finalized INITIAL cost posting in the same transaction. Items and financial purchase facts freeze after confirmation; only forward refund status changes are permitted. A zero-cost confirmed purchase requires matching items but no zero-value journal. Supplier refunds require a previously confirmed purchase.
- Deferred guards enforce payout/item caps, expected batch totals, confirmed reconciliation caps, deposit-only reconciliation, matching USD withdrawal principal/type, shared confirmed expense allocations, per-scenario allocation caps, and no duplicate order in active batches. SUGGESTED/REVERSED reconciliations do not consume confirmed balance. Canceled batches permit rebatching.
- Aggregate writes serialize on a tenant row before checking totals. A no-op tenant row UPDATE creates a row version so repeatable-read transactions fail safely rather than validate stale sums. Posting services must retry deadlocks/serialization failures. These checks deliberately prioritize integrity over high write concurrency.
- Finalized journal source lookup verifies tenant and currency. Posted source financial facts are immutable; order lifecycle fields remain editable. Analytical allocations and product default costs cannot be used as ledger sources.
- `@next/env` 16.4.6 is now a direct dependency at the version already installed with Next; other dependencies were not upgraded. The config loads .env.local and environment-specific files with Next precedence. Missing DATABASE_URL is permitted for offline generation; no fake connection URL is supplied.

Generated and inspected, without application:

1. `drizzle/0000_audited_schema.sql`: 35 tables, enums, constraints and indexes.
2. `drizzle/0001_financial_integrity.sql`: custom PostgreSQL functions/triggers, copied from the maintained SQL source.
3. Drizzle snapshots/journal for both migrations. Do not use drizzle-kit push as a substitute: it does not install these custom guards.

Validation:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node scripts/audit-schema.cjs` | Passed: 35 tables, 72 FK targets, direct tenant roots, identifier lengths, key creation order, custom SQL parity |
| `node scripts/audit-env.cjs` | Passed: missing URL, synthetic .env.local precedence, shell precedence; no credentials printed and no connection |
| `npx drizzle-kit generate` | Generated initial/custom migrations; repeated generation after the final key-order correction confirmed no drift |
| `npx drizzle-kit check` | Passed; this checks migration metadata, not PostgreSQL execution |
| `npm run build` | Attempted; Turbopack CSS worker cannot bind a port in this environment (EPERM), including permitted retry |
| `npm run build -- --webpack` | Passed with permitted network access for existing Google Fonts; compiled, typechecked and generated static pages |

## Posting contract and remaining limitations

- Canonical source types: `order`, `supplier_purchase`, `supplier_refund`, `expense`, `refund`, `refund_adjustment`, `etsy_payout`, `payoneer_transaction`, `bank_withdrawal`, `adjustment`, `opening_balance`. Existing schema had no posting services, so this makes the previously undefined contract explicit. Extend the vocabulary through a reviewed migration.
- Business sources have one INITIAL entry in their source currency. Payoneer may additionally have one FEE event matching fee_amount/fee_currency. For a bank withdrawal, Payoneer INITIAL owns the USD transfer leg and FEE owns its fee; bank_withdrawal INITIAL owns the actual PKR receipt. Use separate currency-specific clearing accounts, and adjustment entries for FX gains/losses. Never post the same principal or fee again as an expense. Bank fee fields are descriptive copies; services must keep them consistent with the canonical Payoneer fee. A standalone Payoneer FEE transaction uses INITIAL; do not also record that fee as a separate expense or embedded FEE event.
- `adjustment` sources reference a prior finalized same-currency entry; sourceEvent must be a stable correction-event identifier. Reusing an event prevents duplicates, but inventing a different correction identity is a new adjustment. Application orchestration and duplicate review must distinguish a new event from a retry.
- No database was connected, started or queried, and no migration was applied. PostgreSQL syntax/runtime behavior, triggers, concurrent races, privileges, rollback, constraint failures and successful end-to-end posting still require disposable-database integration tests when authorized. Offline tests cannot certify those behaviors.
- Financial account routing and every report's profit/cash semantics still need domain services; source constraints cannot infer whether a manually entered expense duplicates a supplier purchase or fee. Automatic audit-log creation and actor attribution are also service responsibilities. Do not mark these V1 services as implemented by this schema audit.
- Aggregate validators currently scan the affected tenant's related financial tables. This is practical for initial volume but needs realistic volume/concurrency measurement. Retry whole transactions after deadlocks or serialization failures; runtime roles must not own tables or have TRUNCATE/trigger-disabling privileges.
- Cross-row references from journal source IDs are validated on finalization; draft polymorphic source references, notification references and audit entity references require service validation. Composite FKs still enforce all typed relationships. Tenant predicates/RLS and authorization need a separate runtime audit.
- Currency conversion precision/rounding and whether bank fees are deducted before conversion remain domain rules. No speculative equality between usd_amount * rate and net PKR receipt was introduced.
- Expense allocations for different periods/methods are alternative analytical scenarios. Reports must select a scenario and never sum alternatives or post allocations. Allocation totals within a scenario may be partial; expected payout adjustments must update the expected item/total explicitly before exceeding an old cap.
- No customer-specific PII fields were added. Arbitrary text/JSON/URLs are not a database-enforceable no-PII guarantee: ingestion must allowlist/redact customer data before writing raw_data, normalized_data, notes or audit payloads.
- Better Auth is still uninstalled/unpinned. `betterAuthSchema` supplies explicit adapter model mapping; exact version/plugin schema generation and auth integration tests remain required before auth use. Timestamps use defaults; ordinary updated_at maintenance is a service/ORM responsibility.
- This audit preserves the provided 35-table domain model. The PRD's full carrier/tracking/shipment lifecycle is not represented by a dedicated shipments table in the original ERD/schema (only delivery timestamps exist). Shipment persistence and other unimplemented V1 services remain feature work; this audit does not reduce that scope.
- Global exchange-rate/system-job rows from the older ERD are intentionally superseded by strict tenant ownership, per the explicit audit requirement. Global scheduling should dispatch per-tenant jobs; a future shared reference-data model must be separate from business records.

## Better Auth sources

Baseline tables compared with https://better-auth.com/docs/concepts/database and adapter mapping with https://better-auth.com/docs/adapters/drizzle (read 2026-11-24). This is a baseline review, not a version-specific certification.


## Composite foreign-key inventory

Every relationship below has an exact matching table-level UNIQUE target, checked offline; simple ID FKs target primary keys.

| Source | Local columns | Referenced table/columns |
| --- | --- | --- |
| audit_logs | account_id, user_id | business_accounts (id, owner_user_id) |
| bank_withdrawals | account_id, payoneer_transaction_id | payoneer_transactions (account_id, id) |
| etsy_payout_allocations | account_id, payout_batch_item_id, currency | payout_batch_items (account_id, id, currency) |
| etsy_payout_allocations | account_id, etsy_payout_id, currency | etsy_payouts (account_id, id, currency) |
| etsy_payout_allocations | account_id, etsy_payout_id | etsy_payouts (account_id, id) |
| etsy_payout_allocations | account_id, payout_batch_item_id | payout_batch_items (account_id, id) |
| expense_allocations | account_id, expense_id, currency | expenses (account_id, id, currency) |
| expense_allocations | account_id, expense_id | expenses (account_id, id) |
| expense_allocations | account_id, order_id | orders (account_id, id) |
| expenses | account_id, category_id | expense_categories (account_id, id) |
| expenses | account_id, order_id | orders (account_id, id) |
| import_rows | account_id, import_job_id | import_jobs (account_id, id) |
| journal_lines | account_id, financial_account_id, currency | financial_accounts (account_id, id, currency) |
| journal_lines | account_id, journal_entry_id, currency | journal_entries (account_id, id, currency) |
| journal_lines | account_id, journal_entry_id | journal_entries (account_id, id) |
| journal_lines | account_id, financial_account_id | financial_accounts (account_id, id) |
| order_items | account_id, order_id | orders (account_id, id) |
| order_items | account_id, product_id | products (account_id, id) |
| payoneer_reconciliations | account_id, etsy_payout_id, currency | etsy_payouts (account_id, id, currency) |
| payoneer_reconciliations | account_id, payoneer_transaction_id, currency | payoneer_transactions (account_id, id, currency) |
| payoneer_reconciliations | account_id, payoneer_transaction_id | payoneer_transactions (account_id, id) |
| payoneer_reconciliations | account_id, etsy_payout_id | etsy_payouts (account_id, id) |
| payoneer_transactions | account_id, import_job_id | import_jobs (account_id, id) |
| payout_batch_items | account_id, order_id, currency | orders (account_id, id, currency) |
| payout_batch_items | account_id, payout_batch_id, currency | payout_batches (account_id, id, currency) |
| payout_batch_items | account_id, payout_batch_id | payout_batches (account_id, id) |
| payout_batch_items | account_id, order_id | orders (account_id, id) |
| payout_eligibility | account_id, order_id | orders (account_id, id) |
| products | account_id, default_supplier_id | suppliers (account_id, id) |
| refund_adjustments | account_id, refund_id, currency | refunds (account_id, id, currency) |
| refund_adjustments | account_id, refund_id | refunds (account_id, id) |
| refunds | account_id, order_id, currency | orders (account_id, id, currency) |
| refunds | account_id, order_id | orders (account_id, id) |
| supplier_purchase_items | account_id, supplier_purchase_id, currency | supplier_purchases (account_id, id, currency) |
| supplier_purchase_items | account_id, supplier_purchase_id | supplier_purchases (account_id, id) |
| supplier_purchase_items | account_id, order_item_id | order_items (account_id, id) |
| supplier_purchases | account_id, supplier_id | suppliers (account_id, id) |
| supplier_refunds | account_id, supplier_purchase_id, currency | supplier_purchases (account_id, id, currency) |
| supplier_refunds | account_id, supplier_purchase_id | supplier_purchases (account_id, id) |


## Subsequent hardening (2026-11-24)

The findings/counts above describe the original 35-table audit baseline. Forward migrations 0002–0006 extend it to 39 tables and 83 FKs without editing 0000/0001. The current posting/reversal rules and remaining limitations are in [Financial Posting Rules](Financial_Posting_Rules.md); dedicated manual shipping now exists as described in [Shipment Tracking](Shipment_Tracking.md). [Better Auth Compatibility](Better_Auth_Compatibility.md) supersedes the earlier unpinned baseline review with a version-specific 1.6.3 field/ORM-peer review and explicit Kit mismatch. Prior SQL runtime limitations still apply until the local integration suite is executed.
