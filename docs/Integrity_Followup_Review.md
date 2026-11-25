# Integrity follow-up review

Completed 2026-11-24. No database was accessed, and no migration was applied. This task changes only the three requested SQL behaviors, their tests/source parity checks, and documentation. No dependency or schema.ts changes were needed.

## Corrections

1. Shipment status events now reject event_date < shipment.created_at before transition validation. The NOTE early return remains ahead of this floor, so valid historical NOTE events still persist without changing status. Status events exactly at created_at remain valid. Initial PENDING history and the existing last-status-date/transition checks remain intact.
2. Generic adjustment finalization checks for a same-tenant FINALIZED journal whose reversal_of_entry_id references the source original. Such adjustments are rejected even though the original retains FINALIZED status. There is no business-rule exception allowing adjustments against reversed originals. A draft reversal alone does not block an adjustment. Deferred checks see finalized reversals created in the same transaction, including after an adjustment was queued; the existing tenant locks are retained. Prior finalized history is not rewritten.
3. Shipment metadata auditing includes notes in both before_data and after_data, including JSON null values for adding/clearing notes. Other metadata changes also snapshot unchanged notes. Notes-only changes still create a NOTE history event. Ingestion must filter customer PII from notes before storage; the audit now faithfully copies those stored notes as requested.

## Files and migration

- `drizzle/0007_integrity_followup.sql` plus its Drizzle journal/snapshot: forward-only CREATE OR REPLACE for validate_finalized_journal, guard_shipment_event and record_shipment_metadata_change. No triggers, checks, locks, indexes or prior safeguards were removed.
- `src/db/sql/financial-followup.sql` and `shipment-followup.sql`: source fragments composing 0007 exactly.
- `src/db/sql/financial-integrity.sql`: cumulative 0001 + 0005 + financial follow-up. `shipment-integrity.sql`: cumulative 0006 + shipment follow-up. `financial-hardening.sql` remains the unchanged 0005 source.
- `scripts/audit-schema.cjs` and `tests/baseline-migrations.json`: enforce cumulative source/migration parity and preservation hashes for SQL and snapshots 0000–0006.
- `tests/integration/financial-integrity.test.cjs`: nine new SQL regression cases, and deterministic shipment creation timestamps for existing valid fixtures.
- Posting rules, shipment documentation, test instructions and README updated to the current behavior.

All seven migration SQL files and seven snapshots for 0000–0006 were compared against hashes captured before edits: **14/14 unchanged**. Existing journal entries are retained; only the 0007 entry/snapshot is appended. Repeated schema generation finds no drift.

## Regression cases added

- SHIPPED and CANCELLED before creation each fail with the date-floor error.
- Status exactly at creation succeeds.
- Historical NOTE before creation persists without changing shipment state/timestamps.
- Generic adjustment against an already finalized reversal fails.
- Adjustment queued before a same-transaction finalized reversal also fails at deferred validation.
- A draft reversal does not block a valid explicit generic adjustment.
- Notes-only updates capture null → text → changed text → null in before/after audit data and preserve NOTE history.
- Other metadata edits also include unchanged notes in both snapshots.

These are PostgreSQL integration regressions. They were not executed against a database, in accordance with the task. Static review identified the missing creation-date predicate, effective-reversal lookup and JSON keys; runtime reproduction/validation remains intentionally deferred.

## Exact checks

| Command/check | Result |
| --- | --- |
| npm run test:db:offline | Exit 0: 6 passed, 0 failed, 0 skipped |
| env -u LOCAL_TEST_DATABASE_URL -u LOCAL_TEST_DATABASE_DISPOSABLE npm run test:db:integration | Exit 0: 70 skipped, 0 passed/executed, 0 failed; test connection variables explicitly removed |
| node scripts/audit-schema.cjs | Exit 0: 39 tables, 83 FK targets, key ordering, direct tenant roots, identifier lengths, source parity and historical hashes |
| node scripts/audit-env.cjs | Exit 0: no-URL configuration, .env.local precedence and shell precedence |
| node --check tests/integration/financial-integrity.test.cjs | Exit 0: JavaScript syntax valid |
| npx drizzle-kit generate --custom --name=integrity_followup | Exit 0: generated 0007 scaffold, populated from the two maintained source fragments |
| npx drizzle-kit generate --name=verify_no_drift | Exit 0: no schema changes, nothing to migrate |
| npx drizzle-kit check | Exit 0: migration metadata consistent; not SQL execution |
| npx tsc --noEmit | Final rerun exit 0 after build output stabilized. Initial overlapping attempt exited 2 with TS6053 for two generated .next/types files being removed by the concurrent build |
| npm run lint | Exit 1: 26 @typescript-eslint/no-require-imports errors, 0 warnings, in the existing CommonJS audit scripts/tests. No lint rules were weakened or unrelated tooling rewritten |
| npm run build | Exit 1: environment blocks Turbopack CSS worker port binding (EPERM) |
| npm run build -- --webpack | Exit 0: compilation, TypeScript, static page generation and build traces passed; no network permission was requested for this run |
| git diff --check | Exit 0 |
| Captured historical SQL/snapshot SHA-256 checks | 14/14 unchanged (0000–0006) |

Offline checks do not certify PostgreSQL syntax/runtime or concurrency. All 70 integration cases remain unexecuted. The three fixes are ready for review and a future separately authorized disposable-database test pass. No database connection, migration application, push, studio session, Neon access or production access occurred.
