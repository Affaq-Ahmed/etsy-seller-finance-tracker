# Authentication and Tenant Security Plan

**Date:** 2026-11-24
**Status:** PLAN ONLY. Not implemented. Implementation starts only after this plan, [Better_Auth_Compatibility_Review.md](Better_Auth_Compatibility_Review.md) and [Cloudflare_Compatibility_Review.md](Cloudflare_Compatibility_Review.md) are approved.
**Scope:** PRD v1.2 §3.1 (authentication), §2 (one owner per account, strict isolation), §8 (secure multi-tenancy); Application Development Handoff Phase 1.

## Non-negotiable rule

> **Tenant identity comes only from the authenticated server-side session.** Tenant IDs in request bodies, query strings, headers, cookies other than the session cookie, route params, or client-side checks are never trusted. A user can never read, modify, delete or create data in another tenant.

The database already rejects cross-tenant **references** on writes (composite FKs). It does **not** restrict **reads**. Read isolation is entirely the application's job until a reviewed RLS migration exists.

---

## 0. Entry criteria (all required before coding)

1. The workstation is verified clean and exposed credentials are rotated (local security investigation). *Status 2026-11-25: known artifacts confirmed removed and hooks globally disabled; owner reports remediation complete.*
2. The database baseline commit exists. *Done 2026-11-25 as commit `4625202` on branch `chore/db-baseline`, not pushed.* The GitHub repository is currently **public**: make it private before any push, or explicitly accept publishing the PRD and architecture documents.
3. The dependency set from the compatibility review (Combination B) is installed on the clean machine, and all its verification tests pass, especially the drizzle-kit no-drift gate.
4. **The password-hashing decision gate is resolved** (Cloudflare review §4.3): measured as viable on Workers Free, or an approved alternative.
5. The Better Auth 1.7.x auth-table manifest has been compared with `src/db/auth-schema.ts`. Any gap ships as forward migration `0009`.

---

## 1. Better Auth integration

| File (proposed) | Responsibility |
| --- | --- |
| `src/server/db.ts` (`import 'server-only'`) | `getDb()`: a Drizzle client over postgres.js. Local: `DATABASE_URL`. Workers: `env.HYPERDRIVE.connectionString`, a client per request, `max: 5`, never `prepare: false`. |
| `src/server/auth/auth.ts` (`server-only`) | The `betterAuth({...})` instance. |
| `src/app/api/auth/[...all]/route.ts` | `export const { GET, POST } = toNextJsHandler(auth)` |
| `src/lib/auth-client.ts` | `createAuthClient()` from `better-auth/react`; UI convenience only, never authority. |
| `src/server/auth/session.ts`, `tenant.ts` (`server-only`) | `getSession()`, `requireSession()`, `requireTenant()` (§6) |
| `src/server/dal/**` (`server-only`) | The **only** code allowed to import `getDb()` for tenant data (§7). |

Configuration (target values; confirm each option name against the pinned version):

- `database: drizzleAdapter(db, { provider: 'pg', schema: betterAuthSchema, usePlural: false, transaction: true })`. Keep default text IDs and `experimental.joins: false`. Never map auth `account` to `business_accounts`. (Auth `account.account_id` is a provider identity, **not** a tenant.)
- `secret`: `BETTER_AUTH_SECRET`, at least 32 random bytes, server-only. `baseURL`: `BETTER_AUTH_URL`. `trustedOrigins`: an exact list (`workers.dev` URL, local dev).
- `emailAndPassword`:
  - `enabled: true`, `minPasswordLength: 12`, `maxPasswordLength: 128`, `autoSignIn` as decided below.
  - `revokeSessionsOnPasswordReset: true`.
  - `password.{hash,verify}` only as decided by the hashing gate.
  - `requireEmailVerification` is deferred until free email delivery is confirmed (PRD §3.1).
- `plugins: [nextCookies()]`, which must be the **last** plugin. **No** magic-link, OAuth, SSO, admin, organization or other plugins in V1.
- Cookies: `httpOnly`, `secure` (`advanced.useSecureCookies: true` in production), `sameSite: 'lax'`, `__Secure-` prefix in production.
- **Rate limiting:** memory storage is per-isolate and ineffective on Workers. Choose between database storage (requires a reviewed `0009` table and ≥ 1.7.7 for GHSA-44jh) and Cloudflare's free-plan rate-limiting rule. **Decision needed.**

