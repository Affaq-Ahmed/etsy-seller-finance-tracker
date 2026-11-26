# Status

**Last updated:** 2026-11-26

This is the baseline progress document: current milestone, completed work, verification results, blockers and next tasks. It is the place for durable progress records; do not create separate handoff or report files (AGENTS.md).

## Current milestone

| Milestone | State |
| --- | --- |
| M1: Database foundation (V1) | **Complete.** Migrations 0000–0008 frozen and integrity verified locally (0009, added in M2, is frozen too). **Not production-certified.** |
| **M2: Authentication and tenant security** | **Implemented and verified locally** (2026-11-25). Tenant isolation is proven by the T1–T19 tests (T11 deferred). Migrations 0000–0009 frozen. **Not deployed:** deployment is blocked until the auth Node host is selected and validated (ARCHITECTURE.md §2.2, C7). |
| **Phase 2a: Orders and supplier purchases** | **Implemented and verified locally** (2026-11-26). Suppliers, products, orders with items, draft purchases, atomic idempotent confirmation, reversal, and profit before expenses and refunds, with UI and API. **No schema change** (0000–0009 untouched). **Uncommitted**, on branch `feat/orders-purchases`. **D5 (refunds are contra-revenue) and D9 (cancelled orders count zero revenue) were decided on 2026-11-26; D9 is implemented, D5 arrives with the refund slice.** Phase 2b (expenses and refunds) is next and waits for the owner's decisions D6 and D10–D13. |

The M1 checkpoint is commit `4625202` (`chore(db): establish verified database baseline`), tagged **`db-baseline-v1`**. The tag exists locally only and has not been pushed. M2 was committed locally on 2026-11-25 (`fb96609`, `feat(auth): …`, branch `feat/auth-tenant-isolation`) and has not been pushed. Phase 2a was built on a new local branch from it and is not committed.

## Completed work

