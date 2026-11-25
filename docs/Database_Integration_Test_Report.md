# Database Integration Test Report

**Date:** 2026-11-24
**Status:** Database phase closed for V1. Ready for application development; not production-certified.
**Migration chain frozen:** `0000`–`0008`

This report merges two validation passes:

- **Pass 1 (Codex):** built the local test tooling, found and fixed one trigger defect (migration 0008), and ran the full suite. Its run ended before the final cleanup and handoff.
- **Pass 2 (Claude, independent re-verification):** inspected the repository, recreated a fresh disposable database, re-ran every check below from scratch, reproduced the 0008 defect, and completed cleanup.

Status legend used throughout:

| Mark | Meaning |
| --- | --- |
| **Verified** | Re-executed in Pass 2 with the exact result shown. |
| **Reported** | Stated by Pass 1 only; no raw logs were retained, so it could not be independently reproduced. |

---

## 1. Environment

| Item | Value | Status |
| --- | --- | --- |
| PostgreSQL | 18.6 (Debian 18.6-1.pgdg13+2), aarch64 | Verified |
| Image | `postgres:18` (already cached locally; nothing pulled or installed) | Verified |
| Docker server | 29.5.2 | Verified |
| Node test runner | Built-in `node --test`; driver `postgres` (already a dependency) | Verified |
| Network binding | `127.0.0.1` only (ephemeral port) | Verified |
| Storage | `--tmpfs /var/lib/postgresql`, `--rm`, no volumes or bind mounts | Verified |
| Production / Neon access | None. `drizzle.config.ts` (the app config) was never used against a database | Verified |

### Test environment setup

`scripts/local-db.cjs` manages a single labelled container (`etsy-finance.disposable=true`):

- `start` generates a random container name, a random `etsy_finance_test_*` database and a 32-byte random password. Credentials are written only to a mode-0600 state file in the OS temp directory and are never printed.
- `run <cmd>` re-checks the container label and name, validates the URL, removes `DATABASE_URL` from the child environment and injects only `LOCAL_TEST_DATABASE_URL`.
- `stop` removes the container, its credentials directory and the state file.

`drizzle.local-test.config.ts` and `tests/helpers/local-database.cjs` reject non-loopback hosts, any database name not prefixed `etsy_finance_test_`, query-string or fragment overrides, and a missing `LOCAL_TEST_DATABASE_DISPOSABLE=yes`. Neither loads dotenv, `@next/env`, `.env.local` or `DATABASE_URL`.

Pass 2 container: `etsy-finance-test-5c74df5529b7`. Readiness was confirmed both by `pg_isready` and by the container log showing `PostgreSQL init process complete` followed by the final server start. This avoids the cold-start race Pass 1 described.

---

## 2. Migration execution

Command: `node scripts/local-db.cjs run npm run db:migrate -- --config=drizzle.local-test.config.ts`

| Migration | Result | Status |
| --- | --- | --- |
| 0000_audited_schema | Applied | Verified |
| 0001_financial_integrity | Applied | Verified |
| 0002_reversals_and_shipments | Applied | Verified |
| 0003_explicit_posting_events | Applied | Verified |
| 0004_financial_account_roles | Applied | Verified |
| 0005_financial_posting_hardening | Applied | Verified |
| 0006_shipment_history_integrity | Applied | Verified |
| 0007_integrity_followup | Applied | Verified |
| 0008_deposit_reconciliation_capacity | Applied | Verified |

- **Replay:** a second `db:migrate` succeeded and applied nothing. The only output was PostgreSQL's notice that `__drizzle_migrations` already exists. The ledger still held 9 rows. **Verified.**
- **Ledger integrity:** `verify-local-db.cjs` confirmed that the recorded hashes and ordering match Drizzle's `readMigrationFiles` output. **Verified.**
- **Schema drift:** `drizzle-kit check` reported "Everything's fine". `drizzle-kit generate --name=verify_no_drift` reported "No schema changes, nothing to migrate", and the file listing of `drizzle/` was identical before and after. **Verified.**
- **No `push`** was used in either pass.

### Historical migrations unchanged

- All 18 entries in `tests/baseline-migrations.json` (SQL files and snapshots for 0000–0008) match their current SHA-256 hashes. **Verified.**
- `drizzle/_journal.json` lists exactly idx 0–8 in order. **Verified.**
- **Limitation:** the migration files are untracked in git, and the hash manifest was written by Pass 1. Pass 2 can prove nothing changed since that manifest was written, but not against an independent baseline. Supporting evidence: the file timestamps of 0000–0007 (21:34–22:12) all predate 0008 (22:20). Committing the chain makes the freeze enforceable (see §9).

---

## 3. Migration 0008: the defect and the fix

