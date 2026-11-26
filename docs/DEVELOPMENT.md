# Development

**Last updated:** 2026-11-25

This is the baseline development document: setup, environment variables, commands, testing and the migration workflow. Engineering rules are in [AGENTS.md](../AGENTS.md), design in [ARCHITECTURE.md](ARCHITECTURE.md), and progress in [STATUS.md](STATUS.md).

## 1. Prerequisites

- **Node.js ≥ 20.19** (Vite 7.3.8 requires `^20.19 || >=22.12`; Next.js 16 needs ≥ 20.9) and npm. Verified on Node 26.10.0.
- **Docker** with the `postgres:18` image, needed only for the database-backed suites. All tooling is free and open source; no paid services are needed.
- Work only from a trusted machine (AGENTS.md, "Environment and Security Safety").

## 2. Setup

```bash
npm ci --ignore-scripts --userconfig /dev/null    # exactly from package-lock.json
```

- No dependency needs an install script. The tree was installed and verified this way on 2026-11-25.
- `--userconfig /dev/null` keeps any npm token in `~/.npmrc` from being sent; public packages need no token.
- `npm ls --all` must exit 0.

If it does not exist yet, create a root `.env.local` and add the variables from §3 that you need. Never overwrite an existing one. `.env*` files are git-ignored (`.gitignore`). Never commit them, print their values, or paste secrets into docs, logs or issues.

To run the app locally (`npm run dev`), `DATABASE_URL` must point at a local PostgreSQL that has migrations 0000–0009 applied. Never point it at Neon or production without explicit owner authorization. The disposable test container (§5.4) is for tests only.

## 3. Environment variables (names only)

| Name | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Application runtime (`src/server/config/env.ts`) and `drizzle.config.ts` | Must be a `postgres://` or `postgresql://` URL. Loaded with Next.js precedence (`.env.local` and the shell). Optional for offline `db:generate`/`db:check`. The test suites never read the developer's value: the only test that sets it (`tests/app/db/api-routes.test.ts`, route files) sets it to the validated disposable test URL for that file and restores it afterwards. Do not point local work at Neon or production without explicit owner authorization for that specific operation. |
| `LOCAL_TEST_DATABASE_URL` | All database-backed suites (`node:test` and Vitest `tests/app/db`), `drizzle.local-test.config.ts`, `scripts/verify-local-db.cjs` | Set automatically by `scripts/local-db.cjs run`. Must be `localhost`, `127.0.0.1` or `[::1]`; the database name must match `etsy_finance_test_[a-z0-9_]+`; query strings and fragments are rejected. |
| `LOCAL_TEST_DATABASE_DISPOSABLE` | Same as above | Must be `yes`. Set by the runner. |
| `NODE_ENV` | Next.js, `drizzle.config.ts`, config module | `development` (default), `production` or `test`. |
| `BETTER_AUTH_SECRET` | Better Auth (cookie signing) | Server-only. At least 32 characters of random data (e.g. 32 random bytes hex-encoded). A per-run random value is generated in tests. |
| `BETTER_AUTH_URL` | Better Auth `baseURL`/`trustedOrigins`; the app's same-origin check | The public application origin only (scheme, host, optional port; no path, query or credentials). **https is required when `NODE_ENV=production`.** With option B (ARCHITECTURE.md §2.2) this is the Worker's origin, not the auth host's. |
| `HYPERDRIVE` (Workers binding) | *Planned* (deployment not implemented) | See ARCHITECTURE.md §2.1. |

**Validation.** `src/server/config/env.ts` validates these variables, and `src/instrumentation.ts` runs that validation when a Node server starts. Startup fails with a `ConfigError` listing the variable **names** that are missing or invalid, never their values. `next build` skips the check, so builds need no secrets.

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
| `npm run test:app` | All 512 Vitest application cases (§5.6). Without a test database the 230 database-backed cases are **skipped** and the 282 unit cases run. |
| `npm run test:app:unit` / `npm run test:app:db` | Only `tests/app/unit` (282) or only `tests/app/db` (230; run through the local runner). |
| `node scripts/audit-schema.cjs` | Offline audit: FK targets and ordering, tenant roots, identifier lengths, maintained-SQL parity, frozen hashes. |
| `node scripts/audit-env.cjs` | Offline check of the `drizzle.config.ts` environment precedence (synthetic values only). |
| `node scripts/verify-local-db.cjs` | Runtime catalog and migration-ledger verification (run through the local runner). |

