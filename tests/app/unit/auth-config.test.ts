import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@/server/config/env';
import { createDb } from '@/server/db/client';
import { createAuth, SESSION_EXPIRES_IN_SECONDS, SESSION_UPDATE_AGE_SECONDS, writeAuthLog } from '@/server/auth/auth';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/policy';

// postgres.js connects lazily; these tests never run a query.
const handle = createDb('postgresql://unit:synthetic@127.0.0.1:1/etsy_finance_test_unit', { max: 1 });
afterAll(() => handle.close());

function authFor(baseUrl: string) {
  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unit:synthetic@127.0.0.1:1/etsy_finance_test_unit',
    BETTER_AUTH_SECRET: 's'.repeat(32),
    BETTER_AUTH_URL: baseUrl,
  });
  return createAuth({ db: handle.db, config });
}

describe('Better Auth configuration (approved policy)', () => {
  const auth = authFor('http://localhost:3000');

  it('uses email/password with the 12–128 policy, no auto sign-in and reset revocation', () => {
    expect(auth.options.emailAndPassword).toMatchObject({
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      autoSignIn: false,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
    });
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it('keeps the default scrypt hasher (no custom hash or verify)', () => {
    expect('password' in auth.options.emailAndPassword).toBe(false);
  });

  it('uses 7-day database sessions refreshed daily with the cookie cache off', () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(604_800);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(86_400);
    expect(auth.options.session).toMatchObject({
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    });
  });

  it('turns telemetry off and logs at warn', () => {
    expect(auth.options.telemetry).toEqual({ enabled: false });
    expect(auth.options.logger?.level).toBe('warn');
  });

  it('keeps origin/CSRF checks and database rate limiting on even under NODE_ENV=test', async () => {
    const context = await auth.$context;
    expect(process.env.NODE_ENV).toBe('test');
    expect(context.skipOriginCheck).toBe(false);
    expect(context.skipCSRFCheck).toBe(false);
    expect(context.rateLimit).toMatchObject({ enabled: true, storage: 'database' });
    expect(context.trustedOrigins).toContain('http://localhost:3000');
  });

  it('uses plain cookies for http and __Secure- cookies for https', async () => {
    const http = (await auth.$context).authCookies.sessionToken;
    expect(http.name).not.toMatch(/^__Secure-/);
    expect(http.attributes).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false });

    const https = (await authFor('https://app.example.test').$context).authCookies.sessionToken;
    expect(https.name).toMatch(/^__Secure-/);
    expect(https.attributes).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
  });
});

describe('auth log sink', () => {
  it('writes the message and only the names of attached errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const leaky = Object.assign(new Error('Failed query: select ... params: seller@example.test,secret-token'), { name: 'DrizzleQueryError' });

    writeAuthLog('error', 'Failed to create user', leaky);
    writeAuthLog('warn', 'Rate limiting could not determine a client IP', { detail: 'seller@example.test' });

    expect(error).toHaveBeenCalledWith('[auth] Failed to create user (DrizzleQueryError)');
    expect(warn).toHaveBeenCalledWith('[auth] Rate limiting could not determine a client IP');
    const everything = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(everything).not.toContain('seller@example.test');
    expect(everything).not.toContain('secret-token');
  });
});
