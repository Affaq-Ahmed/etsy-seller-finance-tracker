# Status

**Last updated:** 2026-11-25

This is the baseline progress document: current milestone, completed work, verification results, blockers and next tasks. It is the place for durable progress records; do not create separate handoff or report files (AGENTS.md).

## Current milestone

| Milestone | State |
| --- | --- |
| **M1: Database foundation (V1)** | **Complete.** Migrations 0000–0008 frozen and integrity verified locally. Ready for application development. **Not production-certified.** |
| M2: Authentication and tenant security | **Not started; blocked** on the decisions below |

The checkpoint is commit `4625202` (`chore(db): establish verified database baseline`), tagged **`db-baseline-v1`**. The tag exists locally only and has not been pushed.

## Completed work

| Date | Work | Result |
| --- | --- | --- |
| 2026-11-24 | Schema audit of the owner's PRD v1.2, System Architecture v1.1 and ERD v1.1 | Fixed invalid composite FK targets, mutable finalized ledger, editable confirmed purchases, missing caps and uniqueness, nullable tenant IDs and cascades. Initial model of 35 tables (migrations 0000–0001) |
| 2026-11-24 | Financial hardening | Account roles, standard source leg rules, declared instructions, atomic reversals, manual shipments and events. 39 tables, 83 FKs (0002–0006); ERD updated to v1.2 |
| 2026-11-24 | Integrity follow-up | Shipment creation-date floor; adjustments rejected against reversed originals; complete notes audit (0007) |
| 2026-11-24 | First local PostgreSQL validation | Found one trigger defect: negative non-deposit Payoneer transactions hit the reconciliation cap. Fixed forward in 0008; regression added |
| 2026-11-24 | Independent re-verification on a fresh disposable database | All results below reproduced; 0008 proven to be the fix |
| 2026-11-24 | Research: auth versions, Cloudflare runtime, auth design | Recorded as **proposed** in ARCHITECTURE.md §2, §7.2, §8 |
| 2026-11-25 | Baseline committed and pushed to `main` (`4625202`, `9373cd2`); AGENTS.md restructured (`b7dcf81`) | Pushed history scanned: no secrets |
| 2026-11-25 | Documentation consolidated into PRODUCT, ARCHITECTURE, DEVELOPMENT and STATUS; owner reference docs kept unchanged | This document set |

## Verification results (2026-11-24, PostgreSQL 18.6, disposable loopback Docker container)

Every result here was **re-executed independently** on a fresh database.

| Check | Result |
| --- | --- |
| Migrations 0000–0008 on a fresh database | All applied; replay is a no-op; 9 recorded; hashes and order match Drizzle's files |
| Frozen manifest (`tests/baseline-migrations.json`) | 18/18 SHA-256 match (SQL and snapshots 0000–0008), re-checked 2026-11-25 on the committed blobs |
| Runtime catalog (`verify-local-db.cjs` + direct `psql`) | 39 tables, 20 enums, 83 FKs, 135 indexes, 19 functions, 53 triggers, 9 migrations |
| `npm run test:db:integration` | **71/71 passed**, 0 skipped |
| `npm run test:db:concurrency` | **12/12 passed**, with real lock waits and real `40001`/`40P01` |
| `npm run test:db:offline` | **8/8 passed** (re-run 2026-11-25) |
| 0008 proof | On a 0000–0007-only database both negative-amount cases fail with `P0001 Confirmed reconciliation exceeds deposit or payout`; with 0008 both pass |
| `drizzle-kit check` / `generate --name=verify_no_drift` | Passed / "No schema changes" |
| `npx tsc --noEmit`, `npm run lint`, `npm run build -- --webpack` | Exit 0 |

**Reported by the first validation pass but not reproduced:** the pre-fix full run (70 cases: 69 passed, 1 failed) and the earlier lint error counts.

**Not verified at all:** production PostgreSQL, the Neon runtime role and grants, RLS, Hyperdrive, Workers deployment, throughput and volume.

## Blockers and open decisions

| # | Item | Where |
| --- | --- | --- |
| B1 | **Password hashing on Workers Free:** secure hashing very likely exceeds the 10 ms CPU limit. Choose an approach (measure, passkeys, email OTP, separate compute, other host) | ARCHITECTURE.md §8, C3; PRODUCT.md D1 |
| B2 | **Approval** of the proposed dependency set (P1), database connectivity (P2) and auth/tenant design (P3) | ARCHITECTURE.md §9 |
| B3 | Test framework (C1) and API style (C2) conflicts with System Architecture v1.1 | ARCHITECTURE.md §10 |
| B4 | Configuration module and dependency injection design (C4) | ARCHITECTURE.md §10 |
| B5 | Rate-limit storage (C5); free email provider (D2) | ARCHITECTURE.md §10; PRODUCT.md §9 |
| B6 | Currency rounding rules (D3) before any FX or reporting logic | PRODUCT.md §9 |

## Next tasks

1. **Owner decisions B1–B4.**
2. **Install the approved dependency set** and pass every check in DEVELOPMENT.md §7, especially the drizzle-kit no-drift gate. Any auth-table gap ships as forward migration `0009`.
3. **Phase 1: authentication and tenant security** (ARCHITECTURE.md §7.2):
   - Better Auth integration; sign-up, sign-in and sign-out.
   - `requireSession()`/`requireTenant()`; idempotent onboarding with the explicit-role starter chart.
   - DAL skeleton, static guards and tests T1–T19.
   - Measure auth CPU on Workers.
4. **Phase 2: financial services.**
   - Account initialization; orders; suppliers and products; supplier purchase confirmation.
   - Atomic journal posting with stable event keys and whole-transaction retries.
   - Expenses; refunds; immutable corrections and reversals.
5. **Phase 3: payout operations.**
   - Eligibility jobs (configurable delay and weekday); expected batches; actual payouts and allocations.
   - Payoneer import with duplicate review and principal/fee conventions; reconciliation.
   - USD → PKR withdrawals; realized FX reporting.
   - Done when the full PRD §10 lifecycle passes end to end with balanced ledgers.
6. **Phase 4: shipment operations.** Multiple manual shipments, event timeline and metadata edits, operational alerts via idempotent jobs. Shipment delivery never sets order delivery.
7. **Phase 5: frontend.** Dashboard, orders, products and suppliers, expenses, payouts, Payoneer, shipments, reports (order-date and cash-date), CSV/Excel export. Read the Next.js 16 docs in `node_modules/next/dist/docs/` first.
8. **Before production:**
   - Re-run the full chain and suites on the production PostgreSQL major version.
   - Validate the runtime role and grants (and RLS if adopted), Hyperdrive transactions with caching disabled, Worker bundle size, backup and restore.