**Defect.** In 0001, `validate_financial_allocations()` compared confirmed reconciliations against *every* Payoneer transaction's amount. A legitimate negative transaction (e.g. an `ADJUSTMENT` of −5) with no reconciliations evaluated `0 > −5`. That raised `P0001: Confirmed reconciliation exceeds deposit or payout` and blocked a valid record.

**Fix.** 0008 is a forward-only `CREATE OR REPLACE` of the same function. Compared with its 0001 definition, the body differs in **exactly one predicate**:

```diff
- IF EXISTS (SELECT 1 FROM payoneer_transactions p WHERE p.account_id = tenant AND
+ IF EXISTS (SELECT 1 FROM payoneer_transactions p WHERE p.account_id = tenant AND p.transaction_type = 'DEPOSIT' AND
```

The rule that rejects any reconciliation referencing a non-deposit is untouched, so non-deposits still cannot gain reconciliation capacity. The payout cap, item cap, withdrawal match, expense-allocation and batch-uniqueness checks are unchanged. `src/db/sql/allocation-validation.sql` is byte-identical to 0008. **Verified.**

**Proof of cause (Pass 2).** A second database inside the same disposable container received only migrations 0000–0007. The two negative-amount cases were then run against both databases:

| Test | 0000–0007 only | 0000–0008 |
| --- | --- | --- |
| negative adjustment uses declared net movement instead of total debits | **Fail**, P0001 "Confirmed reconciliation exceeds deposit or payout" | Pass |
| negative OTHER transaction without reconciliation has no deposit-cap violation (regression added with 0008) | **Fail**, same P0001 | Pass |

The deployed function source in the migrated database contains the `transaction_type = 'DEPOSIT'` filter. In the pre-0008 database it does not. **Verified.**

Pass 1's original full-suite figure of "70 cases: 69 passed, 1 failed" is **Reported**. Pass 2 reproduced the failing case itself, not the full 70-case pre-fix run.

---

## 4. Sequential integration suite (71 cases)

Command: `node scripts/local-db.cjs run npm run test:db:integration`

**Result: 71 tests, 71 passed, 0 failed, 0 cancelled, 0 skipped, exit 0. Verified.**

Each case creates synthetic tenant fixtures inside a transaction, checks deferred constraints explicitly and rolls back. Coverage includes:

- Posting validity: signed standard and compound postings; invalid amounts, currencies, sources and account roles.
- Journal rules: duplicate financial sources; immutable finalized journals and posting instructions; atomic exact reversals and reversal-key idempotency.
- Suppliers: purchase confirmation and supplier refunds.
- Money flows: expenses and partial refunds; distinct Etsy payouts and Payoneer deposits; USD transfers and fees; actual PKR receipts without an invented FX equality.
- Shipments: chronology, append-only history and notes auditing.
- Tenancy: tenant composite foreign keys, and order delivery kept independent of shipments.

---

## 5. Concurrency and transaction suite (12 cases)

Command: `node scripts/local-db.cjs run npm run test:db:concurrency`

The suite opens two worker sessions plus an observer session. It asserts distinct `pg_backend_pid` values, then holds the first transaction open until the observer sees the second worker in `wait_event_type = 'Lock'`. This proves the two transactions genuinely overlapped.

| # | Case | Result |
| --- | --- | --- |
| 1 | Two supplier confirmations commit exactly one immutable cost posting | Pass |
| 2 | Two source postings cannot commit duplicate financial events | Pass |
| 3 | Two same-key reversal requests return one committed reversal | Pass |
| 4 | Two different-key reversals cannot reverse an original twice | Pass |
| 5 | Concurrent Etsy allocations cannot exceed actual payout | Pass |
| 6 | Concurrent Etsy allocations cannot exceed expected item | Pass |
| 7 | Concurrent reconciliations cannot exceed deposit capacity | Pass |
| 8 | Concurrent reconciliations cannot exceed payout capacity | Pass |
| 9 | Concurrent shipment events preserve a valid committed history | Pass |
| 10 | Deferred failure rolls back confirmation and every journal row | Pass |
| 11 | Repeatable-read serialization failure (asserted `40001`) retries the complete transaction safely | Pass |
| 12 | Real two-connection deadlock (asserted `40P01`) retries the victim transaction | Pass |

**Result: 12 tests, 12 passed, 0 failed, 0 cancelled, 0 skipped, exit 0. Verified.**

The retry loops live in the test harness only. Application services must implement their own bounded whole-transaction retries (see the application handoff).

---

## 6. Offline suite (8 cases)

Command: `npm run test:db:offline`, run with `DATABASE_URL` and `LOCAL_TEST_DATABASE_URL` unset.

