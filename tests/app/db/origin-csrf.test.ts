import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { businessAccounts, users } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { resolveSession } from '@/server/auth/session';
import { hasTestDatabase } from '../support/database';
import { apiRequest, apiRoutes, authCall, cookieHeaders, createTestApp, newCredentials, registerAndSignIn } from '../support/app';

const EVIL = 'https://evil.example';

describe.skipIf(!hasTestDatabase)('T14 CSRF and Origin', () => {
  let app: AppContainer;
  beforeAll(() => {
    app = createTestApp();
  });
  afterAll(() => app?.close());

  describe('Better Auth endpoints', () => {
    it('rejects sign-up from a foreign origin and creates no user', async () => {
      const credentials = newCredentials('csrf-signup');
      const response = await authCall(app, '/sign-up/email', { body: credentials, origin: EVIL });
      expect(response.status).toBe(403);
      expect(await app.db.select().from(users).where(eq(users.email, credentials.email))).toHaveLength(0);
    });

    it('rejects sign-in from a foreign origin', async () => {
      const user = await registerAndSignIn(app, 'csrf-signin');
      const response = await authCall(app, '/sign-in/email', { body: { email: user.credentials.email, password: user.credentials.password }, origin: EVIL });
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie().some((cookie) => cookie.includes('session_token=') && !cookie.includes('session_token=;'))).toBe(false);
    });

    it('blocks a cross-site navigation login (Fetch Metadata)', async () => {
      const user = await registerAndSignIn(app, 'csrf-nav');
      const response = await authCall(app, '/sign-in/email', {
        body: { email: user.credentials.email, password: user.credentials.password },
        origin: null,
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      expect(response.status).toBe(403);
    });

    it.each([
      ['a foreign origin', EVIL],
      ['no origin', null],
    ])('rejects cookie-authenticated sign-out with %s and keeps the session', async (_label, origin) => {
      const user = await registerAndSignIn(app, 'csrf-signout');
      const response = await authCall(app, '/sign-out', { body: {}, cookie: user.cookie, origin });
      expect(response.status).toBe(403);
      expect(await resolveSession(app, cookieHeaders(user.cookie))).not.toBeNull();
    });

    it('accepts same-origin sign-out', async () => {
      const user = await registerAndSignIn(app, 'csrf-ok');
      expect((await authCall(app, '/sign-out', { body: {}, cookie: user.cookie })).status).toBe(200);
    });
  });

  describe('app API (POST /api/v1/onboarding)', () => {
    it.each([
      ['a foreign origin', { origin: EVIL }],
      ['no origin', { origin: null }],
      ['Sec-Fetch-Site cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }],
      ['Sec-Fetch-Site same-site', { headers: { 'sec-fetch-site': 'same-site' } }],
    ] as const)('rejects %s with 403 and creates nothing', async (_label, options) => {
      const user = await registerAndSignIn(app, 'csrf-api');
      const response = await apiRoutes(app).onboarding(apiRequest(app, '/api/v1/onboarding', { method: 'POST', cookie: user.cookie, body: { shopName: 'CSRF Shop' }, ...options }));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('FORBIDDEN_ORIGIN');
      expect(await app.db.select().from(businessAccounts).where(eq(businessAccounts.ownerUserId, user.session.userId))).toHaveLength(0);
    });
  });
});
