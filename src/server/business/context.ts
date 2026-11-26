import 'server-only';
import type { DbExecutor } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { getTenantBusiness } from '@/server/dal/business-accounts';
import { notFound, unprocessable } from '@/server/domain/errors';

/** The business settings that interpret amounts and calendar dates. */
export interface BusinessContext {
  /** Phase 2 records money only in this currency (USD by default); there is no FX yet. */
  readonly baseCurrency: string;
  /** IANA timezone in which users' calendar dates are interpreted and displayed. */
  readonly timeZone: string;
}

export async function loadBusinessContext(executor: DbExecutor, tenant: TenantContext): Promise<BusinessContext> {
  const business = await getTenantBusiness(executor, tenant);
  if (!business) throw notFound('Business');
  return { baseCurrency: business.baseCurrency, timeZone: business.timezone };
}

/**
 * Phase 2 supports only the business currency: no conversion exists, and USD
 * and PKR are never mixed without an explicit conversion (PRODUCT.md §6.2).
 */
export function resolveRecordCurrency(requested: string | undefined, business: BusinessContext): string {
  const currency = requested ?? business.baseCurrency;
  if (currency !== business.baseCurrency) {
    throw unprocessable('CURRENCY_NOT_SUPPORTED', `Records must use the business currency (${business.baseCurrency}); currency conversion is not available yet.`, ['currency']);
  }
  return currency;
}

