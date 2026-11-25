import 'server-only';
import type { DbExecutor } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { getTenantBusiness, type BusinessAccountRow } from '@/server/dal/business-accounts';

/** What clients may see about the business. IDs and owner identity are not exposed. */
export interface BusinessSummary {
  readonly shopName: string;
  readonly baseCurrency: string;
  readonly timezone: string;
  readonly createdAt: string;
}

export function toBusinessSummary(row: BusinessAccountRow): BusinessSummary {
  return {
    shopName: row.shopName,
    baseCurrency: row.baseCurrency,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getBusinessSummary(db: DbExecutor, tenant: TenantContext): Promise<BusinessSummary | null> {
  const row = await getTenantBusiness(db, tenant);
  return row ? toBusinessSummary(row) : null;
}
