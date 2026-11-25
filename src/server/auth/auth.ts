import 'server-only';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuthSchema } from '@/db/auth-schema';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/policy';
import type { AppConfig } from '@/server/config/env';
import type { Database } from '@/server/db/client';

// Owner-approved session and password policy (ARCHITECTURE.md §7.2, §8).
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;
export const AUTH_LOG_LEVEL = 'warn';

type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Better Auth log sink that writes the message only. Extra arguments can be
 * errors whose messages embed SQL parameters (emails, session tokens, password
 * hashes), so they are reduced to their error name.
 */
export function writeAuthLog(level: AuthLogLevel, message: string, ...args: unknown[]): void {
  const detail = args
    .map((arg) => (arg instanceof Error ? arg.name : null))
    .filter((name): name is string => name !== null);
  const line = `[auth] ${message}${detail.length ? ` (${detail.join(', ')})` : ''}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
}

export interface AuthDeps {
  readonly db: Database;
  readonly config: AppConfig;
}

export function createAuth({ db, config }: AuthDeps) {
  return betterAuth({
    baseURL: config.auth.baseUrl,
    secret: config.auth.secret,
    trustedOrigins: [config.auth.baseUrl],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: betterAuthSchema,
      usePlural: false,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // No session cookie on sign-up; duplicate sign-ups get the same generic response.
      autoSignIn: false,
      // Email verification needs a free email provider (PRODUCT.md D2); deferred.
      requireEmailVerification: false,
      // Password reset itself is deferred; revocation is configured for when it ships.
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Disabled so sign-out and revocation take effect on the next request.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      // Better Auth only enables it in production by default; enforce everywhere.
      enabled: true,
      storage: 'database',
    },
    advanced: {
      // Better Auth skips origin checks when NODE_ENV=test unless set explicitly.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: config.auth.baseUrl.startsWith('https://'),
      database: { joins: false },
    },
    telemetry: { enabled: false },
    logger: { level: AUTH_LOG_LEVEL, log: writeAuthLog },
  });
}

export type Auth = ReturnType<typeof createAuth>;
