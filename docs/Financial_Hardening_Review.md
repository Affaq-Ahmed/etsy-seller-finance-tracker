# Financial integrity and shipment hardening review

Completed 2026-11-24. Read PRD v1.2, Architecture v1.1, ERD v1.1, schema/auth mapping, maintained SQL and both existing migrations before changes. The ERD is now v1.2 with the implemented extensions. No production or local database was accessed, and no migration was applied.

## Findings and changes

Critical gaps corrected: balanced journals could carry incorrect source amounts or account types; some source types lacked explicit leg rules; draft journals could be marked REVERSED without a real reversal; ambiguous source events had no authoritative accounting instructions; manual shipment persistence/history was absent. Existing journal/source immutability, supplier confirmation, allocation/reconciliation checks and tenant serialization remain in place.

- `src/db/schema.ts`: account roles/type checks; tenant/currency reversal reference and original uniqueness; explicit posting event/leg tables; dedicated shipments/events with restrictive ownership FKs and lookup/history indexes. Four new tables bring the model to 39 tables and 83 FKs.
- `src/db/auth-schema.ts`: mapping unchanged; comment links the version-specific review.
- `src/db/sql/financial-hardening.sql`: source-specific amounts/roles, declared legs, immutable posting instructions, reversal guards and atomic reverse_journal_entry function. `financial-integrity.sql` is the cumulative maintained source, assembled from unchanged 0001 plus the new hardening source.
- `src/db/sql/shipment-integrity.sql`: append-only history, automatic initial event, event-projected state, validated transitions and metadata audit. Orders and payout eligibility are not mutated.
- `scripts/audit-schema.cjs`: checks the whole migration chain, current FK targets and ordering, source parity and SHA-256 preservation of the first two migrations.
- `tests/`: six offline checks, verified auth-field manifest, immutable baseline migration hashes, and 61 PostgreSQL integration cases. Added package scripts; no dependencies were installed or upgraded.
- Documentation: [all financial source/event rules and reversal details](Financial_Posting_Rules.md), [shipment behavior](Shipment_Tracking.md), [exact auth version findings/configuration](Better_Auth_Compatibility.md), [test instructions](../tests/README.md), updated ERD/architecture/audit/README.

The declared-leg approach for refund adjustments, Payoneer ADJUSTMENT/OTHER, generic adjustments and opening balances was explicitly approved by the user. Each declaration identifies source/event, unique key, currency, amount/basis and tenant-safe legs. Signed/compound events can measure a control account's net movement instead of blindly equating their signed source amount to total debits. Finalized journals must match those instructions exactly.

## Forward migrations

| Migration | Content |
| --- | --- |
| 0002_reversals_and_shipments.sql | Reversal reference/uniqueness and shipment/event enums/tables/FKs/indexes |
| 0003_explicit_posting_events.sql | Explicit event/leg tables, tenant/currency keys and journal declaration FK |
| 0004_financial_account_roles.sql | Role enum/column and role/type check; existing rows remain UNCLASSIFIED |
| 0005_financial_posting_hardening.sql | Function overrides and new posting/reversal/instruction guards |
| 0006_shipment_history_integrity.sql | Manual shipment/event projection, state/history/deletion guards |

Historical 0000_audited_schema.sql and 0001_financial_integrity.sql are byte-for-byte unchanged (verified against hashes captured before this task). Generated definitions/UNIQUE keys precede FKs and custom functions follow their tables. Use the complete migration chain, never push. Repeated schema generation reports no drift.

## Verification results

| Command/check | Result |
| --- | --- |
| npm run test:db:offline | 6 passed, 0 failed |
| npm run test:db:integration | 61 explicitly skipped, 0 executed: dedicated disposable local database not configured |
| npx tsc --noEmit | Passed |
| npx drizzle-kit check | Passed (metadata consistency, not database execution) |
| npx drizzle-kit generate --name=verify_no_drift | No schema changes |
| Original migration SHA-256 comparison | Both unchanged |
| git diff --check | Passed |
| npm run build | Blocked by environment: Turbopack CSS worker port binding EPERM |
| npm run build -- --webpack | Passed: compile, TypeScript and static page generation |

The PostgreSQL client is installed, but no explicit LOCAL_TEST_DATABASE_URL was configured. The integration runner never loads application .env.local or falls back to DATABASE_URL, never applies migrations, and rejects nonlocal hosts, connection override parameters and databases without the dedicated test naming/disposable marker. SQL functions/triggers have been reviewed but **not executed or certified at runtime**.

## Compatibility, limits and readiness

Better Auth 1.6.3 core fields/mapping and the adapter's ORM peer range were verified against official version-pinned artifacts; installed Drizzle ORM 0.44.7 satisfies that range. Full stack/runtime auth compatibility remains unverified: Better Auth's optional Drizzle Kit peer requires >=0.31.4, whereas this repository has 0.30.6. The latest inspected adapter 1.7.28 requires a newer ORM. Nothing was installed, enabled or silently upgraded. Choose the auth/security release and resolve its tooling peers during auth implementation.

Assign account roles explicitly before new standard postings. Review legacy finalized/REVERSED entries separately; these migrations never silently rewrite financial history. Manual duplicate source rows lacking common provider provenance still require ingestion duplicate review. Concurrent race/serialization/deadlock cases, rollback behavior, runtime privileges and RLS/SELECT authorization must be tested locally; composite FKs alone do not authorize reads. Preserve fee/principal normalization and avoid posting the same real fee or supplier cost through a separate manual expense. Filter customer PII before persisting arbitrary text/JSON/URLs. Shipment terminal state corrections use a new shipment plus explanatory history rather than rewriting events.

**Recommendation:** ready for an authorized disposable local PostgreSQL integration pass after provisioning/applying the complete chain separately. Not production-certified: execute the supplied 61 cases, add two-connection concurrency and privilege/authorization tests, review legacy data and resolve auth dependencies before deployment. No Neon or production database was accessed.
