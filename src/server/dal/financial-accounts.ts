import 'server-only';
import { eq } from 'drizzle-orm';
import { financialAccounts } from '@/db/schema';
import type { TenantInsert, TenantRow, TenantScope } from './tenant-scope';

export type FinancialAccountRow = TenantRow<typeof financialAccounts>;
export type FinancialAccountInsert = TenantInsert<typeof financialAccounts>;
export type FinancialAccountRole = FinancialAccountRow['accountRole'];
export type FinancialAccountType = FinancialAccountRow['accountType'];

export function insertFinancialAccounts(scope: TenantScope, rows: readonly FinancialAccountInsert[]): Promise<FinancialAccountRow[]> {
  return scope.insert(financialAccounts, rows);
}

export function listFinancialAccounts(scope: TenantScope): Promise<FinancialAccountRow[]> {
  return scope.select(financialAccounts);
}

/** Another tenant's ID yields null, exactly like an ID that does not exist. */
export async function findFinancialAccountById(scope: TenantScope, id: string): Promise<FinancialAccountRow | null> {
  const [row] = await scope.select(financialAccounts, eq(financialAccounts.id, id));
  return row ?? null;
}
