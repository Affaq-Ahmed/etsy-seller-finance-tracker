# Cloudflare Workers Compatibility Review

**Date:** 2026-11-24
**Scope:** Two open deployment risks for the PRD's zero-cost target (Next.js on Cloudflare Workers **Free** with Neon Free): (1) the PostgreSQL driver and connection model, and (2) password hashing within the 10 ms CPU limit.
**Status:** Desk research only. **Nothing was deployed or measured on Cloudflare.** Paid plans are out of scope.

Every statement is marked:

- **[Documented]**: stated in official Cloudflare, Neon, OpenNext or Better Auth documentation, fetched 2026-11-24 (Cloudflare limits page dated 2026-11-19).
- **[Reported]**: from GitHub issues or community sources; not authoritative.
- **[Assumption]**: an inference that **must be confirmed by runtime testing**.

---

## 1. Workers Free plan constraints [Documented]

| Limit | Free plan |
| --- | --- |
| CPU time per HTTP request | **10 ms** |
| CPU time per Cron Trigger | 10 ms (5 cron triggers per account) |
| Requests | 100,000 / day (resets 00:00 UTC; error 1027 when exceeded) |
| Subrequests | 50 per invocation |
| Simultaneous outgoing connections (`fetch` + `connect()`) | **6**; a 7th waits |
| Memory | 128 MB per isolate |
| Global-scope startup | 1 s |
| Wall-clock duration (HTTP) | No limit |
| Worker size | 64 MiB uncompressed per Cloudflare's limits page. **This conflicts with** OpenNext's docs, which say 3 MiB compressed on Free; the OpenNext figure is probably stale. *Measure with `wrangler deploy --dry-run`.* |

I/O wait (fetch, database queries) **does not** count toward CPU time. Cloudflare itself notes that workloads doing authentication or SSR "typically use 10–20 ms", so the Free CPU budget is tight for this app even before password hashing.

## 2. Next.js on Workers via OpenNext [Documented]

- `@opennextjs/cloudflare` supports **all Next.js 16 minor and patch versions**, so 16.4.6 is compatible. It requires Wrangler ≥ 3.99.0, `nodejs_compat`, and a compatibility date ≥ 2024-09-23.
- The **Node.js runtime is required**; `runtime = "edge"` is unsupported.
- Supported: App Router, Route Handlers, SSR/SSG/ISR, PPR, Middleware. Next 16's Node `proxy.ts` has **experimental** support since `@opennextjs/cloudflare` 1.20.3, so security must never depend on `proxy.ts` (see the auth plan).
- [Assumption] Cache Components, which this project enables, work under OpenNext. This needs a build and run test.

## 3. PostgreSQL driver and connectivity

### 3.1 Options

| Option | Transport | Interactive transactions | Fits our integrity model? | Cost |
| --- | --- | --- | --- | --- |
| **postgres.js 3.4.9 → Hyperdrive → Neon (direct endpoint)** | TCP via Hyperdrive binding | Yes | **Yes.** The current driver is unchanged and works with deferred constraints, `BEGIN … COMMIT` and retries | Free (Hyperdrive is included on Workers Free) |
| node-postgres (`pg` ≥ 8.16.3) → Hyperdrive | TCP | Yes | Yes. It is Cloudflare's "recommended driver" for Hyperdrive caching, but it would be a new dependency | Free |
| `@neondatabase/serverless` over HTTP | HTTPS | **No** interactive transactions (one-shot or batch only) | **No.** Multi-statement posting, deferred checks and whole-transaction retries need a real session | Free |
| `@neondatabase/serverless` over WebSocket (`Pool`) | WSS | Yes | Possible, but adds a second driver and per-request socket setup. Cloudflare says **not** to use it with Hyperdrive | Free |
| Raw `connect()` TCP without Hyperdrive | TCP | Yes | Possible, but Cloudflare says "Connecting to PostgreSQL? You should use Hyperdrive." Sockets cannot be shared across requests | Free |

**Recommendation:** keep **postgres.js 3.4.9** and connect through **Hyperdrive** to Neon's **direct, non-pooled** endpoint using a dedicated least-privilege role [Documented guidance]. This needs no driver change and no schema change.

### 3.2 Connection management rules [Documented]

- Create the Drizzle/postgres.js client **per request** from `env.HYPERDRIVE.connectionString`; Hyperdrive does the pooling. Never create sockets in global scope.
- Cloudflare's example settings are `max: 5` and `fetch_types: false`, which stays under the 6-connection limit. **Do not set `prepare: false`.**
- Hyperdrive Free gives **100,000 queries/day**, about 20 origin connections per configuration, 10 configurations, a 60 s statement timeout and a 10 min idle timeout. There is no egress charge.
- Requires `nodejs_compat` and a current `compatibility_date`.

### 3.3 Risks specific to this financial schema [Assumption; must test]

