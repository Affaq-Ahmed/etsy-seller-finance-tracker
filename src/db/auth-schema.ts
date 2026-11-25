import { users, sessions, authAccounts, verifications, rateLimits } from './schema';

// Pass this object as the Better Auth Drizzle adapter's `schema` option.
// Auth's provider `account` is distinct from the business tenant account.
// Fields/mapping verified against Better Auth 1.7.25 (tests/fixtures/
// better-auth-1.7.25.json); `rateLimit` backs database rate-limit storage
// (migration 0009). See docs/ARCHITECTURE.md sections 3.2 and 8.
export const betterAuthSchema = {
  user: users,
  session: sessions,
  account: authAccounts,
  verification: verifications,
  rateLimit: rateLimits,
};