| Date | Work | Result |
| --- | --- | --- |
| 2026-11-24 | Schema audit of the owner's PRD v1.2, System Architecture v1.1 and ERD v1.1 | Fixed invalid composite FK targets, mutable finalized ledger, editable confirmed purchases, missing caps and uniqueness, nullable tenant IDs and cascades. Initial model of 35 tables (migrations 0000–0001) |
| 2026-11-24 | Financial hardening | Account roles, standard source leg rules, declared instructions, atomic reversals, manual shipments and events. 39 tables, 83 FKs (0002–0006); ERD updated to v1.2 |
| 2026-11-24 | Integrity follow-up | Shipment creation-date floor; adjustments rejected against reversed originals; complete notes audit (0007) |
| 2026-11-24 | First local PostgreSQL validation | Found one trigger defect: negative non-deposit Payoneer transactions hit the reconciliation cap. Fixed forward in 0008; regression added |
| 2026-11-24 | Independent re-verification on a fresh disposable database | All M1 results reproduced; 0008 proven to be the fix |
| 2026-11-24 | Research: auth versions, Cloudflare runtime, auth design | Recorded as proposals; superseded by the 2026-11-25 decisions (ARCHITECTURE.md §9) |
| 2026-11-25 | Baseline committed and pushed to `main` (`4625202`, `9373cd2`); AGENTS.md restructured (`b7dcf81`) | Pushed history scanned: no secrets |
| 2026-11-25 | Documentation consolidated into PRODUCT, ARCHITECTURE, DEVELOPMENT and STATUS; owner reference docs kept unchanged | This document set; committed by the owner as `ba80a22` |
| 2026-11-25 | Owner attested the machine safe for the M2 work; Docker started | Local checks (these do **not** establish that the machine is clean): hooks path default with no active hooks; lockfile 100% registry.npmjs.org with integrity hashes. **Superseded 2026-11-26** by the security gate below |
| 2026-11-26 | **Security gate.** The owner stated that this Mac had a confirmed malware persistence incident. Remediation has not been confirmed, so the machine is **not** treated as trusted: no Git network operations (fetch, pull, push), no credential use, no installations and no deployment from it until the owner explicitly confirms remediation | Applies to every task. Work since the M2 attestation used only local operations plus unauthenticated reads of registry.npmjs.org and api.github.com and `npm install --ignore-scripts --userconfig /dev/null` (no credentials sent, no install scripts run) |
| 2026-11-25 | Owner decisions C1–C5, D1 (option B), the T15 approach, dependency pins, onboarding, sessions, UI and the deferrals | ARCHITECTURE.md A15–A23 |
| 2026-11-25 | Dependencies pinned and installed (`--ignore-scripts --userconfig /dev/null`) | better-auth/drizzle-adapter 1.7.25, drizzle-orm 0.45.4, drizzle-kit 0.31.11, postgres 3.4.9, zod 4.6.7, vitest 4.1.12, vite 7.3.8, plus owner-approved `overrides`: `@better-auth/core` 1.7.25, `better-call` 1.4.5, and `vite` → `$vite` so vitest uses vite 7.3.8 (ARCHITECTURE.md §8) |
| 2026-11-25 | Forward migration **0009** `rate_limit` | Auth-owned table for database rate limiting; validated on a fresh database; **frozen** by owner approval (hashes in `tests/baseline-migrations.json`, A24) |
| 2026-11-25 | M2 implementation | Better Auth integration; sign-up, sign-in, sign-out; server-side session and tenant resolution; `requireSession`/`requireTenant`/`requireOnboardingSession`; idempotent transactional onboarding; tenant-scoped data access layer; config module and composition root; minimal accessible forms; ESLint and static guards; 156 Vitest cases |
| 2026-11-26 | Phase 2a plan reviewed; owner decisions 1–12 and the D3 interim approved | ARCHITECTURE.md A25–A33; PRODUCT.md decision log |
| 2026-11-26 | Phase 2a implementation | Money, date and PII helpers; 8 new DAL modules; supplier, product, order and purchase services; ledger posting and reversal; 10 API routes; 8 pages with accessible forms; Supplier Payable in the starter chart; static guards extended. 331 new Vitest cases (487 in total) |
| 2026-11-26 | Phase 2a final review | Fixed: purchase page showed the confirmation date in UTC instead of the business timezone; the cancel dialog advised an action the UI does not offer; **a flaky M2 test** (diagnosed below). Added: a model-based test that replays random purchase sequences against an independent `bigint` model and checks the ledger balances (4 seeds, mutation-checked), and view-mapping tests. Recorded as owner decisions rather than invented: D9 (cancelled orders), D10–D13 (Phase 2b). Corrected AGENTS.md (migrations 0000–0009 frozen) and this document's security record |
| 2026-11-26 | **D9 fix and D5 decision** | A cancelled order counts zero Etsy revenue; confirmed costs stay; new purchases on cancelled orders are rejected at the API and the service; a draft that covers a cancelled order cannot be confirmed; nothing is reversed automatically. Orders are locked before the first write (A35), which also removed a confirm-versus-cancel deadlock the first version had. D5 recorded as option A (A34); the account itself arrives with the refund slice. No schema change, no migration. 18 new database cases, 4 new unit cases, the model test extended; 5 UI files adjusted (ARCHITECTURE.md A34, A35) |

## Verification results

### 2026-11-26 (Phase 2a), PostgreSQL 18.6, fresh disposable loopback Docker container