1. **Query caching.** Hyperdrive can cache read queries. Serving a cached balance, cap or reconciliation total would be a correctness bug. **Disable caching on the Hyperdrive configuration** (or verify that transactional and financial reads are never cached) before any financial read goes through it.
2. **Transaction pooling semantics.** Session state does not survive between transactions: session-level `SET`, session advisory locks and temp tables. Anything tenant-scoped such as a future RLS `set_config` must be **transaction-local** (`set_config(…, true)` inside the transaction). Isolation levels set per transaction (`BEGIN ISOLATION LEVEL …`) should work, but this is not yet tested.
3. **Deferred constraints and retries.** These are standard PostgreSQL behavior and should be unaffected, but the 12-case concurrency suite has only run over direct local TCP. It must be re-run through Hyperdrive in a staging configuration.
4. **Connection budget.** Holding a transaction open across slow work (for example Better Auth issue #12837, sign-up holding a transaction during hashing) consumes scarce origin connections, since Free has about 20.
5. **Daily query quota.** Each financial posting performs several queries, so 100k queries/day caps throughput. Background jobs must be batched (PRD §7).
6. **Neon Free** compute hours and storage remain a separate quota (System Architecture §3.3).

## 4. Password hashing within 10 ms CPU

### 4.1 What Better Auth does

- [Documented] The default algorithm is **scrypt**. It can be replaced with `emailAndPassword.password.hash(password) → string` and `emailAndPassword.password.verify({ password, hash }) → boolean`.
- [Reported, not verified from source; the source fetch failed] Parameters are **N = 16384, r = 16, p = 1, 64-byte key**, stored as `salt:key` hex. Historically it used the pure-JS `@noble/hashes` scrypt.
- [Reported] Issue #8860 ("sign-up exceeds CPU time limit on Cloudflare Workers", closed 2026-04-01) and issue #8456 (native `node:crypto` scrypt for Workers, closed 2026-03-09) moved to **native `node:crypto.scrypt` where available, with an unchanged hash format**. Issue #969 cites about **4.5–5 s of CPU** for the pure-JS version. Issue #9649 (closed 2026-05-28) reports Workers bundles resolving the non-native module under `nodejs_compat`. **Check which build the bundle actually uses.**

### 4.2 Cost analysis [Assumption; not measured]

| Approach | Approx. CPU per hash | Fits 10 ms? | Security |
| --- | --- | --- | --- |
| Pure-JS scrypt (N=16384, r=16) | ~seconds [Reported] | **No** | OK |
| Native scrypt (N=16384, r=16) | Tens of ms is typical for 32 MiB scrypt on server CPUs | **Very unlikely** | OK |
| Native scrypt with work cut until it fits ~10 ms (e.g. N ≤ 2048) | ≤ 10 ms | Maybe | **Weak.** Well below OWASP minimums; an offline DB leak becomes far cheaper to crack |
| PBKDF2-SHA256 via WebCrypto | Grows with iterations. OWASP's 600k iterations is far beyond 10 ms, and workerd has historically capped iterations (~100k) | **No** at OWASP strength | OK only at OWASP strength |
| Argon2id (WASM) | Usually more CPU than native scrypt | **No** | Best |

Memory is a second problem. scrypt uses `128 × N × r` bytes, which is **32 MiB per hash** at the reported parameters. With the 128 MB isolate limit, only a handful of concurrent sign-ins or sign-ups in one isolate would trigger out-of-memory failures. [Assumption]

**Conclusion.** An OWASP-strength password hash cannot be assumed to run within the Free plan's 10 ms CPU per request, and it most likely will not. Lowering work factors to fit is **not acceptable** for a financial application: it trades the confidentiality of every user's password for hosting cost. There is also no documented burst allowance above 10 ms, so the plan must not assume one.

### 4.3 Zero-cost options (decision required; not a recommendation to change the PRD unilaterally)

1. **Measure first.** Deploy a throwaway Worker with only the hash/verify path, at the intended parameters, to a free account from a **clean machine**. Record CPU time from Workers observability across about 100 runs (p50/p95/max), and check whether requests fail with exceeded-CPU errors. *This is the only way to settle the question.*
2. **Passkeys (WebAuthn) as the primary credential.** Verification is a signature check, which is cheap. This changes PRD §3.1 (email and password).
3. **Email OTP or magic link (no stored password).** It depends on free email delivery, which PRD §3.1 already treats as uncertain. The magic-link critical advisory is fixed in ≥ 1.7.7, but this also changes the PRD.
4. **Run auth endpoints on separate free compute** that has no 10 ms cap, while keeping the app on Workers. This adds operational complexity, and the provider's free-tier terms (including any non-commercial clauses) must be checked.
5. **Pick a different free host for the whole app.** This is a System Architecture change. Some "free" tiers prohibit commercial use, so check the terms.

**Not acceptable:** reduced work factors, client-side hashing as a substitute for server-side hashing, or any paid plan.

## 5. Verified vs still requiring runtime testing

| Item | Status |
| --- | --- |
| Next 16 supported by OpenNext | Documented |
| postgres.js ≥ 3.4.5 supported via Hyperdrive; 3.4.9 qualifies | Documented |
| Hyperdrive included on Workers Free at no cost | Documented |
| Free limits (10 ms CPU, 6 connections, 50 subrequests, 128 MB, 100k req/day) | Documented |
| Actual Worker bundle size vs limit | **Untested** (sources conflict) |
| Interactive transactions, deferred constraints and 40001/40P01 retries through Hyperdrive | **Untested** |
| Hyperdrive caching disabled or harmless for financial reads | **Untested** |
| Cache Components under OpenNext | **Untested** |
| Better Auth hash CPU time on Workers at secure parameters | **Untested**; very likely over budget |
| Which scrypt build (native or pure-JS) the Workers bundle resolves | **Untested** |
| SSR + session lookup CPU per page within 10 ms | **Untested**; Cloudflare's own guidance suggests 10–20 ms |

## 6. Recommended runtime test plan (later; free account; clean machine; synthetic data only)

1. Build with OpenNext and run `wrangler deploy --dry-run` to record the bundle size.
2. Deploy a hash-only probe Worker and capture CPU time and errors at secure parameters.
3. Point Hyperdrive (caching **disabled**) at a **disposable** Neon branch or database, never production data. Run the posting, deferred-failure, 40001 and 40P01 scenarios from `tests/integration/concurrency.test.cjs`, adapted to run inside a Worker.
4. Measure p95 CPU for an authenticated dashboard SSR request.
5. Record the results in this document before committing to the hosting architecture.
