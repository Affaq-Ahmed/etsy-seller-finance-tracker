import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { authAccounts, sessions, users } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { resolveSession } from '@/server/auth/session';
import { SESSION_EXPIRES_IN_SECONDS } from '@/server/auth/auth';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/policy';
import { hasTestDatabase } from '../support/database';
import {
  authCall, cookieHeaders, createTestApp, newCredentials, registerAndSignIn, sessionCookieFrom, setCookies, signIn, signUp,
} from '../support/app';

describe.skipIf(!hasTestDatabase)('authentication flows', () => {
  let app: AppContainer;
  beforeAll(() => {
    app = createTestApp();
  });
  afterAll(() => app?.close());

  const userByEmail = async (email: string) => app.db.select().from(users).where(eq(users.email, email));
  const sessionsOf = async (userId: string) => app.db.select().from(sessions).where(eq(sessions.userId, userId));

  describe('sign-up', () => {
    it('creates the user and credential without signing in', async () => {
      const credentials = newCredentials('signup');
      const response = await signUp(app, { ...credentials, email: credentials.email.toUpperCase() });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBeNull();
      expect(sessionCookieFrom(response)).toBeNull();

      const [user] = await userByEmail(credentials.email);
      expect(user?.email).toBe(credentials.email);
      expect(await sessionsOf(user!.id)).toHaveLength(0);

      // Default Better Auth scrypt format: 16-byte hex salt ":" 64-byte hex key.
      const [credential] = await app.db.select().from(authAccounts).where(and(eq(authAccounts.userId, user!.id), eq(authAccounts.providerId, 'credential')));
      expect(credential?.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
      expect(credential?.password).not.toContain(credentials.password);
    });

    it.each([
      ['too short', 'a'.repeat(PASSWORD_MIN_LENGTH - 1)],
      ['too long', 'a'.repeat(PASSWORD_MAX_LENGTH + 1)],
    ])('rejects a password that is %s', async (_label, password) => {
      const credentials = { ...newCredentials('pw'), password };
      const response = await signUp(app, credentials);
      expect(response.status).toBe(400);
      expect(await userByEmail(credentials.email)).toHaveLength(0);
    });

    it.each([
      ['minimum', PASSWORD_MIN_LENGTH],
      ['maximum', PASSWORD_MAX_LENGTH],
    ])('accepts a password of the %s length', async (_label, length) => {
      expect((await signUp(app, { ...newCredentials('pwok'), password: 'b'.repeat(length) })).status).toBe(200);
    });

    it('rejects an invalid email', async () => {
      expect((await signUp(app, { ...newCredentials(), email: 'not-an-email' })).status).toBe(400);
    });
  });

  describe('T15 duplicate sign-up does not reveal registration', () => {
    it('returns the same status and shape as a new account, with no session cookie', async () => {
      const original = newCredentials('dup');
      const fresh = await signUp(app, original);
      const duplicate = await signUp(app, { ...original, password: 'a-different-password-456', name: 'Someone Else' });

      expect(duplicate.status).toBe(fresh.status);
      const [freshBody, duplicateBody] = [await fresh.json(), await duplicate.json()];
      expect(Object.keys(duplicateBody).sort()).toEqual(Object.keys(freshBody).sort());
      expect(Object.keys(duplicateBody.user).sort()).toEqual(Object.keys(freshBody.user).sort());
      expect(duplicateBody.token).toBeNull();
      expect(sessionCookieFrom(duplicate)).toBeNull();
      expect(setCookies(duplicate)).toEqual(setCookies(fresh));

      // The existing account is untouched: one user, original password only.
      expect(await userByEmail(original.email)).toHaveLength(1);
      expect((await signIn(app, original)).response.status).toBe(200);
      expect((await signIn(app, { email: original.email, password: 'a-different-password-456' })).response.status).toBe(401);
    });

    it('does not log the email address of a duplicate attempt', async () => {
      const original = newCredentials('duplog');
      await signUp(app, original);
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      await signUp(app, original);
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain(original.email);
    });
  });

  describe('sign-in', () => {
    it('creates a 7-day httpOnly, SameSite=Lax session cookie', async () => {
      const credentials = newCredentials('signin');
      await signUp(app, credentials);
      const before = Date.now();
      const { response, cookie } = await signIn(app, credentials);
      expect(response.status).toBe(200);
      expect(cookie).not.toBeNull();

      const header = setCookies(response).find((value) => value.startsWith(cookie!.split('=')[0]!))!;
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);
      expect(header).toMatch(/Path=\//);
      expect(header).toMatch(new RegExp(`Max-Age=${SESSION_EXPIRES_IN_SECONDS}`));
      expect(header).not.toMatch(/;\s*Secure/i);

      const session = await resolveSession(app, cookieHeaders(cookie!));
      const [row] = await app.db.select().from(sessions).where(eq(sessions.id, session!.sessionId));
      const expiresInMs = row!.expiresAt.getTime() - before;
      expect(Math.abs(expiresInMs - SESSION_EXPIRES_IN_SECONDS * 1000)).toBeLessThan(60_000);
    });

    it('returns an identical 401 for a wrong password and an unknown email', async () => {
      const credentials = newCredentials('badpw');
      await signUp(app, credentials);
      const wrongPassword = (await signIn(app, { email: credentials.email, password: 'wrong-password-value' })).response;
      const unknownEmail = (await signIn(app, { email: newCredentials('nobody').email, password: 'wrong-password-value' })).response;
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(await unknownEmail.json()).toEqual(await wrongPassword.json());
      expect(sessionCookieFrom(wrongPassword)).toBeNull();
      expect(sessionCookieFrom(unknownEmail)).toBeNull();
    });

    it('uses __Secure- prefixed Secure cookies on an https origin', async () => {
      const secureApp = createTestApp('https://app.example.test');
      try {
        const credentials = newCredentials('secure');
        await signUp(secureApp, credentials);
        const { response } = await signIn(secureApp, credentials);
        const header = setCookies(response).find((value) => value.includes('session_token='))!;
        expect(header).toMatch(/^__Secure-[^=]*session_token=/);
        expect(header).toMatch(/;\s*Secure/i);
      } finally {
        await secureApp.close();
      }
    });
  });

  describe('T8 invalid and tampered sessions', () => {
    it.each([
      ['no cookie', ''],
      ['a random token', 'better-auth.session_token=not-a-real-token.invalidsignature'],
      ['an unrelated cookie', 'theme=dark'],
    ])('treats %s as unauthenticated', async (_label, cookie) => {
      expect(await resolveSession(app, new Headers(cookie ? { cookie } : {}))).toBeNull();
    });

    // The cookie is `<token>.<signature>`; the signature is a base64 HMAC of 32 bytes (44 characters).
    // Flipping the TOP bit of a base64 digit always changes the decoded bytes. Do not flip a low bit of
    // the final data character instead: it carries 2 unused padding bits, so e.g. A -> B decodes to the
    // identical signature and is (correctly, harmlessly) accepted. An earlier version of this test did
    // that and failed in about 1 run in 16 (measured: 8 of 120 sessions).
    const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const flipTopBit = (char: string) => BASE64[BASE64.indexOf(char) ^ 32] ?? char;

    it('rejects a valid token with any tampered signature', async () => {
      const { cookie } = await registerAndSignIn(app, 'tamper');
      const name = cookie.slice(0, cookie.indexOf('='));
      const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
      const dot = value.lastIndexOf('.');
      const signature = value.slice(dot + 1);
      expect(signature).toHaveLength(44);
      const resolveWith = (candidate: string) => resolveSession(app, cookieHeaders(`${name}=${encodeURIComponent(value.slice(0, dot + 1) + candidate)}`));

      expect(await resolveWith(signature)).not.toBeNull();
      for (const index of [0, 1, 20, signature.length - 3, signature.length - 2]) {
        const tampered = signature.slice(0, index) + flipTopBit(signature[index] ?? '') + signature.slice(index + 1);
        expect(await resolveWith(tampered), `signature position ${index}`).toBeNull();
      }
      expect(await resolveWith(signature.slice(0, -1)), 'truncated signature').toBeNull();
      expect(await resolveWith(`${signature}A`), 'extended signature').toBeNull();
      expect(await resolveWith(''), 'empty signature').toBeNull();
      const tokenOnly = value.split('.')[0];
      expect(await resolveSession(app, cookieHeaders(`${name}=${tokenOnly}`)), 'token without signature').toBeNull();
      expect(await resolveSession(app, cookieHeaders(cookie))).not.toBeNull();
    });
  });

  describe('T9 expired sessions', () => {
    it('treats an expired session as unauthenticated', async () => {
      const user = await registerAndSignIn(app, 'expired');
      await app.db.update(sessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessions.id, user.session.sessionId));
      expect(await resolveSession(app, cookieHeaders(user.cookie))).toBeNull();
    });
  });

  describe('T10 logout and revocation', () => {
    it('sign-out deletes the session and a replayed cookie is rejected', async () => {
      const user = await registerAndSignIn(app, 'logout');
      const response = await authCall(app, '/sign-out', { body: {}, cookie: user.cookie });
      expect(response.status).toBe(200);
      expect(await app.db.select().from(sessions).where(eq(sessions.id, user.session.sessionId))).toHaveLength(0);
      expect(await resolveSession(app, cookieHeaders(user.cookie))).toBeNull();
      // Replaying the old cookie cannot resurrect the session.
      await authCall(app, '/sign-out', { body: {}, cookie: user.cookie });
      expect(await resolveSession(app, cookieHeaders(user.cookie))).toBeNull();
    });

    it('revocation takes effect immediately because the cookie cache is off', async () => {
      const user = await registerAndSignIn(app, 'revoke');
      expect(await resolveSession(app, cookieHeaders(user.cookie))).not.toBeNull();
      await app.db.delete(sessions).where(eq(sessions.id, user.session.sessionId));
      expect(await resolveSession(app, cookieHeaders(user.cookie))).toBeNull();
    });

    it('signing out one session leaves the user’s other sessions intact', async () => {
      const user = await registerAndSignIn(app, 'multi');
      const second = await signIn(app, user.credentials);
      await authCall(app, '/sign-out', { body: {}, cookie: user.cookie });
      expect(await resolveSession(app, cookieHeaders(second.cookie!))).not.toBeNull();
    });
  });
});
