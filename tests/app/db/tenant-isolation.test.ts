import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountSettings, auditLogs, financialAccounts } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import type { TenantContext, TenantId } from '@/server/auth/tenant-context';
import { tenantScope, TenantScopeViolationError, type TenantInsert, type TenantUpdate } from '@/server/dal/tenant-scope';
import { findFinancialAccountById, listFinancialAccounts } from '@/server/dal/financial-accounts';
import { listAccountSettings } from '@/server/dal/account-settings';
import { listAuditLogs } from '@/server/dal/audit-logs';
import { getTenantBusiness } from '@/server/dal/business-accounts';
import { getPostgresErrorCode } from '@/server/db/errors';
import { hasTestDatabase } from '../support/database';
import { apiRequest, apiRoutes, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';

describe.skipIf(!hasTestDatabase)('tenant isolation (T1–T5)', () => {
  let app: AppContainer;
  let a: OnboardedUser;
  let b: OnboardedUser;
  let bAccountId: string;
  let bSettingId: string;

  beforeAll(async () => {
    app = createTestApp();
    a = await registerAndOnboard(app, 'Shop A', 'tenant-a');
    b = await registerAndOnboard(app, 'Shop B', 'tenant-b');
    const scopeB = tenantScope(app.db, b.tenant);
    bAccountId = (await listFinancialAccounts(scopeB))[0]!.id;
    bSettingId = (await listAccountSettings(scopeB))[0]!.id;
  });
  afterAll(() => app?.close());

  const scopeOf = (user: OnboardedUser) => tenantScope(app.db, user.tenant);

  describe('T1 cross-tenant SELECT', () => {
    it('lists only the session tenant rows', async () => {
      const accounts = await listFinancialAccounts(scopeOf(a));
      expect(accounts).toHaveLength(10);
      expect(accounts.every((row) => row.accountId === a.tenant.accountId)).toBe(true);
      expect((await listAccountSettings(scopeOf(a))).every((row) => row.accountId === a.tenant.accountId)).toBe(true);
      expect((await listAuditLogs(scopeOf(a))).every((row) => row.accountId === a.tenant.accountId)).toBe(true);
    });

    it('returns the same not-found result for another tenant ID as for a missing ID', async () => {
      const crossTenant = await findFinancialAccountById(scopeOf(a), bAccountId);
      const missing = await findFinancialAccountById(scopeOf(a), randomUUID());
      expect(crossTenant).toBeNull();
      expect(missing).toBeNull();
      expect(await findFinancialAccountById(scopeOf(b), bAccountId)).not.toBeNull();
    });

    it('never returns the tenant root for a context whose tenant and owner do not match', async () => {
      const forged: TenantContext = { ...a.tenant, accountId: b.tenant.accountId };
      expect(await getTenantBusiness(app.db, forged)).toBeNull();
      expect((await getTenantBusiness(app.db, a.tenant))?.shopName).toBe('Shop A');
    });
  });

  describe('T2 cross-tenant UPDATE', () => {
    it('updates zero rows of another tenant and leaves them unchanged', async () => {
      const updatedAccount = await scopeOf(a).update(financialAccounts, { name: 'Hijacked' }, eq(financialAccounts.id, bAccountId));
      const updatedSetting = await scopeOf(a).update(accountSettings, { settingValue: 99 }, eq(accountSettings.id, bSettingId));
      expect(updatedAccount).toEqual([]);
      expect(updatedSetting).toEqual([]);
      expect((await findFinancialAccountById(scopeOf(b), bAccountId))?.name).not.toBe('Hijacked');
      const bSetting = (await listAccountSettings(scopeOf(b))).find((row) => row.id === bSettingId);
      expect(bSetting?.settingValue).not.toBe(99);
    });

    it('refuses to move a row to another tenant', async () => {
      const forged = { accountId: b.tenant.accountId } as unknown as TenantUpdate<typeof accountSettings>;
      await expect(scopeOf(a).update(accountSettings, forged, eq(accountSettings.id, bSettingId))).rejects.toBeInstanceOf(TenantScopeViolationError);
    });
  });

  describe('T3 cross-tenant DELETE', () => {
    it('deletes zero rows of another tenant', async () => {
      expect(await scopeOf(a).delete(accountSettings, eq(accountSettings.id, bSettingId))).toEqual([]);
      expect(await scopeOf(a).delete(financialAccounts, eq(financialAccounts.id, bAccountId))).toEqual([]);
      expect((await listAccountSettings(scopeOf(b))).some((row) => row.id === bSettingId)).toBe(true);
      expect(await findFinancialAccountById(scopeOf(b), bAccountId)).not.toBeNull();
    });

    it('positive control: the same scope inserts, updates and deletes its own row', async () => {
      const key = `isolation_probe_${randomUUID()}`;
      const [row] = await scopeOf(a).insert(accountSettings, [{ settingKey: key, settingValue: 1 }]);
      expect(row?.accountId).toBe(a.tenant.accountId);
      expect(await scopeOf(a).update(accountSettings, { settingValue: 2 }, eq(accountSettings.id, row!.id))).toHaveLength(1);
      expect(await scopeOf(a).delete(accountSettings, eq(accountSettings.id, row!.id))).toHaveLength(1);
    });
  });

  describe('T4 cross-tenant INSERT', () => {
    it('rejects caller-supplied tenant keys at runtime', async () => {
      for (const key of ['accountId', 'account_id', 'tenantId', 'ownerUserId']) {
        const forged = { name: `Forged ${key}`, accountType: 'ASSET', accountRole: 'BANK', currency: 'PKR', [key]: b.tenant.accountId } as unknown as TenantInsert<typeof financialAccounts>;
        await expect(scopeOf(a).insert(financialAccounts, [forged])).rejects.toBeInstanceOf(TenantScopeViolationError);
      }
      expect((await listFinancialAccounts(scopeOf(b))).some((row) => row.name.startsWith('Forged'))).toBe(false);
    });

    it('inserts always land in the session tenant', async () => {
      const key = `insert_probe_${randomUUID()}`;
      const [row] = await scopeOf(a).insert(accountSettings, [{ settingKey: key, settingValue: true }]);
      expect(row?.accountId).toBe(a.tenant.accountId);
      expect((await listAccountSettings(scopeOf(b))).some((setting) => setting.settingKey === key)).toBe(false);
      await scopeOf(a).delete(accountSettings, eq(accountSettings.id, row!.id));
    });

    it('the database rejects a child row that references another tenant parent', async () => {
      // audit_logs (account_id, user_id) must match business_accounts (id, owner_user_id).
      const error = await scopeOf(a).insert(auditLogs, [{
        userId: b.session.userId, entityType: 'probe', entityId: randomUUID(), action: 'PROBE', beforeData: null, afterData: null,
      }]).then(() => null, (failure: unknown) => failure);
      expect(getPostgresErrorCode(error)).toBe('23503');
      expect((await listAuditLogs(scopeOf(a))).some((row) => row.userId === b.session.userId)).toBe(false);
    });
  });

  describe('T5 forged tenant IDs over HTTP', () => {
    it('ignores tenant IDs in query strings, headers and cookies', async () => {
      const forgedId: TenantId = b.tenant.accountId;
      const response = await apiRoutes(app).business(apiRequest(app, '/api/v1/business', {
        cookie: `${a.cookie}; account_id=${forgedId}; tenant_id=${forgedId}`,
        query: `?accountId=${forgedId}&account_id=${forgedId}&tenantId=${forgedId}`,
        headers: { 'x-account-id': forgedId, 'x-tenant-id': forgedId, 'x-owner-user-id': b.session.userId },
      }));
      expect(response.status).toBe(200);
      expect((await response.json()).business.shopName).toBe('Shop A');
    });

    it.each(['accountId', 'account_id', 'tenantId', 'ownerUserId'])('rejects a "%s" field in the onboarding body', async (key) => {
      const response = await apiRoutes(app).onboarding(apiRequest(app, '/api/v1/onboarding', {
        method: 'POST', cookie: a.cookie, body: { shopName: 'Shop A', [key]: b.tenant.accountId },
      }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.fields).toEqual([key]);
      expect(JSON.stringify(body)).not.toContain(b.tenant.accountId);
    });
  });
});
