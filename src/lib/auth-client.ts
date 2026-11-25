import { createAuthClient } from 'better-auth/react';

// Browser client for Better Auth's same-origin /api/auth/* endpoints. Calls
// go through the route handler, so Better Auth's Origin/CSRF checks and rate
// limits apply (direct server-side auth.api calls would bypass them).
export const authClient = createAuthClient();
