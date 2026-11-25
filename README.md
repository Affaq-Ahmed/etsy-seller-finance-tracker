# Etsy Seller Finance Tracker

Next.js 16 application with a PostgreSQL/Drizzle financial schema. See the [PRD](docs/PRD.md), [architecture](docs/System_Architecture.md), [ERD](docs/Database_ERD.md), and [schema audit](docs/Database_Schema_Audit.md).

The audit documents corrections, posting conventions, verification results, and remaining V1 work. The ERD is the original logical design; explicit changes made by the audit take precedence where documented.

## Database files

- `src/db/schema.ts`: tables, enums, tenant/currency foreign keys, constraints and inferred types.
- `src/db/auth-schema.ts`: explicit Better Auth adapter mapping. Pin and compare the exact auth version before enabling authentication.
- `src/db/sql/financial-integrity.sql`: cumulative ledger/confirmation/allocation guards (0001 + 0005 + financial follow-up).
- `src/db/sql/financial-hardening.sql`: forward financial override source, matching 0005.
- `src/db/sql/shipment-integrity.sql`: cumulative shipment history guards (0006 + shipment follow-up).
- `drizzle/0000_audited_schema.sql`: generated initial schema.
- `drizzle/0001_financial_integrity.sql`: custom guard migration, required alongside the initial schema.
- `drizzle/0002*`–`0007*`: forward reversal/shipment schema, explicit declarations, account roles and custom guards.
- `drizzle.config.ts`: Next environment loading, including `.env.local`; offline generation does not require DATABASE_URL.

## Offline checks

```bash
npx tsc --noEmit
node scripts/audit-schema.cjs
node scripts/audit-env.cjs
npx drizzle-kit check
npm run build
```

`npm run build -- --webpack` is available as a command-line fallback when the environment blocks Turbopack worker ports. The existing layout fetches Google Fonts at build time and requires network access.

`npm run db:generate` generates SQL without applying it. Inspect the SQL and snapshots. Never replace the custom migration with `drizzle-kit push`: generated schema alone does not enforce the trigger-based invariants. Keep the SQL source and its custom migration synchronized before either is applied; after application, changes require a new migration.

Database credentials belong in an ignored root `.env.local` or the shell, never in client variables. `db:migrate` and `db:studio` require a database connection and are intentionally excluded from this audit's validation. No database migration has been applied. Before applying either migration, test the entire chain, success/failure posting cases, concurrency, rollback and runtime role privileges against a disposable PostgreSQL instance with explicit authorization.


See [Financial Posting Rules](docs/Financial_Posting_Rules.md), [Shipment Tracking](docs/Shipment_Tracking.md), [Better Auth Compatibility](docs/Better_Auth_Compatibility.md) and [test instructions](tests/README.md) for the current contracts. Run `npm run test:db:offline` for structural checks and `npm run test:db:integration` for the dedicated local suite (explicitly skips without its test-only connection configuration). Auth is not implemented; no dependencies were upgraded during hardening.

The [hardening review and validation results](docs/Financial_Hardening_Review.md) summarizes all deliverables, forward migrations and remaining integration work.

Migration 0007 and its [follow-up review](docs/Integrity_Followup_Review.md) address shipment event chronology, reversed-original adjustment rejection and complete notes audit snapshots.


Database integrity validation is complete for V1 on disposable local PostgreSQL 18.6: 71 integration cases, 12 concurrency/transaction cases and 8 offline checks passed. Read the [integration report](docs/Database_Integration_Test_Report.md) and [application-phase handoff](docs/Database_Phase_Handoff.md). Migrations 0000–0007 are unchanged; corrective 0008 is part of the validated, frozen chain. No production or Neon database was accessed.