| Check | Result |
| --- | --- |
| Schema, migrations, maintained SQL, frozen manifest | **Unchanged** (`git status` clean for `src/db`, `drizzle/`, `tests/baseline-migrations.json`). Offline audit: 40 tables, 83 FK targets |
| `drizzle-kit check` / `generate --name=verify_no_drift` | "Everything's fine" / "No schema changes"; nothing written under `drizzle/` |
| `verify-local-db.cjs` | 40 tables, 137 indexes, 19 functions, 53 triggers, 10 migrations; hashes and order verified |
| `npm run test:db:offline` / `integration` / `concurrency` | **8/8**, **71/71**, **12/12** |
| `npm run test:app` (through the runner) | **487/487** in 25 files at the end of Phase 2a (unit 278, database-backed 209), five consecutive clean runs. **512/512 after the D9 change**, see the next table |
| `npx tsc --noEmit` / `npm run lint` | Exit 0 / exit 0 |
| `npm run build` | Succeeds without environment variables. 10 new API routes dynamic; 8 new pages partial prerender |
| Mutation check of the isolation tests | Removing the tenant predicate from the shared scope fails 7 tests; removing it from one lookup fails 1; both files restored byte for byte |
| HTTP smoke test of the real production server (`next start`, disposable database; ad hoc script, not committed) | **29/29**: sign-up, sign-in, onboarding, every page renders with real data, create supplier, product, order and draft purchase, confirm twice (idempotent), profit 74.75 and status SUPPLIER ORDERED, reverse, profit back to 100.00, corrected-purchase link, 404 pages, cross-origin write 403, anonymous API 401, no private content for anonymous page requests |

### 2026-11-26 (D9 change), PostgreSQL 18.6, disposable loopback Docker containers

| Check | Result |
| --- | --- |
| Schema, migrations, frozen manifest | **Unchanged.** `git status` shows no change under `drizzle/`, `src/db`, `tests/baseline-migrations.json`, `scripts`, `package.json`, `package-lock.json`; 20/20 SHA-256 hashes match. `drizzle-kit check` "Everything's fine"; `generate --name=verify_no_drift` "No schema changes" (nothing written). No migration 0010 |
| `verify-local-db.cjs` (fresh container) | 40 tables, 20 enums, 83 FKs, 137 indexes, 19 functions, 53 triggers, 10 migrations; hashes and order verified |
| `npx tsc --noEmit` / `npm run lint` / `npm run build` | Exit 0 / exit 0 / exit 0, run again on the final files |
| `npm run test:db:offline` / `integration` / `concurrency` | **8/8**, **71/71**, **12/12**, on the first container and again on the rebuilt one |
| `npm run test:app` (through the runner) | **512/512** in 26 files (unit 282, database-backed 230): three consecutive runs on the first container (21.9, 22.1, 22.6 s) and one on the rebuilt container (21.7 s). The two D9 suites alone (25 cases) passed on five further runs |
| Mutation checks (each restored byte for byte) | Removing the create/edit cancelled check fails 4 cases; removing the confirm check fails 1; not zeroing revenue fails 7; locking orders after the first write fails the deterministic lock test; the model test fails 7 of 7 under both a profit and a creation mutation |
| Deadlock evidence | Before the fix the confirm-versus-cancel race deadlocked once in 60 rounds (orders locked after the first write). After: 0 in 180 rounds, and 0 again on the rebuilt container over the full app suite plus two more runs of the D9 suites (Postgres counter reset first; the log has no "deadlock detected"). The baseline `concurrency` suite contains one **deliberate** deadlock (`real two-connection deadlock retries the victim transaction`) and adds exactly one per run |
| SQL audit of the data of those runs | The 15 earlier checks: **0 violations** (36 tenants, 284 orders of which 185 cancelled, 253 purchases of which 72 confirmed). New D9 check ordered by **commit time**: 39 pairs of a confirmed purchase and a cancelled order, **all 39 confirmed before the cancellation, 0 confirmed after, 0 without a clock**, and **0 automatic reversals**. Negative control: with the confirm check disabled the same query reports 41 violations and one test fails |
| HTTP smoke test of the production server (`next start`, disposable database, ad hoc script, not committed) | **28/28**: cancel an order that has a confirmed purchase (recorded 100.00 shown as not counted, revenue 0.00, cost 20.00 kept, loss −20.00, purchase still confirmed); 422 `ORDER_CANCELLED` naming `lines.0.orderItemId` and nothing created; a draft on a cancelled order answers 409 and stays a draft, its page says "Cannot be confirmed" with no Confirm button; the purchase form warns and the order chooser lists only open orders; re-confirming is a no-op; an explicit reversal brings profit back to 0.00 |

