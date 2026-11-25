# Better Auth Compatibility Review

**Date:** 2026-11-24
**Status:** Recommendation only. Nothing was installed, upgraded or configured.
**Supersedes:** the version guidance in [Better_Auth_Compatibility.md](Better_Auth_Compatibility.md). That document's schema mapping analysis still stands; its 1.6.3 version choice does not.

Evidence sources: the npm registry per-version metadata, Better Auth and Drizzle GitHub releases and security advisories, and the Better Auth docs, all fetched 2026-11-24. Installed versions were read from `node_modules/*/package.json` offline. Items marked *unverified* could not be read verbatim and must be confirmed at install time.

> **Install only on a verified-clean machine, from the committed lockfile (`npm ci`).** A local workstation compromise was found on 2026-11-24. On 2026-11-25 its known artifacts were confirmed removed and git hooks globally disabled; the owner reports remediation complete. Re-confirm credential rotation before installing anything that publishes or authenticates.

---

## 1. Current versions (installed, verified offline)

| Package | Version | Declared peers of note |
| --- | --- | --- |
| next | 16.4.6 | react / react-dom `^18.2.0 \|\| ^19.0.0` |
| react / react-dom | 19.3.0 | — |
| drizzle-orm | 0.44.7 | `postgres >=3`, `pg >=8`, `@neondatabase/serverless >=0.10.0` (all optional) |
| drizzle-kit | 0.30.6 | none |
| postgres (postgres.js) | 3.4.9 | — |
| typescript | 5.9.3 | — |
| better-auth | **not installed** | — |

## 2. Better Auth release lines (npm, verified)

| Line | Highest patch | Published (UTC) | dist-tag |
| --- | --- | --- | --- |
| 1.6.x | 1.6.35 | 2026-11-19 | `release-1.6` |
| 1.7.x | **1.7.28** | **2026-11-24 15:16**, the day of this review | `latest` |
| 1.8.x | 1.8.0-beta.11 (no stable) | 2026-11-20 | `beta` |

`@better-auth/drizzle-adapter` and `@better-auth/core` carry the same version numbers. `better-auth` depends on its adapters at the **exact same version**.

## 3. Peer dependency evidence

| better-auth | `drizzle-orm` peer | `drizzle-kit` peer | `next` peer | `react` peer |
| --- | --- | --- | --- | --- |
| 1.6.3 | `>=0.41.0` | `>=0.31.4` | `^14 \|\| ^15 \|\| ^16` | `^18 \|\| ^19` |
| 1.6.35 | `^0.45.2` | `>=0.31.4` | same | same |
| 1.7.28 | `^0.45.2 \|\| >=1.0.0-rc.1 <2.0.0` | `>=0.31.4 \|\| >=1.0.0-beta.1` | same | same |

| @better-auth/drizzle-adapter | `drizzle-orm` peer | other peers |
| --- | --- | --- |
| 1.6.3 | `>=0.41.0` | `@better-auth/core ^1.6.3`, `@better-auth/utils 0.4.0` |
| 1.6.35 | `^0.45.2` | `@better-auth/core ^1.6.35`, `@better-auth/utils 0.4.2` |
| 1.7.28 | `^0.45.2 \|\| >=1.0.0-rc.1 <2.0.0` | `@better-auth/core ^1.7.28`, `@better-auth/utils ^0.4.2 \|\| ^0.5.0` |

All of these peers are marked **optional** in `peerDependenciesMeta`. npm will not hard-fail on them, but an optional peer that *is* installed must still satisfy its range, or npm 7+ raises `ERESOLVE`. The project does install drizzle-orm and drizzle-kit, so the ranges apply.

Drizzle side:

