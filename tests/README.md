# Database validation

`npm run test:db:offline` exercises six structural tests: all FK/UNIQUE targets, migration ordering/history and custom source parity; Next environment precedence; the verified Better Auth 1.6.3 field manifest; restrictive shipment ownership with multiple shipments; reversal ownership/currency/uniqueness; and exact decimal tenant/currency declarations.

`npm run test:db:integration` loads 70 PostgreSQL cases. Without LOCAL_TEST_DATABASE_URL, every case is explicitly skipped. It never loads `.env.local`, falls back to DATABASE_URL, creates a database, or applies migrations. This task did not configure a disposable local database, so none of these SQL cases has been executed against PostgreSQL.

To run later, use an already available disposable local PostgreSQL database with the **entire migration chain already applied separately under explicit authorization**. Set LOCAL_TEST_DATABASE_URL in the shell to its URL and LOCAL_TEST_DATABASE_DISPOSABLE=yes. Allowed hosts are localhost/127.0.0.1/::1, database names must start with etsy_finance_test_ and use only lowercase letters/digits/underscores after that prefix. Connection query parameters are forbidden to prevent host overrides. Never point a local proxy/tunnel at a remote database. Do not use Neon, production or a retained development database.

Each case creates isolated synthetic tenant fixtures inside a transaction, checks deferred constraints explicitly, and rolls back. Negative cases use savepoints to assert a specific failure. The suite includes standard/compound signed postings, invalid amount/currency/source/account roles, duplicate financial sources, immutable journals/instructions/purchases, atomic and invalid reversals, supplier confirmation/refunds, expenses and partial refunds, distinct payout/deposit, USD transfers/fees, actual PKR receipts without invented FX equality, shipment transitions/history, tenant FKs and independent order delivery. The reversal retry case checks same-key idempotency separately from duplicate reversal rejection.

Passing TypeScript/offline tests or Drizzle generation is **not** SQL runtime validation. After running this suite, add concurrent two-connection tests for competing postings/allocations/reversals and status updates, plus runtime-role/RLS authorization tests. The suite tests referential tenant isolation; application tenant predicates and SELECT authorization are separate requirements. Review legacy finalized/reversed rows before deployment, because new guards do not rewrite historical journals.

No paid dependencies or new test libraries are required: Node's built-in test runner and the existing postgres driver are used. The schema test manifest was extracted from the official version-pinned core getAuthTables metadata without importing/enabling an auth runtime; it verifies field structure, not login/security or full package-peer compatibility.


The 0007 follow-up adds nine SQL regression cases: SHIPPED/CANCELLED before creation fail; a status at the exact creation boundary succeeds; a pre-creation NOTE preserves history without projecting state; finalized reversals block generic adjustments (including reversed statement order within a transaction); draft reversals do not block them; notes-only edits preserve before/after notes through null transitions; and unrelated metadata edits include unchanged notes. Existing valid shipment fixtures now declare created_at before their status event dates. These cases are authored but not database-executed for this no-database task. The integration runner is invoked with test connection variables explicitly removed to guarantee offline skips.


## Executed local validation (2026-11-24)

The earlier skipped-only results above are historical. The current suite was executed on a new disposable Docker PostgreSQL 18.6 instance: **71 sequential cases and 12 concurrency/transaction cases passed, with zero failures or skips** after correcting the negative-transaction reconciliation defect in migration 0008. The offline suite now contains eight checks, including local connection safety/configuration. See [Database Integration Test Report](../docs/Database_Integration_Test_Report.md) for exact results and the frozen migration chain.

Reproduce with an already cached/local Docker PostgreSQL 18 image:

```bash
node scripts/local-db.cjs start
node scripts/local-db.cjs ready
node scripts/local-db.cjs run npm run db:migrate -- --config=drizzle.local-test.config.ts
node scripts/local-db.cjs run node scripts/verify-local-db.cjs
node scripts/local-db.cjs run npm run test:db:integration
node scripts/local-db.cjs run npm run test:db:concurrency
node scripts/local-db.cjs stop
```

On a cold start, repeat `ready` after PostgreSQL finishes initializing; migrations must not run until readiness succeeds. `start` generates random credentials and a random etsy_finance_test_* database, binds only 127.0.0.1, uses RAM-backed container storage and saves credentials in a mode-0600 temporary state file. Commands never print the URL/password. `run` verifies the container label/name and local URL/disposable marker, excludes DATABASE_URL from child commands, and supplies only the test connection. The test-only Drizzle config loads neither dotenv nor application .env.local. `stop` removes only this labeled container and its protected temporary state/credentials. Existing containers/databases are untouched.

The concurrency suite uses two independent worker sessions plus a catalog observer. Overlap is established by observing a real PostgreSQL lock wait before releasing the first transaction, rather than assuming parallel promises overlapped. It tests supplier confirmation, duplicate source postings, same/different-key reversals, payout/item allocation caps, deposit/payout reconciliation caps, ordered shipment updates, deferred commit rollback, a real repeatable-read 40001 failure and a real 40P01 deadlock. Bounded retries restart entire transactions; production services still need to implement that retry/error handling.
