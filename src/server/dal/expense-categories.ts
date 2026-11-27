import 'server-only';
import { and, eq } from 'drizzle-orm';
import { expenseCategories } from '@/db/schema';
import type { TenantInsert, TenantRow, TenantScope } from './tenant-scope';

export type ExpenseCategoryRow = TenantRow<typeof expenseCategories>;
export type ExpenseCategoryInsert = TenantInsert<typeof expenseCategories>;

/** Categories with this exact name (the unique index allows at most one per tenant). */
export function listExpenseCategoriesByName(scope: TenantScope, name: string): Promise<ExpenseCategoryRow[]> {
  return scope.executor.select().from(expenseCategories)
    .where(and(scope.tenantEq(expenseCategories), eq(expenseCategories.name, name)));
}

/** Another tenant's ID yields null, exactly like an ID that does not exist. */
export async function findExpenseCategoryById(scope: TenantScope, id: string): Promise<ExpenseCategoryRow | null> {
  const [row] = await scope.select(expenseCategories, eq(expenseCategories.id, id));
  return row ?? null;
}

/**
 * Creates the category unless one with the same name exists in the tenant.
 * Returns the created row, or null when it already existed. Idempotent and
 * race-safe through the unique (account_id, name) index: a concurrent insert of
 * the same name waits for the first transaction, then does nothing.
 */
export async function insertExpenseCategoryIfAbsent(scope: TenantScope, values: ExpenseCategoryInsert): Promise<ExpenseCategoryRow | null> {
  const [row] = await scope.executor.insert(expenseCategories)
    .values({ ...values, accountId: scope.tenant.accountId })
    .onConflictDoNothing({ target: [expenseCategories.accountId, expenseCategories.name] })
    .returning();
  return row ?? null;
}
