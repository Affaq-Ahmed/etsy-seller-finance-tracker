# Development

**Last updated:** 2026-11-25

This is the baseline development document: setup, environment variables, commands, testing and the migration workflow. Engineering rules are in [AGENTS.md](../AGENTS.md), design in [ARCHITECTURE.md](ARCHITECTURE.md), and progress in [STATUS.md](STATUS.md).

## 1. Prerequisites

- **Node.js ≥ 20.9** (the Next.js 16 engine requirement) and npm.
- **Docker** with the `postgres:18` image, needed only for the database integration and concurrency suites. All tooling is free and open source; no paid services are needed.
- Work only from a trusted machine (AGENTS.md, "Environment and Security Safety").

## 2. Setup

```bash
npm ci    # install exactly from package-lock.json
```

If it does not exist yet, create a root `.env.local` and add the variables from §3 that you need. Never overwrite an existing one. `.env*` files are git-ignored (`.gitignore`). Never commit them, print their values, or paste secrets into docs, logs or issues.

## 3. Environment variables (names only)

| Name | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `drizzle.config.ts` (application database) | Loaded with Next.js precedence via `@next/env` (`.env.local` and the shell). It is optional for offline `db:generate`/`db:check`. **Tests never read it.** Do not point local work at Neon or production without explicit owner authorization for that specific operation. |
| `LOCAL_TEST_DATABASE_URL` | Integration and concurrency suites, `drizzle.local-test.config.ts`, `scripts/verify-local-db.cjs` | Set automatically by `scripts/local-db.cjs run`. Must be `localhost`, `127.0.0.1` or `[::1]`; the database name must match `etsy_finance_test_[a-z0-9_]+`; query strings and fragments are rejected. |
| `LOCAL_TEST_DATABASE_DISPOSABLE` | Same as above | Must be `yes`. Set by the runner. |
| `NODE_ENV` | Next.js, `drizzle.config.ts` | Standard. |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | *Planned* (auth not implemented) | Server-only. The secret must be at least 32 random bytes. |
| `HYPERDRIVE` (Workers binding) | *Planned* (deployment not implemented) | See ARCHITECTURE.md §2.1. |

AGENTS.md requires a configuration module that validates required variables at startup. It is not built yet (ARCHITECTURE.md C4).

## 4. Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js. If Turbopack cannot bind worker ports in a sandbox (`EPERM`), use `npm run build -- --webpack`. The layout fetches Google Fonts at build time, so the build needs network access. |
| `npm run lint` | ESLint. A scoped override allows CommonJS `require` only in `scripts/**/*.cjs` and `tests/**/*.cjs`. |
| `npx tsc --noEmit` | Type check. |
| `npm run db:generate` | Generate migration SQL from the schema (never applies it). Inspect the SQL and snapshots. |
| `npm run db:check` | Drizzle migration metadata consistency. This is not a SQL execution test. |
| `npm run db:migrate` | Apply migrations. **Use it only through the local test runner** unless the owner authorizes a specific database. |
| `npm run db:studio` | Drizzle Studio (needs a database; same restriction). |
| `npm run test:db:offline` | 8 offline checks (§5.1). |
| `npm run test:db:integration` | 71 PostgreSQL cases (§5.2). Every case is skipped without a test database. |
| `npm run test:db:concurrency` | 12 two-session concurrency cases (§5.3). |
| `node scripts/audit-schema.cjs` | Offline audit: FK targets and ordering, tenant roots, identifier lengths, maintained-SQL parity, frozen hashes. |
| `node scripts/audit-env.cjs` | Offline check of the `drizzle.config.ts` environment precedence (synthetic values only). |
| `node scripts/verify-local-db.cjs` | Runtime catalog and migration-ledger verification (run through the local runner). |

**`drizzle-kit push` is forbidden.** It skips the custom SQL guards.

## 5. Testing

The database suites use Node's built-in test runner and the existing `postgres` driver, with no extra test libraries. The System Architecture specifies Vitest + Playwright for application tests; this is not yet resolved (ARCHITECTURE.md C1).

### 5.1 Offline suite (`tests/offline-schema.test.cjs`)