**Audit findings investigated during this verification (none is a product defect).**
- **41 "confirmed after cancelled" hits in the first audit.** They were most probably the remains of my own M2 mutation run (confirm check disabled), which leaves exactly 1 + 40 violating purchases (one deterministic case and 40 race rounds); the same mutation run reproduced that signature, and the correct code produced 0 in three runs. The old database was destroyed before I could re-inspect it, so this is a strong inference, not proof. My first guess (clock skew) was wrong. The check was replaced by one that orders by commit time.
- **1 purchase posting to PAYONEER and 1 confirmed purchase without a CONFIRM audit row.** Both belong to the baseline raw-SQL fixture (`tests/helpers/financial-fixture.cjs`, shop "Test shop", zero audit rows): the baseline suites write the ledger directly, and the database accepts a purchase posted to any asset. The earlier audit passed only because those suites had not run in that database. Restricted to tenants created through the application, both checks are 0.
- **2 deadlocks in the Postgres counter**: one from the pre-fix code, one from the deliberate baseline test (see above).
- **I restarted the disposable container to enable commit timestamps and destroyed its data** (the runner mounts the data directory on tmpfs). Nothing real was affected, but the first audit's data was lost; I rebuilt through the runner and recorded the rule in DEVELOPMENT.md.
- **Coverage limit of the race test.** In 120 audited rounds the cancellation always won (the confirm was refused); the "confirm commits first" interleaving is covered by the deterministic tests and the lock-order test, not by the race itself.

**Intermittent failures: diagnosed in the 2026-11-26 review.** Two different causes, one proven and one not.
- **Proven: a defect in an M2 test, not a product defect.** `auth-flows > T8 > rejects a valid token with a tampered signature` flipped the second-to-last character of the 44-character base64 session signature. That character holds 2 unused padding bits, so when it was `A` the replacement `B` decoded to the *identical* signature and the cookie was (correctly) accepted. Measured over 120 fresh sessions: the old test logic failed in 8, every one with `A` there (expected rate 1 in 16); it also failed in 2 of 12 repeat runs, at normal speed and with no load. Accepting a different encoding of the same signature creates no new valid signature, so it is not a forgery path. The test now flips the top bit at five significant positions and also rejects truncated, extended and empty signatures and a token without a signature: **0 of 720 tamper variants were accepted**, and five consecutive full runs passed. The earlier uncaptured failure was most probably this test, but that was not proven.
- **Not proven: one 30 s timeout** in `orders > retrieves it by ID and in the list`, during a run that took 524 s instead of about 20 s (module imports alone took 287 s) while macOS background daemons held the CPUs. In 14 uncontended runs the slowest test took 0.53 s, a Postgres monitor recorded **no lock wait over 3 s and no transaction idle over 5 s**, and Postgres reported 0 deadlocks. That rules out a lock or logic defect as far as these runs can show; the timing signature points to a host stall, but the stall was not reproduced or measured. If a timeout recurs, run `vitest run --reporter=json --outputFile=<file>` and compare the run's total duration and import time first.
- **Financial invariants audited in SQL** over the data of those runs (1,065 orders, 1,287 purchases, 938 journal entries, 8,771 audit rows): 15 checks, all zero violations (every finalized entry balanced; exactly one INITIAL posting per confirmed purchase, equal to its total and dated at the purchase date; each posting exactly DEBIT supplier cost / CREDIT Supplier Payable and never PAYONEER; every reversal the exact opposite of its original and at most one per original; quantity × unit cost = line total; one CONFIRM and one REVERSE audit row each; no order postings; no cross-tenant lines).

