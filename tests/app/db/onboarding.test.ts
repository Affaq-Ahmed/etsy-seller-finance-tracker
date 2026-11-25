import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { accountSettings, auditLogs, businessAccounts, financialAccounts, journalEntries } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { resolveTenant } from '@/server/auth/session';
import { getPostgresErrorCode } from '@/server/db/errors';
import {
  DEFAULT_PAYOUT_ELIGIBILITY_DELAY_DAYS, DEFAULT_PAYOUT_WEEKDAY, onboardBusiness, onboardInTransaction,
  PAYOUT_ELIGIBILITY_DELAY_DAYS_KEY, PAYOUT_WEEKDAY_KEY, STARTER_CHART, type StarterAccountSpec,
} from '@/server/onboarding/service';
import { hasTestDatabase, testDatabaseUrl } from '../support/database';
import { apiRequest, apiRoutes, cookieHeaders, createTestApp, registerAndSignIn, type SignedInUser } from '../support/app';

describe.skipIf(!hasTestDatabase)('business onboarding', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  beforeAll(() => {
    app = createTestApp();
    raw = postgres(testDatabaseUrl(), { max: 3, onnotice: () => undefined });
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  async function countsFor(ownerUserId: string) {
    const businesses = await app.db.select().from(businessAccounts).where(eq(businessAccounts.ownerUserId, ownerUserId));
    if (businesses.length === 0) return { businesses: 0, settings: 0, accounts: 0, audits: 0, journals: 0 };
    const accountId = businesses[0]!.id;
    const count = async (table: typeof accountSettings | typeof financialAccounts | typeof auditLogs | typeof journalEntries) =>
      (await app.db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.accountId, accountId)))[0]!.n;
    return {
      businesses: businesses.length,
      settings: await count(accountSettings),
      accounts: await count(financialAccounts),
      audits: await count(auditLogs),
      journals: await count(journalEntries),
    };
  }
  const COMPLETE = { businesses: 1, settings: 2, accounts: STARTER_CHART.length, audits: 1 + 2 + STARTER_CHART.length, journals: 0 };

  describe('T13 signed in but not onboarded', () => {
    it('resolves to not_onboarded and the tenant API answers 409', async () => {
      const user = await registerAndSignIn(app, 'not-onboarded');
      expect((await resolveTenant(app, cookieHeaders(user.cookie))).status).toBe('not_onboarded');
      const response = await apiRoutes(app).business(apiRequest(app, '/api/v1/business', { cookie: user.cookie }));
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('ONBOARDING_REQUIRED');
    });
  });

  describe('creation', () => {
    let user: SignedInUser;
    beforeAll(async () => {
      user = await registerAndSignIn(app, 'onboard');
    });

    it('creates the business, payout settings, starter chart and audit trail in one go', async () => {
      const response = await apiRoutes(app).onboarding(apiRequest(app, '/api/v1/onboarding', { method: 'POST', cookie: user.cookie, body: { shopName: '  Handmade Co  ' } }));
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.json();
      expect(body.created).toBe(true);
      expect(body.business).toMatchObject({ shopName: 'Handmade Co', baseCurrency: 'USD', timezone: 'Asia/Karachi' });
      expect(Object.keys(body.business).sort()).toEqual(['baseCurrency', 'createdAt', 'shopName', 'timezone']);
      expect(await countsFor(user.session.userId)).toEqual(COMPLETE);
    });

    it('stores the documented payout settings', async () => {
      const resolution = await resolveTenant(app, cookieHeaders(user.cookie));
      if (resolution.status !== 'ok') throw new Error('not onboarded');
      const rows = await app.db.select().from(accountSettings).where(eq(accountSettings.accountId, resolution.tenant.accountId));
      expect(Object.fromEntries(rows.map((row) => [row.settingKey, row.settingValue]))).toEqual({
        [PAYOUT_ELIGIBILITY_DELAY_DAYS_KEY]: DEFAULT_PAYOUT_ELIGIBILITY_DELAY_DAYS,
        [PAYOUT_WEEKDAY_KEY]: DEFAULT_PAYOUT_WEEKDAY,
      });
    });

    it('creates the starter chart with explicit roles and documented currencies', async () => {
      const resolution = await resolveTenant(app, cookieHeaders(user.cookie));
      if (resolution.status !== 'ok') throw new Error('not onboarded');
      const rows = await app.db.select().from(financialAccounts).where(eq(financialAccounts.accountId, resolution.tenant.accountId));
      expect(rows.map((row) => `${row.accountRole}:${row.accountType}:${row.currency}`).sort()).toEqual([
        'BANK:ASSET:PKR', 'DIRECT_EXPENSE:EXPENSE:USD', 'ETSY_PAYOUT_CLEARING:ASSET:USD', 'ETSY_RECEIVABLE:ASSET:USD',
        'PAYONEER:ASSET:USD', 'REVENUE:INCOME:USD', 'SHARED_EXPENSE:EXPENSE:USD', 'SUPPLIER_COST:EXPENSE:USD',
        'TRANSFER_CLEARING:ASSET:PKR', 'TRANSFER_CLEARING:ASSET:USD',
      ]);
      expect(rows.every((row) => row.isActive)).toBe(true);
      expect(rows.some((row) => row.accountRole === 'REFUND')).toBe(false);
    });

    it('audits every created entity with the owner as actor', async () => {
      const resolution = await resolveTenant(app, cookieHeaders(user.cookie));
      if (resolution.status !== 'ok') throw new Error('not onboarded');
      const rows = await app.db.select().from(auditLogs).where(eq(auditLogs.accountId, resolution.tenant.accountId));
      expect(rows.every((row) => row.userId === user.session.userId && row.action === 'CREATE' && row.beforeData === null)).toBe(true);
      expect(rows.filter((row) => row.entityType === 'business_account').map((row) => row.entityId)).toEqual([resolution.tenant.accountId]);
      expect(rows.filter((row) => row.entityType === 'account_setting')).toHaveLength(2);
      expect(rows.filter((row) => row.entityType === 'financial_account')).toHaveLength(STARTER_CHART.length);
    });

    it('T6/idempotency: a retry or second attempt returns the existing business unchanged', async () => {
      const routes = apiRoutes(app);
      const retry = await routes.onboarding(apiRequest(app, '/api/v1/onboarding', { method: 'POST', cookie: user.cookie, body: { shopName: 'Handmade Co' } }));
      const second = await routes.onboarding(apiRequest(app, '/api/v1/onboarding', { method: 'POST', cookie: user.cookie, body: { shopName: 'A Second Shop' } }));
      expect(retry.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await retry.json()).created).toBe(false);
      expect((await second.json()).business.shopName).toBe('Handmade Co');
      expect(await countsFor(user.session.userId)).toEqual(COMPLETE);
    });
  });

  describe('T12 concurrent onboarding', () => {
    it('parallel requests create exactly one business', async () => {
      const user = await registerAndSignIn(app, 'parallel');
      const results = await Promise.all(Array.from({ length: 8 }, () => onboardBusiness(app.db, user.session, { shopName: 'Parallel Shop' })));
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.business.createdAt)).size).toBe(1);
      expect(await countsFor(user.session.userId)).toEqual(COMPLETE);
    });

    async function waitForLockWait(): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await raw`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
        if ((row?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('second onboarding never waited on the first transaction');
    }

    it.each([
      ['COMMIT', false],
      ['ROLLBACK', true],
    ] as const)('an overlapping request waits for the first transaction (%s)', async (outcome, secondCreates) => {
      const user = await registerAndSignIn(app, `overlap-${outcome.toLowerCase()}`);
      // One connection, so the manual BEGIN holds a single open transaction.
      const firstWriter = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await firstWriter`BEGIN`;
        const first = await onboardInTransaction(drizzle(firstWriter, { schema }), user.session, { shopName: 'First Writer' });
        expect(first.created).toBe(true);

        const second = onboardBusiness(app.db, user.session, { shopName: 'Second Writer' });
        await waitForLockWait();
        await (outcome === 'COMMIT' ? firstWriter`COMMIT` : firstWriter`ROLLBACK`);

        const result = await second;
        expect(result.created).toBe(secondCreates);
        expect(result.business.shopName).toBe(secondCreates ? 'Second Writer' : 'First Writer');
        expect(await countsFor(user.session.userId)).toEqual(COMPLETE);
      } finally {
        await firstWriter.end();
      }
    });
  });

  describe('atomic rollback', () => {
    it('a failure part-way through leaves nothing behind, and a retry succeeds', async () => {
      const user = await registerAndSignIn(app, 'rollback');
      // REVENUE must be an INCOME account: the database check rejects this mid-transaction.
      const broken: readonly StarterAccountSpec[] = [...STARTER_CHART, { name: 'Broken', accountType: 'ASSET', accountRole: 'REVENUE', currency: 'BASE' }];
      const failure = await onboardBusiness(app.db, user.session, { shopName: 'Broken Shop' }, { starterChart: broken }).then(() => null, (error: unknown) => error);
      expect(getPostgresErrorCode(failure)).toBe('23514');
      expect(await countsFor(user.session.userId)).toEqual({ businesses: 0, settings: 0, accounts: 0, audits: 0, journals: 0 });

      const retry = await onboardBusiness(app.db, user.session, { shopName: 'Fixed Shop' });
      expect(retry.created).toBe(true);
      expect(await countsFor(user.session.userId)).toEqual(COMPLETE);
    });
  });

  describe('validation', () => {
    let user: SignedInUser;
    beforeAll(async () => {
      user = await registerAndSignIn(app, 'validation');
    });

    it.each([
      ['an empty shop name', { body: { shopName: '' } }, 400],
      ['a too-long shop name', { body: { shopName: 'x'.repeat(161) } }, 400],
      ['malformed JSON', { rawBody: '{"shopName":' }, 400],
      ['a non-JSON content type', { rawBody: 'shopName=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415],
    ] as const)('rejects %s without creating anything', async (_label, options, status) => {
      const response = await apiRoutes(app).onboarding(apiRequest(app, '/api/v1/onboarding', { method: 'POST', cookie: user.cookie, ...options }));
      expect(response.status).toBe(status);
      expect((await countsFor(user.session.userId)).businesses).toBe(0);
    });
  });
});
