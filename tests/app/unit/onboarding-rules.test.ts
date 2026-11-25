import { describe, expect, it } from 'vitest';
import { tenantForOwnedBusiness, TenantOwnershipError } from '@/server/auth/session';
import {
  DEFAULT_PAYOUT_ELIGIBILITY_DELAY_DAYS,
  DEFAULT_PAYOUT_WEEKDAY,
  onboardingInputSchema,
  PAYOUT_ELIGIBILITY_DELAY_DAYS_KEY,
  PAYOUT_WEEKDAY_KEY,
  STARTER_CHART,
} from '@/server/onboarding/service';
import { SHOP_NAME_MAX_LENGTH } from '@/lib/policy';

describe('onboarding input', () => {
  it('trims the shop name', () => {
    expect(onboardingInputSchema.parse({ shopName: '  Handmade Co  ' })).toEqual({ shopName: 'Handmade Co' });
  });

  it.each([
    [{ shopName: '' }],
    [{ shopName: '   ' }],
    [{ shopName: 'x'.repeat(SHOP_NAME_MAX_LENGTH + 1) }],
    [{}],
    [{ shopName: 42 }],
  ])('rejects %j', (input) => {
    expect(onboardingInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts the maximum length', () => {
    expect(onboardingInputSchema.safeParse({ shopName: 'x'.repeat(SHOP_NAME_MAX_LENGTH) }).success).toBe(true);
  });

  it.each(['accountId', 'account_id', 'tenantId', 'ownerUserId', 'userId', 'baseCurrency'])('is strict: rejects a "%s" key (T5)', (key) => {
    expect(onboardingInputSchema.safeParse({ shopName: 'Shop', [key]: 'forged' }).success).toBe(false);
  });
});

describe('starter chart (ARCHITECTURE.md §7.2, owner decisions)', () => {
  const assetRoles = ['ETSY_RECEIVABLE', 'ETSY_PAYOUT_CLEARING', 'PAYONEER', 'BANK', 'TRANSFER_CLEARING'];
  const expenseRoles = ['SUPPLIER_COST', 'DIRECT_EXPENSE', 'SHARED_EXPENSE'];

  it('contains exactly the documented roles and currencies', () => {
    const summary = STARTER_CHART.map((spec) => `${spec.accountRole}:${spec.currency}`).sort();
    expect(summary).toEqual([
      'BANK:PKR',
      'DIRECT_EXPENSE:BASE',
      'ETSY_PAYOUT_CLEARING:BASE',
      'ETSY_RECEIVABLE:BASE',
      'PAYONEER:BASE',
      'REVENUE:BASE',
      'SHARED_EXPENSE:BASE',
      'SUPPLIER_COST:BASE',
      'TRANSFER_CLEARING:PKR',
      'TRANSFER_CLEARING:USD',
    ]);
  });

  it('has no REFUND or UNCLASSIFIED account and no PKR expense accounts', () => {
    expect(STARTER_CHART.some((spec) => spec.accountRole === 'REFUND' || spec.accountRole === 'UNCLASSIFIED')).toBe(false);
    expect(STARTER_CHART.some((spec) => spec.accountType === 'EXPENSE' && spec.currency !== 'BASE')).toBe(false);
  });

  it('pairs every role with the account type the database check requires', () => {
    for (const spec of STARTER_CHART) {
      if (assetRoles.includes(spec.accountRole)) expect(spec.accountType).toBe('ASSET');
      else if (expenseRoles.includes(spec.accountRole)) expect(spec.accountType).toBe('EXPENSE');
      else if (spec.accountRole === 'REVENUE') expect(spec.accountType).toBe('INCOME');
      else throw new Error(`unexpected role ${spec.accountRole}`);
    }
  });

  it('has unique name/currency pairs (financial_accounts_name_currency_uq)', () => {
    const keys = STARTER_CHART.map((spec) => `${spec.name}|${spec.currency}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('documents the payout settings and defaults', () => {
    expect(PAYOUT_ELIGIBILITY_DELAY_DAYS_KEY).toBe('payout_eligibility_delay_days');
    expect(PAYOUT_WEEKDAY_KEY).toBe('payout_weekday');
    expect(DEFAULT_PAYOUT_ELIGIBILITY_DELAY_DAYS).toBe(14);
    expect(DEFAULT_PAYOUT_WEEKDAY).toBe('MONDAY');
  });
});

describe('tenant derivation for a newly created business', () => {
  const session = { userId: 'owner-1', sessionId: 'session-1' };

  it('brands a business owned by the session user', () => {
    expect(tenantForOwnedBusiness(session, { id: 'biz-1', ownerUserId: 'owner-1' })).toEqual({ ...session, accountId: 'biz-1' });
  });

  it('refuses a business owned by someone else', () => {
    expect(() => tenantForOwnedBusiness(session, { id: 'biz-2', ownerUserId: 'owner-2' })).toThrow(TenantOwnershipError);
  });
});