## 2. Signup and login

- Use Server Action forms with Zod validation and `useActionState` (Next 16 auth guide). Actions call `auth.api.signUpEmail` / `signInEmail` with `headers: await headers()`.
- **Direct `auth.api` calls skip Better Auth's CSRF and `trustedOrigins` checks** [Documented]. Server Actions get Next's built-in Origin/Host comparison. Additionally assert that `Origin` is in `trustedOrigins` in a shared `assertSameOrigin()` helper, and never accept a `callbackURL` or `redirectTo` from input without allow-listing.
- **Generic errors:** "Invalid email or password". There are no account-enumeration differences between an unknown email and a wrong password. Sign-up of an existing email returns a neutral response.
- Normalize email (trim, lower-case) before calling auth.
- Audit log entries: `auth.sign_up`, `auth.sign_in`, `auth.sign_out`, `auth.password_reset`. Failed sign-ins are counted for rate limiting only, with no PII beyond the user ID. `audit_logs` requires the `(account_id, user_id)` owner pair, so pre-onboarding events need a decision: skip them, or log after onboarding.

## 3. Session management

- **Database sessions** (Better Auth `session` table): `expiresIn` 7 days, `updateAge` 1 day (to be confirmed).
- **Cookie cache disabled** (or `maxAge` ≤ 60 s if CPU or queries force it). A cached session keeps working after revocation until the cache expires, which is unacceptable for a financial app by default.
- Session lookup happens once per request, memoized with React `cache()` inside `getSession()`.
- **Next 16 Cache Components are enabled in this project:**
  - Never place `cookies()`, `headers()` or session lookups inside a `'use cache'` scope.
  - Never cache tenant data in a shared or global cache entry.
  - Any cached tenant-scoped function must take the tenant ID as an explicit cache key and be reviewed. The V1 default is **no caching of tenant data**.
- RSCs cannot set cookies; session refresh happens via Route Handlers or Server Actions (`nextCookies()`).

## 4. Tenant onboarding

- After the first successful sign-in, `requireTenant()` finds no `business_accounts` row for the user and redirects to `/onboarding`. It never auto-creates a tenant implicitly inside arbitrary requests.
- `completeOnboarding(input)` is a Server Action that calls `requireSession()` and then, in **one transaction**:
  1. `business_accounts` (`owner_user_id = session.user.id`; shop name; base currency `USD`).
  2. `account_settings` (eligibility: delivered + 14 days; Monday payout weekday; both configurable).
  3. A starter chart of `financial_accounts` with **explicit `account_role`s**: `ETSY_RECEIVABLE`, `ETSY_PAYOUT_CLEARING`, `PAYONEER`, `TRANSFER_CLEARING` (**USD and PKR**), `BANK` (PKR), `SUPPLIER_COST`, `DIRECT_EXPENSE`, `SHARED_EXPENSE`, `REVENUE` and `REFUND` (one representation chosen). Never `UNCLASSIFIED`.
- **Idempotency:** the unique `business_accounts_owner_uq` index means a concurrent or retried onboarding gets `23505`, which is treated as "already onboarded" and returns the existing tenant. Retry the whole transaction on `40001`/`40P01`.
- V1 allows one business per user (PRD §2; enforced by the unique index). There is no tenant switching.

## 5. Session-derived tenant identification

```ts
// src/server/auth/tenant.ts (illustrative, not implemented)
import 'server-only';
export type TenantId = string & { readonly __brand: 'TenantId' };
export interface TenantContext { readonly userId: string; readonly accountId: TenantId }

export const requireTenant = cache(async (): Promise<TenantContext> => {
  const session = await requireSession();            // 401 / redirect('/sign-in') if absent, expired or invalid
  const row = await db.select({ id: businessAccounts.id })
    .from(businessAccounts)
    .where(eq(businessAccounts.ownerUserId, session.user.id))
    .limit(1);
  if (!row[0]) redirect('/onboarding');              // authenticated, not yet onboarded
  return { userId: session.user.id, accountId: row[0].id as TenantId };
});
```

- `TenantId` is a **branded type** that only `requireTenant()` can mint, so a DAL function cannot be called with a raw string from input.
- There is no parameter, header or cookie that selects a tenant. The mapping is `session.user.id → business_accounts.owner_user_id`, and nothing else.

## 6. `requireTenant()` contract

