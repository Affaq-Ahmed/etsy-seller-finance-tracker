# Status

**Last updated:** 2026-11-25

This is the baseline progress document: current milestone, completed work, verification results, blockers and next tasks. It is the place for durable progress records; do not create separate handoff or report files (AGENTS.md).

## Current milestone

| Milestone | State |
| --- | --- |
| M1: Database foundation (V1) | **Complete.** Migrations 0000–0008 frozen and integrity verified locally. **Not production-certified.** |
| **M2: Authentication and tenant security** | **Implemented and verified locally** (2026-11-25). Tenant isolation is proven by the T1–T19 tests (T11 deferred). Migrations 0000–0009 frozen. **Not deployed:** deployment is blocked until the auth Node host is selected and validated (ARCHITECTURE.md §2.2, C7). |

The M1 checkpoint is commit `4625202` (`chore(db): establish verified database baseline`), tagged **`db-baseline-v1`**. The tag exists locally only and has not been pushed. M2 was committed locally on 2026-11-25 (`feat(auth): …`, branch `feat/auth-tenant-isolation`) and has not been pushed.

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
| 2026-11-25 | Environment confirmed trusted by the owner; Docker started | Local checks: hooks path default with no active hooks; lockfile 100% registry.npmjs.org with integrity hashes |
| 2026-11-25 | Owner decisions C1–C5, D1 (option B), the T15 approach, dependency pins, onboarding, sessions, UI and the deferrals | ARCHITECTURE.md A15–A23 |
| 2026-11-25 | Dependencies pinned and installed (`--ignore-scripts --userconfig /dev/null`) | better-auth/drizzle-adapter 1.7.25, drizzle-orm 0.45.4, drizzle-kit 0.31.11, postgres 3.4.9, zod 4.6.7, vitest 4.1.12, vite 7.3.8, plus owner-approved `overrides`: `@better-auth/core` 1.7.25, `better-call` 1.4.5, and `vite` → `$vite` so vitest uses vite 7.3.8 (ARCHITECTURE.md §8) |
| 2026-11-25 | Forward migration **0009** `rate_limit` | Auth-owned table for database rate limiting; validated on a fresh database; **frozen** by owner approval (hashes in `tests/baseline-migrations.json`, A24) |
| 2026-11-25 | M2 implementation | Better Auth integration; sign-up, sign-in, sign-out; server-side session and tenant resolution; `requireSession`/`requireTenant`/`requireOnboardingSession`; idempotent transactional onboarding; tenant-scoped data access layer; config module and composition root; minimal accessible forms; ESLint and static guards; 156 Vitest cases |

## Verification results

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
| B5 | REFUND representation (D5) before the refunds milestone; the starter chart omits REFUND until then | PRODUCT.md §9 |
| B6 | Currency rounding rules (D3) before any FX or reporting logic | PRODUCT.md §9 |
| B7 | Worker bundle size limit (C6) | ARCHITECTURE.md §10 |

## Next tasks

1. **Owner review** of the `feat/auth-tenant-isolation` commit, then merge to `main` and push when authorized.
2. **Phase 2: financial services.**
   - Account initialization; orders; suppliers and products; supplier purchase confirmation.
   - Atomic journal posting with stable event keys and whole-transaction retries (`runInTransaction`), through new DAL modules with cross-tenant tests. Each new tenant table leaves the T16 "not exposed" list.
   - Expenses; refunds (after D5); immutable corrections and reversals.
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