1. The migration chain has valid tenant and unique targets, correct ordering, and frozen historical hashes.
2. Next.js environment precedence and credential-free generation.
3. The Better Auth 1.6.3 field manifest (`tests/fixtures/better-auth-1.6.3.json`) matches the Drizzle auth models.
4. Shipment ownership FKs are restrictive, and multiple shipments per order are allowed.
5. Reversal references include tenant and currency, with one reversal per original.
6. Posting legs use exact decimals and tenant/currency FKs.
7. Local database safety rejects remote hosts, retained databases and URL overrides.
8. The local migration config cannot load application environment files.

### 5.2 Integration suite (`tests/integration/financial-integrity.test.cjs`)

- Each case creates isolated synthetic tenant fixtures inside a transaction (`tests/helpers/financial-fixture.cjs`), checks deferred constraints explicitly, and rolls back.
- Negative cases use savepoints to assert the exact failure.
- Coverage:
  - Signed and compound postings; invalid amounts, currencies, sources and roles; duplicate sources.
  - Immutable journals and instructions; exact and atomic reversals; same-key reversal retry.
  - Supplier confirmation and refunds; expenses and partial refunds.
  - Payout and deposit separation; USD transfers and fees; actual PKR receipts.
  - Explicit signed adjustments, including negative Payoneer transactions (the 0008 regression).
  - Shipment chronology, history and notes auditing; tenant FKs; independent order delivery.

### 5.3 Concurrency suite (`tests/integration/concurrency.test.cjs`)

- Two worker sessions with distinct `pg_backend_pid`s, plus an observer session.
- Competing transactions overlap for real: the first transaction stays open until the observer sees the second worker in a `Lock` wait.
- Cases: supplier confirmation; duplicate source posting; same-key and different-key reversals; payout, item, deposit and payout reconciliation caps; ordered shipment events; deferred-failure rollback; a real `40001` retry; a real `40P01` deadlock retry.
- The retries live in the test harness only. Services must implement their own (ARCHITECTURE.md §4.6).

### 5.4 Disposable local database

```bash
node scripts/local-db.cjs start      # random name, password and etsy_finance_test_* db; loopback only; tmpfs; --rm
node scripts/local-db.cjs ready      # repeat until it succeeds (see the note below)
node scripts/local-db.cjs run npm run db:migrate -- --config=drizzle.local-test.config.ts
node scripts/local-db.cjs run node scripts/verify-local-db.cjs
node scripts/local-db.cjs run npm run test:db:integration
node scripts/local-db.cjs run npm run test:db:concurrency
node scripts/local-db.cjs stop       # removes the container, credentials and state file
```

- **Credentials.** The runner keeps them in a mode-0600 temporary state file and never prints them.
- **What `run` does.** It verifies the container label and name and the URL rules, removes `DATABASE_URL` from the child environment, and injects only the test connection.
- **Config isolation.** `drizzle.local-test.config.ts` loads neither dotenv nor `.env.local`.
- **Cold start.** `pg_isready` can succeed against the image's temporary init server. Before migrating, confirm that `docker logs <container>` shows `PostgreSQL init process complete`.
- **Expected `verify-local-db.cjs` result:** 39 tables, 20 enums, 83 FKs, 135 indexes, 19 functions, 53 triggers, 9 migrations, with hashes and order verified.
- Never use Neon, production or a retained database for tests. Never point a local proxy or tunnel at a remote database.

### 5.5 Check order (AGENTS.md "Testing and Definition of Done")

1. `npx tsc --noEmit`
2. `npm run lint`
3. Targeted tests
4. `npm run test:db:offline`, then integration and concurrency through the runner when the database or posting logic is touched
5. The full suite and coverage (not configured yet)
6. `npm run build` (or `-- --webpack`)

Report actual results. If a check cannot run, say why and mark the task partially verified.

## 6. Migration workflow

**Migrations `0000–0008` are frozen.** Never edit, reorder or regenerate them, and never use `push`. All changes go in new forward-only migrations (`0009+`).

### 6.1 Maintained SQL sources and required parity

These equalities are enforced by `scripts/audit-schema.cjs`:

| Maintained source | Must equal |
| --- | --- |
| `src/db/sql/financial-hardening.sql` | `drizzle/0005_financial_posting_hardening.sql` |
| `src/db/sql/allocation-validation.sql` | `drizzle/0008_deposit_reconciliation_capacity.sql` |
| `drizzle/0007_integrity_followup.sql` | `financial-followup.sql` + `\n--> statement-breakpoint\n` + `shipment-followup.sql` |
| `src/db/sql/shipment-integrity.sql` | `0006_shipment_history_integrity.sql` + `\n` + `shipment-followup.sql` |
| `src/db/sql/financial-integrity.sql` (cumulative) | `0001_financial_integrity.sql` + `\n` + `financial-hardening.sql` + `\n` + `financial-followup.sql` + `\n` + `allocation-validation.sql` |

The frozen SQL comments cite `docs/Financial_Posting_Rules.md`. That content is now in ARCHITECTURE.md §4.

### 6.2 Adding a migration

1. Make sure a concrete requirement or a reproduced defect justifies it (AGENTS.md).
2. For table, column or constraint changes, edit `src/db/schema.ts` and run `npm run db:generate -- --name=<change>`. For functions and triggers, run `npx drizzle-kit generate --custom --name=<change>`, write the SQL in a new maintained fragment under `src/db/sql/`, and extend the parity rules and cumulative sources.
3. Review the SQL: constraints, indexes, FK ordering (referenced UNIQUE keys before FKs), triggers, locking and rollback implications.
4. Add integration and concurrency tests for the new behavior.
5. Validate on a fresh disposable database: full chain → replay is a no-op → `verify-local-db.cjs` (update the expected counts) → all suites → `drizzle-kit check` → `drizzle-kit generate --name=verify_no_drift` reports "No schema changes".
6. Once approved and frozen, add the new SQL and snapshot SHA-256 values to `tests/baseline-migrations.json`.

## 7. Dependency upgrades

Upgrade only with owner approval. Pin exact versions and install with `npm ci`. For the proposed auth stack (ARCHITECTURE.md §8), verify:

1. `npm ls better-auth @better-auth/drizzle-adapter drizzle-orm drizzle-kit postgres next` shows exact versions and no `invalid`/`ERESOLVE`; `npm audit --omit=dev` is clean for auth.
2. `npm run test:db:offline` passes (frozen hashes intact).
3. **The no-drift gate:** `drizzle-kit check` passes and `drizzle-kit generate --name=verify_no_drift` reports no changes, both through the local-test config. `git status` must show **no** changes under `drizzle/`. If the kit wants to rewrite snapshots or the journal, stop and escalate.
4. A fresh-database replay plus `verify-local-db.cjs` counts.
5. Integration 71/71, concurrency 12/12, offline 8/8.
6. An ORM-path smoke test: a Drizzle transaction posts a balanced journal, and a forced `40001` retry does not double-post.
7. Regenerate the Better Auth field manifest for the pinned version and compare it with `src/db/auth-schema.ts`. Any gap becomes a forward migration.
8. `tsc`, lint and build.

## 8. Code layout

| Path | Contents |
| --- | --- |
| `src/app/` | Next.js App Router (scaffold only) |
| `src/db/schema.ts`, `src/db/auth-schema.ts` | Drizzle schema; Better Auth model mapping |
| `src/db/sql/` | Maintained custom SQL sources (§6.1) |
| `drizzle/`, `drizzle/meta/` | Migrations 0000–0008, snapshots, journal |
| `drizzle.config.ts` / `drizzle.local-test.config.ts` | Application config / isolated test config |
| `scripts/` | Local database runner, offline audits, catalog verifier |
| `tests/` | Offline, integration and concurrency suites; fixtures; helpers; frozen hash manifest |

## 9. Conventions and Git

Follow [AGENTS.md](../AGENTS.md): strict TypeScript; validate at the boundary; thin handlers over domain services; server-only code out of client bundles; tests for every changed source file.

Commits are made only when explicitly authorized. Inspect the full staged diff first, and use concise conventional commit messages with no co-author trailers or AI attribution.
