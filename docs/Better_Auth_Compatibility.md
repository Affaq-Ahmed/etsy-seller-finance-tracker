# Better Auth compatibility review

Reviewed 2026-11-24 without installing or enabling authentication, changing dependencies, or connecting to a database.

## Version-specific findings

Stable Better Auth **1.6.3** and @better-auth/drizzle-adapter **1.6.3** declare drizzle-orm >=0.41.0, which includes the installed **0.44.7**. Exact official package metadata was retrieved from [Better Auth 1.6.3](https://registry.npmjs.org/better-auth/1.6.3) and [adapter 1.6.3](https://registry.npmjs.org/@better-auth%2fdrizzle-adapter/1.6.3). The official published [core artifact](https://registry.npmjs.org/@better-auth/core/-/core-1.6.3.tgz) supplies getAuthTables; its plugin-free field metadata was extracted without importing an auth runtime. The [adapter artifact](https://registry.npmjs.org/@better-auth/drizzle-adapter/-/drizzle-adapter-1.6.3.tgz) was inspected to verify model/field lookup, PostgreSQL provider, transaction and join options. See the [official adapter documentation](https://better-auth.com/docs/adapters/drizzle) for general setup; the published 1.6.3 source, rather than unversioned examples, controls the configuration below.

The current [1.7.28 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.28) is newer, but its [adapter metadata](https://registry.npmjs.org/@better-auth%2fdrizzle-adapter/1.7.28) requires drizzle-orm ^0.45.2 or the supported 1.0 release-candidate range. It does not include 0.44.7. Do not select latest automatically or call it compatible with this installed ORM.

1.6.3 is a version-specific structural/ORM-peer compatibility reference, not an endorsement of deploying an older authentication version. Before implementing auth, reevaluate security releases and choose the version/dependency upgrade together. There is also a tooling mismatch: better-auth 1.6.3 declares optional drizzle-kit >=0.31.4, while this repository has 0.30.6. Full package-stack compatibility is therefore **not certified**. No upgrade was performed in this schema task; future installation must resolve that peer constraint explicitly, not use --force or silently alter dependencies.

## Mapping and fields

| Adapter model | Drizzle export | SQL table | Identity |
| --- | --- | --- | --- |
| user | users | user | text ID; required name/email, unique email, emailVerified, optional image, timestamps |
| session | sessions | session | text ID; unique token, expiresAt, userId FK, optional IP/user agent, timestamps |
| account | authAccounts | account | text ID; external accountId/providerId, userId FK, optional tokens/expiry/scope/password, timestamps |
| verification | verifications | verification | text ID; identifier/value/expiresAt and timestamps |

All plugin-free 1.6.3 required fields, field types and single-field uniqueness requirements match. The automated offline manifest comparison checks these against the current Drizzle objects. No missing baseline auth column was found, so no auth schema migration was created. Existing provider/account pair uniqueness is an additional safeguard. Auth accountId is an external identity string, not the UUID business tenant ID. Text IDs match the default auth strategy; the original logical ERD's UUID identity description was corrected.

Drizzle properties use camelCase while SQL columns use snake_case. The inspected adapter indexes schemaModel[fieldName], so supply the existing objects through betterAuthSchema; no SQL-name field overrides are required. Keep usePlural false and default model names. Do not map auth account to businessAccounts.

## Exact proposed configuration (documentation only)

After selecting/pinning packages and resolving the Kit peer requirement:

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuthSchema } from './db/auth-schema';
// db is the separately configured Drizzle PostgreSQL instance.
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: betterAuthSchema,
    usePlural: false,
    transaction: true,
  }),
  emailAndPassword: { enabled: true },
  experimental: { joins: false },
});
```

Use the default text ID generation and plugin-free core schema. No relations are required with experimental joins disabled. Database-backed rate-limit storage, plugins or extra fields would require their own generated schema review; no rate-limit table is present. Password-reset delivery, trusted origins, cookies, rate limiting and routes must be configured and tested during the auth implementation. This document does not enable auth or claim login/session/runtime security has been tested. No paid authentication service is required.