| Situation | Result |
| --- | --- |
| No session cookie | Page: `redirect('/sign-in')`. Action or route: `401` with a generic body. |
| Invalid, tampered or unsigned cookie | Same as no session. |
| Expired session (`expires_at` in the past) | Same as no session; the cookie is cleared via Route Handler or Action. |
| Session revoked (signed out, password reset) | Same as no session. |
| Valid session, no business account | `redirect('/onboarding')`, or `409` for API calls. |
| Valid session and business account | Returns `{ userId, accountId }`, memoized per request. |

## 7. Server-side authorization: Data Access Layer

- Every tenant-owned read or write goes through `src/server/dal/<entity>.ts`. Each function **takes `ctx: TenantContext` as its first argument** and applies `eq(table.accountId, ctx.accountId)` in **every** `WHERE`, including UPDATE, DELETE and joins. Child lookups also join on `account_id`.
- **Not-found, not forbidden:** an ID that exists in another tenant returns exactly the same response as a non-existent ID (404 / `null`). Existence must not leak.
- **Inserts:** `account_id` is always set from `ctx.accountId` and never from input. Referenced parent IDs (order, supplier, financial account, payout) are pre-checked through the DAL, and composite FKs are the backstop. Map FK, check, unique and trigger errors (`23503`, `23514`, `23505`, `P0001`) to 4xx responses with generic messages, never 500s with SQL text.
- Financial writes follow the handoff ground rules: one transaction, stable event keys, whole-transaction retry on `40001`/`40P01`, success only after COMMIT.
- `business_accounts` and `account_settings` are accessed only via `ownerUserId = ctx.userId` and `accountId = ctx.accountId` respectively.
- DB functions such as `reverse_journal_entry(tenant, …)` are only ever called with `ctx.accountId`.
- **Defense in depth (later, a separate approval):** a least-privilege runtime role (no TRUNCATE, no trigger DDL), then optional RLS with **transaction-local** `set_config('app.account_id', …, true)`, which is required under Hyperdrive transaction pooling. Either one ships as a new forward migration with tests.

## 8. Cross-tenant isolation mechanics

- **Input schemas** (Zod `.strict()`) **must not contain `accountId`, `account_id`, `tenantId` or `ownerUserId`**. Unknown keys are rejected, so forged tenant fields fail validation instead of being silently ignored.
- **Static guards (CI):**
  - No import of `getDb` or `src/db/schema` tables outside `src/server/dal`, `src/server/auth` and migrations or tests.
  - No `searchParams`, `params`, header or cookie read named like a tenant identifier.
  - Every `'use server'` export and every `route.ts` handler calls `requireTenant()` or `requireSession()`, or carries an explicit `// public:` annotation (auth endpoints, health check).
- **Meta-test:** enumerate the **34 tenant-scoped tables** from the latest Drizzle snapshot (tables with tenant `account_id`; excludes auth `account`, whose `account_id` is a provider ID) and assert each one has a DAL module and a registered cross-tenant test. A new table without tests fails CI.

## 9. Protected routes and Server Actions

- **Layouts are not a security boundary.** Each protected page, action and route handler calls `requireTenant()` itself.
- `src/app/(app)/**` holds authenticated pages. `src/app/(auth)/**` holds sign-in, sign-up and reset; these redirect to `/dashboard` if a session exists.
- **`proxy.ts` (optional):** cookie-presence redirect only (`getSessionCookie`); never authorization (Next 16 docs; Better Auth docs: "THIS IS NOT SECURE"). OpenNext support for Node proxy is experimental, so the app must be secure without it.
- **Server Actions:**
  - Treat every action as a public POST endpoint.
  - Validate input with Zod.
  - `requireTenant()` comes first.
  - Return no data beyond what the caller is allowed to see.
  - Never return raw DB errors.
- Do not pass tenant-scoped data into Client Components beyond what is rendered.

## 10. Logout and session invalidation

- Sign-out is a Server Action calling `auth.api.signOut({ headers })` with `nextCookies()`. It deletes the session row and clears the cookie, then redirects to `/sign-in`.
- "Sign out of all devices" revokes all of the user's sessions.
- A password reset or change revokes the other sessions (`revokeSessionsOnPasswordReset`, `revokeOtherSessions`).
- With the cookie cache disabled, an old cookie is rejected **immediately** after revocation; this is tested.

## 11. Authentication and tenant security tests