- **drizzle-orm**: the latest stable is 0.45.4 (released 2026-10-08; it fixes postgres-js prepared statements on `.prepare(name)`). 1.0 exists only as pre-releases (`rc` 1.0.0-rc.6).
- **drizzle-kit**: npm `latest` is **0.31.11** (2026-09-21). `rc` is 1.0.0-rc.6 and `beta` is 1.0.0-beta.22. drizzle-kit 0.31.11 declares **no** peer dependency on drizzle-orm. The pairing is a convention, not an enforced constraint.
- **Next.js**: every Better Auth line accepts `next ^16`, so 16.4.6 is compatible. No Next.js change is needed.
- **postgres.js**: Better Auth does not constrain it. Keep 3.4.9, which also meets Cloudflare Hyperdrive's documented minimum of `>3.4.5`.

## 4. Security advisories that decide the version

| Advisory | Severity | Affected | Fixed | Relevance |
| --- | --- | --- | --- | --- |
| GHSA-965c-763c-88jm (CVE-2026-114607): Magic Link + social/OAuth sign-in as another user | **Critical** 9.1 | `>=1.4.0-beta.18 <1.7.7` | 1.7.7 | Applies only if magic link + OAuth are enabled; V1 plans neither. |
| GHSA-9hm7-xhfp-cx58: unverified OAuth email treated as verified | Moderate 5.9 | `>=0.4.9 <1.7.16` | 1.7.16 | OAuth only |
| GHSA-44jh-23m7-hpcf: concurrent requests exceed rate limits with Postgres storage | Low 3.7 | `>=1.6.17 <1.7.7` | 1.7.7 | Applies if rate-limit storage is the database |

The advisories list **no 1.6.x backport**. From the ranges, 1.6.3 and 1.6.35 are affected, and 1.7.28 is outside all three. Seven further advisories (expo, electron, sso, admin, OTP, email-change, kysely-mysql) were seen in the listing but their ranges were not opened. Re-check them at install time.

## 5. Viable combinations

| | A. Minimal change | B. **Recommended** | C. Bleeding edge |
| --- | --- | --- | --- |
| better-auth (+ drizzle-adapter) | 1.6.3 | **1.7.x, exact pin, ≥ 1.7.16** (currently 1.7.28) | 1.8.0-beta / drizzle 1.0-rc |
| drizzle-orm | 0.44.7 (unchanged) | **0.45.4** | 1.0.0-rc.6 |
| drizzle-kit | 0.31.11 | **0.31.11** | 1.0.0-rc.6 |
| postgres | 3.4.9 | 3.4.9 | 3.4.9 |
| next / react | unchanged | unchanged | unchanged |
| Peer-clean? | Yes | Yes | Yes |
| Packages changed | 2 (+ auth) | 3 (+ auth) | 3 (+ auth) |
| Known advisories | **Yes**: critical/moderate (feature-gated) and no future fixes on this line | None known | Pre-release |
| Verdict | **Reject.** Starting a financial SaaS on an auth line with open advisories saves one ORM bump. | **Accept** | **Reject.** Pre-release, with breaking postgres-js codec changes in rc.5/rc.6 and RQBv1 removal. |

Combination D (1.6.35) offers nothing over B: it already requires drizzle-orm `^0.45.2` and is still in the advisory ranges.

### Recommended combination (B)

```
better-auth                  1.7.x   exact pin (>= 1.7.16; 1.7.28 today)
@better-auth/drizzle-adapter same exact version as better-auth
drizzle-orm                  0.45.4  exact pin
drizzle-kit                  0.31.11 exact pin
postgres                     3.4.9   (unchanged)
next / react / react-dom     16.4.6 / 19.3.0 (unchanged)
```

**Supply-chain cooldown.** 1.7.28 was published hours before this review. Given the active compromise investigation, install the newest 1.7.x patch that has been public for **at least 7 days** at install time and is at or above 1.7.16. Review its changelog and check the advisory list again. Pin exact versions (no `^`), commit the lockfile, and install with `npm ci`.

## 6. Potential breaking changes