1. Migration chain: valid tenant/unique targets, ordering and frozen historical hashes.
2. Next environment precedence and credential-free generation. This uses synthetic values in a temp directory that is deleted afterwards.
3. Better Auth 1.6.3 field manifest matches the current Drizzle models.
4. Shipment ownership FKs are restrictive and allow multiple shipments per order.
5. Reversal references include tenant and currency, with one reversal per original.
6. Posting legs use `numeric(19,4)` and tenant/currency FKs.
7. Local DB safety rejects remote hosts, retained databases and URL overrides.
8. The local migration config cannot load application environment files.

**Result: 8 passed, 0 failed, 0 skipped. Verified.**

---

## 7. Runtime catalog

Counts come from `scripts/verify-local-db.cjs`, which compares exact object-name sets against the snapshot. Pass 2 cross-checked them with direct `psql` catalog queries against the `public` schema (non-internal triggers only; the migration ledger lives in the `drizzle` schema).

| Object | Reported (Pass 1) | verify script (Pass 2) | Direct psql (Pass 2) |
| --- | --- | --- | --- |
| Tables | 39 | 39 | 39 |
| Enums | 20 | 20 | 20 |
| Foreign keys | 83 | 83 | 83 |
| Indexes (incl. PK/unique) | 135 | 135 | 135 |
| Custom functions | 19 | 19 | 19 |
| User triggers | 53 | 53 | 53 |
| Recorded migrations | 9 | 9 | 9 |

All counts match. **Verified.** `node scripts/audit-schema.cjs` also passed offline: 39 tables, 83 valid FK targets, tenant roots, identifier lengths and custom-SQL parity.

---

## 8. Build, TypeScript and lint

| Check | Result | Status |
| --- | --- | --- |
| `npx tsc --noEmit` | exit 0 | Verified |
| `npm run lint` (eslint) | exit 0, no output | Verified |
| `npm run build -- --webpack` | exit 0; compiled, typechecked, 4/4 static pages | Verified |
| `git diff --check` | exit 0 | Verified |

The lint run relies on one scoped override in `eslint.config.mjs`: `@typescript-eslint/no-require-imports` is turned off only for `scripts/**/*.cjs` and `tests/**/*.cjs`. Application TypeScript rules are unchanged. Pass 1's earlier error counts (26, later 49, all from that rule) are **Reported**.

---

## 9. Cleanup

| Item | Result | Status |
| --- | --- | --- |
| Pass 1 container `etsy-finance-test-cc782a84349c` | Already absent on arrival; no container carried the `etsy-finance.disposable` label | Verified |
| Pass 1 credentials and state file | None found in `$TMPDIR`, `/tmp` or `/private/tmp` | Verified |
| Pass 2 container `etsy-finance-test-5c74df5529b7` (including the pre-0008 comparison DB) | Removed via `local-db.cjs stop` (auto-remove, tmpfs) | Verified |
| Pass 2 credentials and state file | Removed; a re-scan of temp directories found nothing | Verified |
| Docker volumes | 166 before and after; none created (tmpfs) and none deleted | Verified |
| Unrelated containers | The same 6 containers, in the same states; untouched | Verified |
| Networks | Unchanged; none created | Verified |
| Secrets in repo | No real connection strings. Only synthetic `test:synthetic@…` fixtures and the runner's template string. `.env*` is git-ignored, and `.env.local` was not modified | Verified |

Pass 2 test logs were written only to the session scratch directory and contain no credentials.

---

## 10. Limitations and open items

1. **Migrations are not committed.** `drizzle/`, `src/db/`, `tests/`, `scripts/` and `docs/` are all untracked. The freeze rests on the hash manifest until the chain is committed. *Commit before starting application work.*
2. **Local scope only.** This is a PostgreSQL 18.6 correctness validation. It is not a production deployment, a security certification, a stress test or a throughput benchmark. Before go-live, rerun the chain and suites on the production PostgreSQL major version and validate the runtime role, grants, RLS (if adopted), connectivity and backups.
3. **Referential isolation is not read authorization.** Composite FKs prevent cross-tenant *references*. They do not stop a query from *reading* another tenant's rows. Every query needs a session-derived tenant predicate.
4. **Pass 1-only figures.** The 69/1 pre-fix full-suite run and the lint error history could not be reproduced (no logs kept). Every current-state result above was reproduced.
5. **Legacy data.** The new guards do not rewrite existing finalized or reversed rows. The database currently holds none, but review this before importing any historical data.

---

## Conclusion

Every critical check was reproduced independently, and the 0008 fix was shown to be the cause of the green result. **Migrations 0000–0008 are frozen. Database integrity and local integration testing are complete for V1.** Further schema changes require a concrete feature requirement or a reproduced defect, delivered as a new forward migration (0009+). The database is ready for application development; it is not production-certified.
