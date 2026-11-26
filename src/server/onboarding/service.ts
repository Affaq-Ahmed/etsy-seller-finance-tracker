import 'server-only';
import { z } from 'zod';
import type { Database, DbExecutor } from '@/server/db/client';
import { runInTransaction } from '@/server/db/transaction';
import { tenantForOwnedBusiness } from '@/server/auth/session';
import type { SessionContext } from '@/server/auth/tenant-context';
import { findBusinessByOwner, insertBusinessIfAbsent } from '@/server/dal/business-accounts';
import { insertAccountSettings } from '@/server/dal/account-settings';
import { insertFinancialAccounts, type FinancialAccountRole, type FinancialAccountType } from '@/server/dal/financial-accounts';
import { insertAuditLogs, type AuditEntry } from '@/server/dal/audit-logs';
import { tenantScope } from '@/server/dal/tenant-scope';
import { toBusinessSummary, type BusinessSummary } from '@/server/business/summary';
import { SHOP_NAME_MAX_LENGTH } from '@/lib/policy';
import { SUPPLIER_PAYABLE_ACCOUNT_NAME } from '@/server/ledger/accounts';

// Onboarding (ARCHITECTURE.md §7.2): one idempotent transaction creates the
// business, its payout settings and the explicit-role starter chart.

export const onboardingInputSchema = z.strictObject({
  shopName: z.string().trim().min(1).max(SHOP_NAME_MAX_LENGTH),
});
export type OnboardingInput = z.output<typeof onboardingInputSchema>;

// Payout settings (PRODUCT.md §5 rule 15: configurable per business, never hard-coded in logic).
export const PAYOUT_ELIGIBILITY_DELAY_DAYS_KEY = 'payout_eligibility_delay_days';
export const PAYOUT_WEEKDAY_KEY = 'payout_weekday';
export const DEFAULT_PAYOUT_ELIGIBILITY_DELAY_DAYS = 14;
export const DEFAULT_PAYOUT_WEEKDAY = 'MONDAY';

/** BASE = the business's base currency (USD by default). USD/PKR are fixed by the posting rules. */
export type StarterCurrency = 'BASE' | 'USD' | 'PKR';

export interface StarterAccountSpec {
  readonly name: string;
  readonly accountType: FinancialAccountType;
  readonly accountRole: FinancialAccountRole;
  readonly currency: StarterCurrency;
}

/**
 * ARCHITECTURE.md §7.2 starter chart. TRANSFER_CLEARING exists in USD (the
 * Payoneer withdrawal principal is USD) and PKR (bank receipts), BANK is PKR,
 * everything else uses the base currency. No REFUND account until PRODUCT.md
 * D5 is decided; no undocumented PKR expense accounts. Supplier Payable is a
 * LIABILITY with the existing UNCLASSIFIED role (A25): confirmed supplier
 * purchases credit it, and Phase 3 settles it from the paying asset.
 */
export const STARTER_CHART: readonly StarterAccountSpec[] = [
  { name: 'Etsy Receivable', accountType: 'ASSET', accountRole: 'ETSY_RECEIVABLE', currency: 'BASE' },
  { name: 'Etsy Payout Clearing', accountType: 'ASSET', accountRole: 'ETSY_PAYOUT_CLEARING', currency: 'BASE' },
  { name: 'Payoneer', accountType: 'ASSET', accountRole: 'PAYONEER', currency: 'BASE' },
  { name: 'Transfer Clearing', accountType: 'ASSET', accountRole: 'TRANSFER_CLEARING', currency: 'USD' },
  { name: 'Transfer Clearing', accountType: 'ASSET', accountRole: 'TRANSFER_CLEARING', currency: 'PKR' },
  { name: 'Bank', accountType: 'ASSET', accountRole: 'BANK', currency: 'PKR' },
  { name: 'Supplier Costs', accountType: 'EXPENSE', accountRole: 'SUPPLIER_COST', currency: 'BASE' },
  { name: 'Direct Expenses', accountType: 'EXPENSE', accountRole: 'DIRECT_EXPENSE', currency: 'BASE' },
  { name: 'Shared Expenses', accountType: 'EXPENSE', accountRole: 'SHARED_EXPENSE', currency: 'BASE' },
  { name: 'Etsy Revenue', accountType: 'INCOME', accountRole: 'REVENUE', currency: 'BASE' },
  { name: SUPPLIER_PAYABLE_ACCOUNT_NAME, accountType: 'LIABILITY', accountRole: 'UNCLASSIFIED', currency: 'BASE' },
];

