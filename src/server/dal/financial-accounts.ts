import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
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

/** Active accounts with a given role and currency, oldest first. */
export function listActiveAccountsByRole(scope: TenantScope, role: FinancialAccountRole, currency: string): Promise<FinancialAccountRow[]> {
  return scope.executor.select().from(financialAccounts)
    .where(and(
      scope.tenantEq(financialAccounts), eq(financialAccounts.accountRole, role),
      eq(financialAccounts.currency, currency), eq(financialAccounts.isActive, true),
    ))
    .orderBy(asc(financialAccounts.createdAt), asc(financialAccounts.id));
}

/**
 * Active account looked up by exact name, type and currency. Used only for
 * accounts that deliberately have no role (the Supplier Payable liability, see
 * ARCHITECTURE.md A25); the application never renames or retypes accounts.
 */
export function listActiveAccountsByName(
  scope: TenantScope, name: string, type: FinancialAccountType, currency: string,
): Promise<FinancialAccountRow[]> {
  return scope.executor.select().from(financialAccounts)
    .where(and(
      scope.tenantEq(financialAccounts), eq(financialAccounts.name, name), eq(financialAccounts.accountType, type),
      eq(financialAccounts.currency, currency), eq(financialAccounts.isActive, true),
    ));
}

/**
 * Creates the account unless one with the same (name, currency) exists in the
 * tenant. Returns the created row, or null when it already existed. Idempotent
 * and race-safe through the unique (account_id, name, currency) index.
 */
export async function insertFinancialAccountIfAbsent(scope: TenantScope, values: FinancialAccountInsert): Promise<FinancialAccountRow | null> {
  const [row] = await scope.executor.insert(financialAccounts)
    .values({ ...values, accountId: scope.tenant.accountId })
    .onConflictDoNothing({ target: [financialAccounts.accountId, financialAccounts.name, financialAccounts.currency] })
    .returning();
  return row ?? null;
}