**Not verified:** a real-browser run (Playwright is deferred; React components have no unit tests because jsdom and Testing Library are not approved dependencies, so forms are covered by the HTTP smoke test and the shared helpers' tests); Workers, OpenNext, Hyperdrive, Neon and any auth host; performance at volume (confirmation serializes per tenant by design, measure before production).


### 2026-11-25 (M2), PostgreSQL 18.6, fresh disposable loopback Docker container

| Check | Result |
| --- | --- |
| Pre-install recheck of the pinned versions (GitHub advisories, npm registry) | No advisory affects any pin; none deprecated; peer ranges compatible |
| `npm ls --all` | Exit 0. One copy each of `@better-auth/core` 1.7.25 and `better-call` 1.4.5; vitest uses vite 7.3.8 |
| `npm audit --omit=dev` | 4 moderate, **pre-existing** (esbuild 0.18.20 under drizzle-kit's `@esbuild-kit`, GHSA-67mh, dev server only; identical in the committed baseline lockfile); 0 high or critical; nothing in the auth packages |
| Lockfile | 661 entries, all from registry.npmjs.org, all with integrity hashes |
| Baseline gate before 0009 (new drizzle-orm/drizzle-kit): migrate 0000–0008, replay, catalog | 39 tables, 135 indexes, 9 migrations, hashes verified; integration 71/71; concurrency 12/12; `drizzle-kit check` passed; "No schema changes" |
| Full chain 0000–0009 on a fresh database; replay | Applied; replay is a no-op |
| `verify-local-db.cjs` | 40 tables, 20 enums, 83 FKs, 137 indexes, 19 functions, 53 triggers, 10 migrations; hashes and ordering verified |
| `drizzle-kit check` / `generate --name=verify_no_drift` | "Everything's fine" / "No schema changes". `drizzle/` changes: only the 0009 SQL, the 0009 snapshot and one appended journal entry |
| Frozen manifest | 18/18 SHA-256 match (0000–0008) before the freeze; **20/20** (0000–0009) after adding 0009 |
| `npm run test:db:offline` | **8/8** |
| `npm run test:db:integration` | **71/71**, 0 skipped |
| `npm run test:db:concurrency` | **12/12**, 0 skipped |
| `npm run test:app` (through the runner) | **156/156** in 13 files: unit 83 (auth-config 7, config 14, http 23, onboarding-rules 20, page-guards 4, static-guards 11, transaction 4); database 73 (api-routes 9, auth-flows 19, onboarding 14, origin-csrf 10, rate-limit 6, tenant-isolation 15) |
| `npm run test:app` without a test database | 83 passed, 73 skipped (as designed) |
| `npx tsc --noEmit` / `npm run lint` | Exit 0 / exit 0. A probe file confirmed the import-boundary rule fires; it was then deleted |
| `npm run build` (no environment variables) | Succeeds. API routes dynamic; `/app` and `/onboarding` are partial prerenders; `/sign-in` and `/sign-up` are static |
| Password hashing (installed Better Auth hasher, Node 26.10.0, Apple M4, 30 runs) | Hash CPU p50 43.8 ms (p95 44.4); verify p50 43.9 ms (p95 45.6); 4 concurrent: 59.7 ms wall, 150.5 MiB RSS |

**Security tests T1–T19:** all pass except **T11**, which is deferred (password reset out of scope until PRODUCT.md D2; the revocation option is configured and asserted). The case-by-case table is in ARCHITECTURE.md §7.2.

**Not verified:**
- Cloudflare Workers, OpenNext, Hyperdrive, Neon, and any auth Node host. Nothing has been deployed (owner decision A23).
- A browser end-to-end run of the forms; Playwright is deferred.
- Coverage, which is not configured.
- Production PostgreSQL, the runtime role and RLS.
- Throughput and volume.

### 2026-11-24 (M1), PostgreSQL 18.6, disposable loopback Docker container

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

## Blockers and open decisions

| # | Item | Where |
| --- | --- | --- |
| B1 | **Auth Node host not selected.** Before deployment, verify its free terms allow a commercial SaaS, plus reliability, cold starts and resource limits (≥ ~32 MiB per concurrent hash). Configure the trusted client-IP header and restrict the host to Worker traffic | ARCHITECTURE.md §2.2, §8, C7 |
| B2 | **Deployment adapter:** per-request container on Workers, the Worker proxy for `/api/auth/*`, Hyperdrive with caching disabled, Neon role and grants. All unverified | ARCHITECTURE.md §2.1, §5, A23 |
| B4 | Free email provider (D2), needed for password reset (T11) and email verification (full enumeration mitigation) | PRODUCT.md §9; ARCHITECTURE.md §7.2 |
| B5 | ~~REFUND representation (D5)~~ **Resolved 2026-11-26 (option A, contra-revenue INCOME "Etsy Refunds")**. The account is added to the starter chart, and lazily for existing businesses, with the customer-refund slice | PRODUCT.md §8; ARCHITECTURE.md A34 |
| B6 | Currency rounding rules (D3) before any FX or reporting logic | PRODUCT.md §9 |
| B7 | Worker bundle size limit (C6) | ARCHITECTURE.md §10 |
| B8 | **D7:** how supplier payments settle Supplier Payable (Phase 3). Confirm the proposed explicit-legs approach before importing Payoneer statements | PRODUCT.md §9; ARCHITECTURE.md A25 |
| B9 | **D8:** when orders post their INITIAL journal (Phase 3). Historical orders must then be posted idempotently | PRODUCT.md §9; ARCHITECTURE.md A27 |
| B10 | **Phase 2b decisions still open:** D6 (refund cap), D10 (expense credit account and the Payoneer-fee category), D11 (customer refund credit side, FULL/PARTIAL, order status), D12 (refund adjustments), D13 (supplier refunds). D5 and D9 are resolved. Nothing in Phase 2b may start before the owner decides the ones its slice needs | PRODUCT.md §9 |
| B11 | **Security gate:** the owner reports a confirmed malware persistence incident on this Mac. Until the owner confirms remediation: no Git network operations, no credentials, no installs, no deployment. Review and re-test the code on a trusted machine before anything is pushed | AGENTS.md "Environment and Security Safety" |

## Next tasks

1. **Owner review**, then authorization to commit Phase 2a (no co-author or AI attribution, per AGENTS.md) and to merge `feat/auth-tenant-isolation` and `feat/orders-purchases` to `main` and push.
2. **Phase 2b: expenses and refunds.**
   - Order and shared expenses, customer refunds (D5 decided; the *Etsy Refunds* account arrives with this slice) and supplier refunds, through new DAL modules with cross-tenant tests. Each new tenant table leaves the T16 "not exposed" list.
   - Supplier refunds must subtract refund amounts in `dal/order-profit.ts` (purchases in refunded statuses are currently counted at full cost), and add expenses and refunds to the profit view, whose flags are currently `false`.
   - Deferred Phase 2a UI: an order edit form (the API exists), purchases covering several orders in one form (the API accepts them), and editing a draft purchase in the UI (the API exists).
   - Optional hardening to decide: a database CHECK for supplier marketplaces; a database constraint that a purchase line's total equals quantity × unit cost (needs migration 0010).
3. **Phase 3: payout operations.**
   - Eligibility jobs (configurable delay and weekday from `account_settings`); expected batches; actual payouts and allocations.
   - Payoneer import with duplicate review and principal/fee conventions; reconciliation.
   - USD → PKR withdrawals; realized FX reporting (after D3).
   - Done when the full PRD §10 lifecycle passes end to end with balanced ledgers.
4. **Phase 4: shipment operations.** Multiple manual shipments, event timeline and metadata edits, operational alerts via idempotent jobs. Shipment delivery never sets order delivery.
5. **Phase 5: frontend.** shadcn/ui setup, then dashboard, orders, products and suppliers, expenses, payouts, Payoneer, shipments, reports (order-date and cash-date), CSV/Excel export, and Playwright. Read the Next.js 16 docs in `node_modules/next/dist/docs/` first.
6. **Deployment milestone:** resolve B1, B2 and B7; measure Worker CPU for session checks and the proxy.
7. **Before production:**
   - Re-run the full chain and suites on the production PostgreSQL major version.
   - Validate the runtime role and grants (and RLS if adopted), Hyperdrive transactions with caching disabled, Worker bundle size, backup and restore.