export const AUDIT_ACTION_CREATE = 'CREATE';
export const AUDIT_ENTITY_BUSINESS = 'business_account';
export const AUDIT_ENTITY_SETTING = 'account_setting';
export const AUDIT_ENTITY_FINANCIAL_ACCOUNT = 'financial_account';

export interface OnboardingResult {
  readonly business: BusinessSummary;
  /** False when the user was already onboarded (retry, race or second attempt). */
  readonly created: boolean;
}

export interface OnboardingOptions {
  readonly starterChart?: readonly StarterAccountSpec[];
}

/**
 * Creates the session user's business exactly once. Retries, concurrent
 * requests and second attempts return the existing business unchanged.
 * Resolves only after COMMIT; any failure rolls everything back.
 */
export function onboardBusiness(db: Database, session: SessionContext, input: OnboardingInput, options: OnboardingOptions = {}): Promise<OnboardingResult> {
  return runInTransaction(db, (tx) => onboardInTransaction(tx, session, input, options));
}

export async function onboardInTransaction(tx: DbExecutor, session: SessionContext, input: OnboardingInput, options: OnboardingOptions = {}): Promise<OnboardingResult> {
  const business = await insertBusinessIfAbsent(tx, session.userId, { shopName: input.shopName });
  if (!business) {
    // The unique owner index already holds a committed business for this user.
    const existing = await findBusinessByOwner(tx, session.userId);
    if (!existing) throw new Error('Onboarding conflict without an existing business');
    return { business: toBusinessSummary(existing), created: false };
  }

  const scope = tenantScope(tx, tenantForOwnedBusiness(session, business));
  const settings = await insertAccountSettings(scope, [
    { settingKey: PAYOUT_ELIGIBILITY_DELAY_DAYS_KEY, settingValue: DEFAULT_PAYOUT_ELIGIBILITY_DELAY_DAYS },
    { settingKey: PAYOUT_WEEKDAY_KEY, settingValue: DEFAULT_PAYOUT_WEEKDAY },
  ]);
  const chart = options.starterChart ?? STARTER_CHART;
  const accounts = await insertFinancialAccounts(scope, chart.map((spec) => ({
    name: spec.name,
    accountType: spec.accountType,
    accountRole: spec.accountRole,
    currency: spec.currency === 'BASE' ? business.baseCurrency : spec.currency,
  })));

  const entries: AuditEntry[] = [
    {
      entityType: AUDIT_ENTITY_BUSINESS, entityId: business.id, action: AUDIT_ACTION_CREATE, beforeData: null,
      afterData: { shopName: business.shopName, baseCurrency: business.baseCurrency, timezone: business.timezone },
    },
    ...settings.map((setting) => ({
      entityType: AUDIT_ENTITY_SETTING, entityId: setting.id, action: AUDIT_ACTION_CREATE, beforeData: null,
      afterData: { settingKey: setting.settingKey, settingValue: setting.settingValue },
    })),
    ...accounts.map((account) => ({
      entityType: AUDIT_ENTITY_FINANCIAL_ACCOUNT, entityId: account.id, action: AUDIT_ACTION_CREATE, beforeData: null,
      afterData: { name: account.name, accountType: account.accountType, accountRole: account.accountRole, currency: account.currency },
    })),
  ];
  await insertAuditLogs(scope, entries);

  return { business: toBusinessSummary(business), created: true };
}
