import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { NO_STORE } from '@/server/http/responses';
import { hasTestDatabase } from '../support/database';
import {
  apiRequest, apiRoutes, authCall, createTestApp, newCredentials, registerAndOnboard, registerAndSignIn, sessionCookieFrom, TEST_ORIGIN, testEnv, uniqueIp,
} from '../support/app';

describe.skipIf(!hasTestDatabase)('app API routes', () => {
  let app: AppContainer;
  beforeAll(() => {
    app = createTestApp();
  });
  afterAll(() => app?.close());

  const business = (options: Parameters<typeof apiRequest>[2] = {}) => apiRoutes(app).business(apiRequest(app, '/api/v1/business', options));
  const clearedCookies = (response: Response) => response.headers.getSetCookie().filter((cookie) => /session_token=;/.test(cookie));

  describe('T7 unauthenticated requests', () => {
    it.each([
      ['GET /api/v1/business', () => business()],
      ['POST /api/v1/onboarding', () => apiRoutes(app).onboarding(apiRequest(app, '/api/v1/onboarding', { method: 'POST', body: { shopName: 'Nope' } }))],
    ])('%s answers 401 with a generic, non-cacheable body', async (_label, call) => {
      const response = await call();
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      expect(await response.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
      expect(response.headers.getSetCookie()).toEqual([]);
    });
  });

  describe('T8–T10 invalid, expired and signed-out sessions over HTTP', () => {
    it('a tampered cookie gets 401 and the stale cookie is cleared', async () => {
      const user = await registerAndOnboard(app, 'Tamper Shop', 'api-tamper');
      const response = await business({ cookie: `${user.cookie.slice(0, -3)}xyz` });
      expect(response.status).toBe(401);
      const [cleared] = clearedCookies(response);
      expect(cleared).toMatch(/Max-Age=0/);
      expect(cleared).toMatch(/HttpOnly/);
      expect(cleared).toMatch(/Path=\//);
    });

    it('an expired session gets 401', async () => {
      const user = await registerAndOnboard(app, 'Expired Shop', 'api-expired');
      await app.db.update(sessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessions.id, user.session.sessionId));
      const response = await business({ cookie: user.cookie });
      expect(response.status).toBe(401);
      expect(clearedCookies(response)).toHaveLength(1);
    });

    it('a signed-out session gets 401', async () => {
      const user = await registerAndOnboard(app, 'Logout Shop', 'api-logout');
      expect((await business({ cookie: user.cookie })).status).toBe(200);
      await authCall(app, '/sign-out', { body: {}, cookie: user.cookie });
      expect((await business({ cookie: user.cookie })).status).toBe(401);
    });

    it('clears __Secure- cookies with the Secure attribute on https', async () => {
      const secureApp = createTestApp('https://app.example.test');
      try {
        const response = await apiRoutes(secureApp).business(apiRequest(secureApp, '/api/v1/business', { cookie: '__Secure-better-auth.session_token=forged.value' }));
        expect(response.status).toBe(401);
        const [cleared] = response.headers.getSetCookie();
        expect(cleared).toMatch(/^__Secure-better-auth\.session_token=;/);
        expect(cleared).toMatch(/; Secure/);
      } finally {
        await secureApp.close();
      }
    });
  });

  describe('signed-in requests', () => {
    it('signed in but not onboarded gets 409 (T13)', async () => {
      const user = await registerAndSignIn(app, 'api-409');
      expect((await business({ cookie: user.cookie })).status).toBe(409);
    });

    it('an onboarded user gets only their own business, never cacheable', async () => {
      const user = await registerAndOnboard(app, 'Own Shop', 'api-own');
      const response = await business({ cookie: user.cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      expect((await response.json()).business.shopName).toBe('Own Shop');
    });
  });
});

describe.skipIf(!hasTestDatabase)('route files through the process composition root', () => {
  const holder = globalThis as typeof globalThis & { __etsyFinanceContainer?: AppContainer };
  const saved: Record<string, string | undefined> = {};
  const env = hasTestDatabase ? testEnv(TEST_ORIGIN) : {};

  beforeAll(() => {
    // Point the real composition root at the validated disposable database only.
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(async () => {
    await holder.__etsyFinanceContainer?.close();
    delete holder.__etsyFinanceContainer;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function request(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Request {
    const headers = new Headers({ origin: TEST_ORIGIN, 'x-forwarded-for': uniqueIp() });
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(`${TEST_ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }

  it('signs up, signs in, onboards and reads the business end to end', async () => {
    const authRoute = await import('@/app/api/auth/[...all]/route');
    const onboardingRoute = await import('@/app/api/v1/onboarding/route');
    const businessRoute = await import('@/app/api/v1/business/route');
    const credentials = newCredentials('e2e');

    const signUpResponse = await authRoute.POST(request('/api/auth/sign-up/email', { method: 'POST', body: credentials }));
    expect(signUpResponse.status).toBe(200);
    expect(signUpResponse.headers.get('cache-control')).toBe(NO_STORE);

    const signInResponse = await authRoute.POST(request('/api/auth/sign-in/email', { method: 'POST', body: { email: credentials.email, password: credentials.password } }));
    expect(signInResponse.status).toBe(200);
    expect(signInResponse.headers.get('cache-control')).toBe(NO_STORE);
    const cookie = sessionCookieFrom(signInResponse);
    expect(cookie).not.toBeNull();

    const sessionResponse = await authRoute.GET(request('/api/auth/get-session', { cookie: cookie! }));
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get('cache-control')).toBe(NO_STORE);
    expect((await sessionResponse.json()).user.email).toBe(credentials.email);

    expect((await businessRoute.GET(request('/api/v1/business', { cookie: cookie! }))).status).toBe(409);
    expect((await onboardingRoute.POST(request('/api/v1/onboarding', { method: 'POST', cookie: cookie!, body: { shopName: 'Route Shop' } }))).status).toBe(201);
    const businessResponse = await businessRoute.GET(request('/api/v1/business', { cookie: cookie! }));
    expect(businessResponse.status).toBe(200);
    expect((await businessResponse.json()).business.shopName).toBe('Route Shop');

    const signOutResponse = await authRoute.POST(request('/api/auth/sign-out', { method: 'POST', cookie: cookie!, body: {} }));
    expect(signOutResponse.status).toBe(200);
    expect((await businessRoute.GET(request('/api/v1/business', { cookie: cookie! }))).status).toBe(401);
  });

  it('the six expense route files are wired to their handlers, guards and route parameters', async () => {
    const authRoute = await import('@/app/api/auth/[...all]/route');
    const onboardingRoute = await import('@/app/api/v1/onboarding/route');
    const listRoute = await import('@/app/api/v1/expenses/route');
    const itemRoute = await import('@/app/api/v1/expenses/[expenseId]/route');
    const confirmRoute = await import('@/app/api/v1/expenses/[expenseId]/confirm/route');
    const voidRoute = await import('@/app/api/v1/expenses/[expenseId]/void/route');
    const reverseRoute = await import('@/app/api/v1/expenses/[expenseId]/reverse/route');
    const withId = (id: string) => ({ params: Promise.resolve({ expenseId: id }) });
    const missing = '00000000-0000-4000-8000-0000000000ab';

    // Every route answers 401 without a session.
    expect((await listRoute.GET(request('/api/v1/expenses'))).status).toBe(401);
    expect((await listRoute.POST(request('/api/v1/expenses', { method: 'POST', body: {} }))).status).toBe(401);
    expect((await itemRoute.GET(request(`/api/v1/expenses/${missing}`), withId(missing))).status).toBe(401);
    expect((await confirmRoute.POST(request(`/api/v1/expenses/${missing}/confirm`, { method: 'POST' }), withId(missing))).status).toBe(401);
    expect((await voidRoute.POST(request(`/api/v1/expenses/${missing}/void`, { method: 'POST' }), withId(missing))).status).toBe(401);
    expect((await reverseRoute.POST(request(`/api/v1/expenses/${missing}/reverse`, { method: 'POST', body: { reason: 'x' } }), withId(missing))).status).toBe(401);

    const credentials = newCredentials('e2e-expenses');
    expect((await authRoute.POST(request('/api/auth/sign-up/email', { method: 'POST', body: credentials }))).status).toBe(200);
    const signIn = await authRoute.POST(request('/api/auth/sign-in/email', { method: 'POST', body: { email: credentials.email, password: credentials.password } }));
    const cookie = sessionCookieFrom(signIn)!;
    expect((await onboardingRoute.POST(request('/api/v1/onboarding', { method: 'POST', cookie, body: { shopName: 'Expense Route Shop' } }))).status).toBe(201);

    const body = { expenseType: 'SHARED', categoryType: 'SOFTWARE_SUBSCRIPTION', amount: '12.50', expenseDate: '2026-11-21' };
    const created = await listRoute.POST(request('/api/v1/expenses', { method: 'POST', cookie, body }));
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe(NO_STORE);
    const id = (await created.json()).expense.id as string;
    const listed = await (await listRoute.GET(request('/api/v1/expenses', { cookie }))).json();
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([id]);
    expect((await itemRoute.GET(request(`/api/v1/expenses/${id}`, { cookie }), withId(id))).status).toBe(200);
    expect((await itemRoute.GET(request('/api/v1/expenses/not-a-uuid', { cookie }), withId('not-a-uuid'))).status).toBe(404);

    const confirmed = await confirmRoute.POST(request(`/api/v1/expenses/${id}/confirm`, { method: 'POST', cookie }), withId(id));
    expect([confirmed.status, (await confirmed.json()).alreadyConfirmed]).toEqual([200, false]);
    const reversed = await reverseRoute.POST(request(`/api/v1/expenses/${id}/reverse`, { method: 'POST', cookie, body: { reason: 'Wired route check' } }), withId(id));
    expect([reversed.status, (await reversed.json()).expense.effectiveStatus]).toEqual([200, 'REVERSED']);

    const draft = (await (await listRoute.POST(request('/api/v1/expenses', { method: 'POST', cookie, body }))).json()).expense.id as string;
    const voided = await voidRoute.POST(request(`/api/v1/expenses/${draft}/void`, { method: 'POST', cookie }), withId(draft));
    expect([voided.status, (await voided.json()).expense.effectiveStatus]).toEqual([200, 'VOIDED']);
  });
});