**`drizzle-kit push` is forbidden.** It skips the custom SQL guards.

## 5. Testing

The database integrity suites use Node's built-in test runner and the `postgres` driver. Application tests use **Vitest 4.1.12** (ARCHITECTURE.md A15, §5.6). Playwright is deferred to the frontend phase.

### 5.1 Offline suite (`tests/offline-schema.test.cjs`)

1. The migration chain has valid tenant and unique targets, correct ordering, and frozen historical hashes.
2. Next.js environment precedence and credential-free generation.
3. The Better Auth field manifest for the **pinned** version (`tests/fixtures/better-auth-1.7.25.json`, including `rateLimit`) matches the Drizzle auth models. The test fails if `package.json` pins a different version.
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
node scripts/local-db.cjs run npm run test:app
node scripts/local-db.cjs stop       # removes the container, credentials and state file
```

- **Credentials.** The runner keeps them in a mode-0600 temporary state file and never prints them.
- **What `run` does.** It verifies the container label and name and the URL rules, removes `DATABASE_URL` from the child environment, and injects only the test connection.
- **Config isolation.** `drizzle.local-test.config.ts` loads neither dotenv nor `.env.local`.
- **Cold start.** `pg_isready` can succeed against the image's temporary init server. Before migrating, confirm that `docker logs <container>` shows `PostgreSQL init process complete`.
- **Expected `verify-local-db.cjs` result (through 0009):** 40 tables, 20 enums, 83 FKs, 137 indexes, 19 functions, 53 triggers, 10 migrations, with hashes and order verified.
- Never use Neon, production or a retained database for tests. Never point a local proxy or tunnel at a remote database.

### 5.5 Check order (AGENTS.md "Testing and Definition of Done")

1. `npx tsc --noEmit` (covers `src` and `tests/app`)
2. `npm run lint`
3. Targeted tests (`npm run test:app:unit`, or a single `npx vitest run <file>`)
4. `npm run test:db:offline`, then integration, concurrency and `test:app` through the runner
5. The full suite. **Coverage is not configured**: it would need `@vitest/coverage-v8`, which is not an approved dependency.
6. `npm run build` (or `-- --webpack`). The build needs no environment variables.

Report actual results. If a check cannot run, say why and mark the task partially verified.

### 5.6 Application suite (Vitest, `tests/app/`)

- **Config:** `vitest.config.ts`.
  - `@/` resolves to `src/`, and `server-only` is aliased to a no-op stub.
  - Files run sequentially, because the database files share one disposable database and observe real lock waits.
  - `NODE_ENV=test`; the auth configuration explicitly keeps Better Auth's origin and CSRF checks and rate limiting on (ARCHITECTURE.md §8).
- **Unit (282, no database):**
  - Config validation, HTTP layer (origin, errors, bodies, no-store), transaction retry, the auth policy as effective at runtime, the auth log sink, page-guard decisions, onboarding rules and the starter chart (`auth-config`, `config`, `http`, `transaction`, `page-guards`, `onboarding-rules`).
  - Phase 2a: `money` (49), `dates` (39, including daily round trips across 15 timezones and DST), `validation` (66, PII and URL screening), `order-status` (14, every status pair, profit, and zero revenue for cancelled orders), `page-helpers` (15), `api-client` (8), `views` (5, dates shown in the business timezone).
  - `static-guards` (13): T16–T18 plus the data-layer rules (A33).
- **Database-backed (230):** `describe.skipIf` without `LOCAL_TEST_DATABASE_URL`, so they run only through `scripts/local-db.cjs run`.
  - M2 files: `auth-flows`, `tenant-isolation`, `onboarding`, `origin-csrf`, `rate-limit` and `api-routes` (including the real `src/app/api/**/route.ts` files through the composition root).
  - Phase 2a files: `orders` (46), `purchases` (44: draft rules, exact money, confirmation exactly once, parallel and overlapping confirmations with observed lock waits, atomic rollback, immutability, reversal, profit), `catalog` (26, suppliers and products) and `phase2-isolation` (16: every new endpoint and table across tenants) and `profit-ledger-model` (7: random create, confirm, cancel, order-cancel and reverse sequences over six seeds, replayed against an independent `bigint` model after every step, then the ledger balances compared with the same model; mutation-checked) and `cancelled-orders` (18: D9 before and after confirmation, API and service rejection, a draft that cannot be confirmed, tenant isolation of the new data-layer functions, a deterministic lock-order test and a 40-round confirm-versus-cancel race with the deadlock counter checked).
  - Isolation tests were mutation-checked: removing the tenant predicate from the shared scope fails 7 tests, and removing it from one lookup fails 1.
  - Better Auth is driven through its HTTP handler (`tests/app/support/app.ts`), so origin checks and rate limits behave as in production. Each call uses a fresh documentation-range client IP, so only the rate-limit tests share a bucket.
  - Data stays in the disposable database, which is destroyed by `stop`.
- The T1–T19 matrix and the file that covers each case are in ARCHITECTURE.md §7.2.
- **When a test fails, diagnose before blaming the host.** Run `npx vitest run --reporter=json --outputFile=<file>` (through the runner for database tests) and compare the failing test, its duration and the whole run's duration and import time. A failure at normal speed is a real defect in the code or the test; only a run that is many times slower than the usual ~20 s points at the machine. Repeat the suite several times before calling anything fixed.
- **Tamper tests on signed values:** change a digit that carries real bits (for example flip the top bit of a base64 digit). The final character of a base64 signature can contain unused padding bits, and changing only those decodes to the same bytes.

## 6. Migration workflow

**Migrations `0000–0009` are frozen.** Never edit, reorder or regenerate them, and never use `push`. All changes go in new forward-only migrations (`0010+`). `tests/baseline-migrations.json` holds 20 SHA-256 values (SQL and snapshot for each of 0000–0009); `scripts/audit-schema.cjs` and the offline suite fail if any of them changes.

**0009 (`0009_auth_rate_limit`, added and frozen 2026-11-25, ARCHITECTURE.md A24)** creates only the auth-owned `rate_limit` table and its unique `key` index (ARCHITECTURE.md §3, A18). It was validated on a fresh database: full chain, replay no-op, catalog counts, all suites, `drizzle-kit check` and "No schema changes".
- `scripts/audit-schema.cjs` lists `rate_limit` with the other non-tenant auth tables.
- drizzle-kit 0.31 writes snapshot keys in a different nested order than 0.30. Compared with keys canonically sorted, `0009_snapshot.json` differs from `0008_snapshot.json` only by the new table.

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

Upgrade only with owner approval. Before installing, recheck the target versions against the GitHub advisory database and the npm registry (deprecation, peer ranges). Pin exact versions, install with `--ignore-scripts --userconfig /dev/null`, and report any version change npm proposes; never accept one silently. The current pinned set and the reasons for the `overrides` are in ARCHITECTURE.md §8 (A21). Verify:

1. `npm ls --all` exits 0 (no `invalid`, `missing` or `ERESOLVE`), and there is exactly one copy each of `@better-auth/core` and `better-call`. `npm audit --omit=dev` reports nothing for the auth packages. The 4 moderate pre-existing drizzle-kit/esbuild 0.18 findings are documented in ARCHITECTURE.md §8.
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
| `src/app/` | App Router: `/sign-up`, `/sign-in`, `/onboarding`; `/app` with `orders`, `orders/new`, `orders/[orderId]`, `purchases`, `purchases/new`, `purchases/[purchaseId]`, `suppliers` and `products` (a static navigation layout); `api/auth/[...all]` (Better Auth) and `api/v1/{onboarding,business,suppliers,products,orders,purchases}` |
| `src/server/` | Server-only code: `config/`, `db/`, `dal/`, `auth/`, `http/`, `domain/`, `validation/`, `ledger/`, `onboarding/`, `business/`, `suppliers/`, `products/`, `orders/`, `purchases/`, `api/`, `container.ts` (ARCHITECTURE.md §5, §5.1) |
| `src/components/`, `src/lib/` | Minimal accessible Tailwind forms and tables; the Better Auth browser client and JSON API client; pure helpers shared by forms and the server (`money`, `dates`, `validation`, `policy`, `paths`) |
| `src/instrumentation.ts` | Startup configuration validation |
| `src/db/schema.ts`, `src/db/auth-schema.ts` | Drizzle schema; Better Auth model mapping |
| `src/db/sql/` | Maintained custom SQL sources (§6.1) |
| `drizzle/`, `drizzle/meta/` | Migrations 0000–0009, snapshots, journal |
| `drizzle.config.ts` / `drizzle.local-test.config.ts` | Application config / isolated test config |
| `vitest.config.ts` | Application test config (§5.6) |
| `scripts/` | Local database runner, offline audits, catalog verifier |
| `tests/` | `node:test` offline, integration and concurrency suites; `tests/app/` Vitest suites and support; fixtures; helpers; frozen hash manifest |

**Conventions added in this milestone:**
- Every `src/server/**` module (except pure types and helpers) imports `server-only`.
- Only `src/db`, `src/server/{db,dal,auth}` and `src/server/container.ts` may import the database. ESLint and the static guards enforce this.
- API routes use `sessionRoute`/`tenantRoute`; public routes and pages carry a `// public: <reason>` comment.
- No cache directives on session or tenant paths.
- Money is `bigint` at scale 4 (`src/lib/money.ts`), travels as strings, and is never a JavaScript number. Inputs have at most 2 decimals. Never round (PRODUCT.md D3 is open).
- Calendar dates go through `src/lib/dates.ts` and the business timezone, never `new Date('YYYY-MM-DD')` (that is UTC midnight and shifts the displayed day).
- Raw `execute()` results skip Drizzle's column mapping: timestamps arrive as text and must be converted by hand (see `listPurchasesForOrder`). Prefer the query builder.
- Services never import `drizzle-orm`; joins and locks live in the DAL and use `scope.executor` with `tenantEq()` on every table.
- **Lock order (ARCHITECTURE.md A35):** purchase row, then order rows in ID order (`lockOrdersForUpdate`), then the first write. Never lock an order after a write, because the first write takes the tenant lock and a concurrent order change would deadlock against it.
- **Auditing a test database:** order two transactions by their **commit** time, not by `created_at`, `updated_at` or `now()` (those are transaction-start or application clocks and misorder races). `track_commit_timestamp` cannot be switched on in the runner's container (restarting the container destroys its tmpfs data); use a throwaway deferred trigger that records `clock_timestamp()`, which fires while the transaction still holds its locks. Never restart the disposable container: stop it and start a new one.
- Dynamic route handlers use `tenantRoute(handler, { params: schema })`; a malformed ID is answered 404 like a missing one.
- Pages read the session and request data inside `<Suspense>` and call their guard first; the current date is read after that.
- Next.js allows **one `next dev` per project directory**. A second one exits and names the running one; do not kill someone else's server. To exercise the app against a disposable database use `next start` on another port, with `BETTER_AUTH_URL` set to an `https://` origin (production requires https) and the same value sent as `Origin`.

## 9. Conventions and Git

Follow [AGENTS.md](../AGENTS.md): strict TypeScript; validate at the boundary; thin handlers over domain services; server-only code out of client bundles; tests for every changed source file.

Commits are made only when explicitly authorized. Inspect the full staged diff first, and use concise conventional commit messages with no co-author trailers or AI attribution.