| Change | Risk | Evidence |
| --- | --- | --- |
| drizzle-orm 0.44.7 → 0.45.4 | Low | 0.45.0 notes list only fixes and features, none marked breaking, none touching migrations. 0.45.4 changes postgres-js prepared-statement behavior for `.prepare(name)`. *The 0.44 → 0.45 notes were not fully verified (0.45.1–0.45.2 unread).* |
| drizzle-kit 0.30.6 → 0.31.11 | **Medium; must be proven** | 0.31.0 changes the SQL **generated in the future** for enum alterations, and upgrades esbuild (fixes CVE-2024-24790). 0.31.11 adds a "silent migration skip" warning. **Snapshot, journal and folder format changes were not found in the notes, and their absence is not proven.** |
| better-auth 1.6 → 1.7 schema | Medium | The repo's auth tables match the **1.6.3** plugin-free manifest. 1.7 may add or alter core fields. *Not verified.* |
| better-auth transactions | Low–Medium | Issue #12837 (opened 2026-11-19): email sign-up keeps a DB transaction open across password hashing. With `transaction: true` this lengthens lock or connection hold time, which matters on Hyperdrive's ~20 origin connections. Track it. |
| Password hashing on Workers | **High** | See [Cloudflare_Compatibility_Review.md](Cloudflare_Compatibility_Review.md). |

## 7. Required migration or configuration changes

- **Frozen migrations 0000–0008: no change.** If 1.7.x requires extra auth columns, add them in a **new forward migration `0009_*`** with an updated field-manifest test. Never regenerate or edit history.
- **Refresh the auth field manifest.** Replace `tests/fixtures/better-auth-1.6.3.json` with one extracted from the pinned 1.7.x `@better-auth/core` `getAuthTables` (plugin-free), and update the offline test name and version.
- **Configuration.** Keep the existing mapping: `provider: 'pg'`, `schema: betterAuthSchema`, `usePlural: false`, default text IDs, `experimental.joins: false`. Add `nextCookies()` as the **last** plugin. Mount the route handler at `app/api/auth/[...all]/route.ts` via `toNextJsHandler(auth)`.
- **Do not enable** magic link, OAuth/social, SSO, expo, electron or admin plugins in V1. That keeps the auth surface to email and password.
- **Rate limiting.** Use database storage only after confirming the fix for GHSA-44jh is present (≥1.7.7). This needs a reviewed rate-limit table, which would be a forward migration.
- **Password hashing.** A custom `emailAndPassword.password.{hash,verify}` may be required for Workers. This is a decision gate in the Cloudflare review.

## 8. Recommended verification tests (on a clean machine)

1. **Install integrity.** `npm ci` exits 0. `npm ls better-auth @better-auth/drizzle-adapter drizzle-orm drizzle-kit postgres next` shows exactly the pinned versions with no `invalid` or `ERESOLVE`. `npm audit --omit=dev` shows nothing affecting auth.
2. **Frozen chain unchanged.** `npm run test:db:offline` passes; it includes the SHA-256 manifest for 0000–0008.
3. **drizzle-kit 0.31 no-drift proof, the critical gate.**
   - `drizzle-kit check --config=drizzle.local-test.config.ts` passes.
   - `drizzle-kit generate --config=drizzle.local-test.config.ts --name=verify_no_drift` reports "No schema changes".
   - `git status` shows **no** modified or new files under `drizzle/`. If the kit wants to rewrite snapshots or the journal, stop: do not commit it, and escalate.
4. **Fresh-database replay** via `scripts/local-db.cjs`. The full 0000–0008 migrate succeeds and a second run is a no-op. `verify-local-db.cjs` reports 39 / 20 / 83 / 135 / 19 / 53 / 9.
5. **Regression suites under the new ORM.** Integration 71/71, concurrency 12/12, offline 8/8. These run through the `postgres` driver directly, but they confirm the database is unchanged.
6. **ORM-path smoke test.** A minimal Drizzle 0.45 transaction that posts a balanced journal, so the deferred trigger fires at COMMIT. A retry on forced `40001` must not double-post.
7. **Auth schema parity.** The new 1.7.x manifest test passes against `src/db/auth-schema.ts`. Any mismatch becomes a reviewed `0009` migration.
8. **Typecheck, lint and build.** `tsc --noEmit`, `npm run lint` and `npm run build -- --webpack` are all green.
