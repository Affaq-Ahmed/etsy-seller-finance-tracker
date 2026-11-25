import { users, sessions, authAccounts, verifications } from './schema';

// Pass this object as the Better Auth Drizzle adapter's `schema` option.
// Auth's provider `account` is distinct from the business tenant account.
// Core fields/mapping reviewed against Better Auth 1.6.3; see
// docs/Better_Auth_Compatibility.md for Kit peer and runtime limitations.
export const betterAuthSchema = {
  user: users,
  session: sessions,
  account: authAccounts,
  verification: verifications,
};