**Harness.** Node's built-in test runner plus the existing disposable local PostgreSQL runner (`scripts/local-db.cjs`). Use two synthetic tenants (A, B), each with a full set of rows for every entity. There are three layers:

- **L1 DAL:** call DAL functions with forged contexts.
- **L2 Actions and Routes:** invoke handlers with real Better Auth sessions created via sign-up in the test DB.
- **L3 HTTP:** a `next build && next start` smoke run against the local test DB.

| # | Test | Expected |
| --- | --- | --- |
| T1 | **Cross-tenant SELECT.** As A, list each entity, and fetch each of B's IDs by detail. | Lists contain only A's rows. Every B ID gives 404/`null`, identical to a random UUID. |
| T2 | **Cross-tenant UPDATE.** As A, update each of B's records by ID. | Not found. B's row is unchanged (verified by direct SQL). |
| T3 | **Cross-tenant DELETE.** As A, delete or cancel each of B's records. | Not found. The row still exists. |
| T4 | **Cross-tenant INSERT.** As A, create children that reference B's parents (order item → B order, posting → B financial account, allocation → B payout, shipment → B order). | Rejected (4xx). No row is created. Both the DAL pre-check and the FK backstop are verified. |
| T5 | **Forged tenant identifiers.** `accountId` in the body, `?accountId=`, `x-tenant-id` and `x-account-id` headers, and a forged `tenant` cookie, all set to B. | Zod rejects unknown keys (400). Headers and query params are ignored. All effects stay in A. |
| T6 | **Tenant switching.** Attempt to create a second business for A, or to point A's session at B's business. | `23505` → already onboarded. There is no API to switch. |
| T7 | **Unauthenticated.** Enumerate every page, Server Action and route handler (auto-discovered) and call each without a cookie. | Pages redirect to `/sign-in`. Actions and routes return 401. No data in the body. |
| T8 | **Invalid sessions.** Random token, tampered signature, token from another environment's secret, deleted session row. | Treated as unauthenticated. |
| T9 | **Session expiration.** Set `session.expires_at` into the past. | Unauthenticated. The cookie is cleared. |
| T10 | **Logout invalidation.** Sign out, then replay the old cookie. | Rejected immediately. |
| T11 | **Password reset revokes sessions.** Reset, then use the other session. | Rejected. |
| T12 | **Onboarding race.** Two concurrent `completeOnboarding` calls for one user. | Exactly one business, one settings row and one chart of accounts. |
| T13 | **Not onboarded.** Authenticated with no business, accessing app pages and actions. | Redirect to `/onboarding` (or `409`). No DAL access. |
| T14 | **CSRF / origin.** A cross-origin POST to `/api/auth/*` and to a Server Action. | Rejected. |
| T15 | **Account enumeration.** Unknown email vs wrong password; duplicate sign-up. | Indistinguishable responses and status codes. |
| T16 | **Coverage meta-test.** All 34 tenant tables have a DAL module and T1–T4 cases. | Passes. A new table without tests fails. |
| T17 | **Static guards** (§8). | Pass in CI. |
| T18 | **Cache safety.** Render a cached page as A, then as B. | B never sees A's data. No tenant data in shared cache entries. |
| T19 | **Rate limiting** (once the storage decision is made). | Repeated failed sign-ins are throttled. |

Existing suites remain mandatory on every change: offline 8, integration 71, concurrency 12, plus the frozen-hash check.

## 12. Delivery sequence and approval gates

1. **Gate A:** entry criteria §0 met. Approve this plan.
2. Install the approved dependency set; pass the compatibility verification tests.
3. Implement `db.ts`, `auth.ts`, the route handler, and sign-up/in/out with T7–T11, T14 and T15.
4. Implement `requireSession()`/`requireTenant()`, onboarding and the starter chart, with T6, T12 and T13.
5. Add the DAL skeleton for all 34 tables, the static guards, and the meta-test (T16, T17).
6. Write the T1–T5 cross-tenant matrix, then T18.
7. **Gate B:** a security review of the diff, all suites green, results recorded in a test report. Only then does Phase 2 (financial services) start.

## 13. Open decisions for the owner

1. The password-hashing strategy on Workers Free (Cloudflare review §4.3).
2. Rate-limit storage: database (`0009`) or Cloudflare rule.
3. Email verification and password reset delivery provider (must be free).
4. Session lifetime values and whether to keep the cookie cache fully disabled.
5. Whether to schedule RLS and a least-privilege runtime role in V1.
