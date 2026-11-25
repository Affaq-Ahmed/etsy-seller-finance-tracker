# Database phase handoff

**2026-11-24 — READY FOR APPLICATION DEVELOPMENT. Database integrity work is complete for V1. Migrations 0000–0008 are frozen.**

> **Phase closed.** All results below were independently re-executed on a fresh disposable PostgreSQL 18.6 container, and the 0008 defect was reproduced against a 0000–0007-only database. Verified and reported-only results are distinguished in the [Database Integration Test Report](Database_Integration_Test_Report.md). The phased plan for the next work is in [Application Development Handoff](Application_Development_Handoff.md).

Read [Database Integration Test Report](Database_Integration_Test_Report.md) for executed evidence and [Financial Posting Rules](Financial_Posting_Rules.md) for accounting contracts. Local PostgreSQL 18.6 ran 71 sequential integration cases and 12 concurrency/rollback/retry cases with no failures or skips. Eight offline checks, TypeScript, Drizzle metadata/no-drift, webpack build and lint pass. The disposable container and temporary credentials were removed; no production/Neon database was accessed.

Migrations 0000–0007 are unchanged and frozen. New 0008 fixes the reproduced negative non-deposit reconciliation-cap defect; it is part of the validated frozen chain. Always apply the entire migration chain with Drizzle migrate, including custom SQL; never push. New schema changes require a concrete requirement or reproduced defect.

Next development work, not implemented by this task:

1. Choose/pin Better Auth and resolve its documented Drizzle Kit peer requirements; use the existing explicit auth model mapping.
2. Implement session-derived tenant authorization for every read/write. Composite FKs are not SELECT authorization; validate runtime grants/RLS separately.
3. Implement financial services with atomic transactions, stable source-event/idempotency keys, explicit financial account roles, exact decimal arithmetic and bounded whole-transaction retries for 40001/40P01. Do not acknowledge success until deferred checks commit.
4. Implement supplier confirmation plus matching items/initial posting together. Use explicit declarations for ambiguous events; use reverse_journal_entry for exact immutable reversals. Keep USD/PKR legs and fees/principal separate.
5. Build order management, Etsy payout allocation, Payoneer reconciliation, manual shipment/event management and dashboard/reporting against the established contracts. Shipment delivery remains separate from order-level payout eligibility; analytical allocations never create expenses.

Use the safe local reproduction commands in [tests/README.md](../tests/README.md). Do not repurpose application DATABASE_URL or application .env.local for integration testing. Imports must identify real provider events and filter customer PII; duplicate manual source records without shared provenance cannot be deduplicated by journal uniqueness alone. Repeat validation on the selected production PostgreSQL version before deployment.
