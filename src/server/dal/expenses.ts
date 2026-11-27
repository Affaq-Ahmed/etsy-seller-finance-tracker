import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { expenseCategories, expenses, orders } from '@/db/schema';
import { expenseIsReversedSql } from './journal';
import {
  countTenantRows, expectRow, type PageRequest, type TenantInsert, type TenantRow, type TenantScope, type TenantUpdate,
} from './tenant-scope';

export type ExpenseRow = TenantRow<typeof expenses>;
export type ExpenseInsert = TenantInsert<typeof expenses>;
export type ExpenseUpdate = TenantUpdate<typeof expenses>;

/** An expense with its category, its order's Etsy ID, whether its posting was reversed, and when it was posted. */
export interface ExpenseListRow extends ExpenseRow {
  readonly categoryName: string;
  readonly categoryType: string;
  readonly etsyOrderId: string | null;
  readonly reversed: boolean;
  /** `finalized_at` of the INITIAL journal entry: the confirmation instant (the table has no confirmed_at). */
  readonly postedAt: Date | null;
}

export async function insertExpense(scope: TenantScope, values: ExpenseInsert): Promise<ExpenseRow> {
  return expectRow(await scope.insert(expenses, [values]));
}

/**
 * Row-locks the expense for the rest of the transaction (serializes confirm,
 * void and reverse). Lock order (ARCHITECTURE.md A35, A38): expense row, then
 * the order row, then the first write.
 */
export async function findExpenseForUpdate(scope: TenantScope, id: string): Promise<ExpenseRow | null> {
  const [row] = await scope.executor.select().from(expenses)
    .where(and(scope.tenantEq(expenses), eq(expenses.id, id))).for('update');
  return row ?? null;
}

/** The table has no `updated_at`; only the status ever changes after creation. */
export async function updateExpense(scope: TenantScope, id: string, values: ExpenseUpdate): Promise<ExpenseRow | null> {
  const [row] = await scope.update(expenses, values, eq(expenses.id, id));
  return row ?? null;
}

function listSelection() {
  return {
    expense: expenses,
    categoryName: expenseCategories.name,
    categoryType: expenseCategories.categoryType,
    etsyOrderId: orders.etsyOrderId,
    reversed: expenseIsReversedSql(expenses.accountId, expenses.id),
    // Raw SQL skips column mapping: the instant arrives as ISO-8601 text.
    postedAt: sql<string | null>`(
      SELECT to_json(posted.finalized_at) #>> '{}' FROM journal_entries posted
      WHERE posted.account_id = ${expenses.accountId} AND posted.source_type = 'expense'
        AND posted.source_id = ${expenses.id} AND posted.source_event = 'INITIAL' AND posted.status = 'FINALIZED')`,
  };
}

type ListSelectionRow = {
  expense: ExpenseRow; categoryName: string; categoryType: string; etsyOrderId: string | null; reversed: boolean; postedAt: string | null;
};

function toListRow(row: ListSelectionRow): ExpenseListRow {
  return {
    ...row.expense,
    categoryName: row.categoryName,
    categoryType: row.categoryType,
    etsyOrderId: row.etsyOrderId,
    reversed: row.reversed,
    postedAt: row.postedAt === null ? null : new Date(row.postedAt),
  };
}

/** Joins constrain every table with the session tenant; the order join is optional (SHARED expenses have none). */
function listQuery(scope: TenantScope) {
  return scope.executor.select(listSelection()).from(expenses)
    .innerJoin(expenseCategories, and(eq(expenseCategories.accountId, expenses.accountId), eq(expenseCategories.id, expenses.categoryId), scope.tenantEq(expenseCategories)))
    .leftJoin(orders, and(eq(orders.accountId, expenses.accountId), eq(orders.id, expenses.orderId), scope.tenantEq(orders)));
}

/** Another tenant's ID yields null, exactly like an ID that does not exist. */
export async function findExpenseDetailRow(scope: TenantScope, id: string): Promise<ExpenseListRow | null> {
  const [row] = await listQuery(scope).where(and(scope.tenantEq(expenses), eq(expenses.id, id)));
  return row ? toListRow(row) : null;
}

/** Newest first; the ID breaks ties so pages are stable. */
export async function listExpenses(scope: TenantScope, page: PageRequest): Promise<ExpenseListRow[]> {
  const rows = await listQuery(scope).where(scope.tenantEq(expenses))
    .orderBy(desc(expenses.createdAt), desc(expenses.id))
    .limit(page.limit).offset(page.offset);
  return rows.map(toListRow);
}

export function countExpenses(scope: TenantScope): Promise<number> {
  return countTenantRows(scope, expenses);
}

/** The expenses recorded against one order, newest expense date first. */
export async function listExpensesForOrder(scope: TenantScope, orderId: string): Promise<ExpenseListRow[]> {
  const rows = await listQuery(scope)
    .where(and(scope.tenantEq(expenses), eq(expenses.orderId, orderId)))
    .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt), desc(expenses.id));
  return rows.map(toListRow);
}
