import 'server-only';
import {
  EXPENSE_CATEGORY_NAMES, isManualCategoryType, PAYONEER_FEE_CATEGORY_TYPE, type ExpenseCategoryType,
} from '@/lib/expenses';
import { insertAuditLogs } from '@/server/dal/audit-logs';
import {
  insertExpenseCategoryIfAbsent, listExpenseCategoriesByName, type ExpenseCategoryRow,
} from '@/server/dal/expense-categories';
import type { TenantScope } from '@/server/dal/tenant-scope';
import { unprocessable } from '@/server/domain/errors';

// Expense categories (ARCHITECTURE.md A37). Only the six fixed types exist and
// each business gets its row lazily, on first use. Decisions are made from the
// stored `category_type` only, never from the editable name or a description.

const NOT_USABLE = 'CATEGORY_NOT_USABLE';

/** Refuses the reserved Payoneer-fee type: Payoneer fees come from Payoneer transactions (PRODUCT.md §6.3). */
export function assertManualCategoryType(type: string): asserts type is ExpenseCategoryType {
  if (type === PAYONEER_FEE_CATEGORY_TYPE) {
    throw unprocessable('PAYONEER_FEE_NOT_ALLOWED', 'Payoneer fees are recorded from Payoneer transactions, not as manual expenses.', ['categoryType']);
  }
  if (!isManualCategoryType(type)) throw unprocessable(NOT_USABLE, 'This expense category cannot be used.', ['categoryType']);
}

/**
 * The business's category row for a fixed type, created and audited on first
 * use inside the caller's transaction. Idempotent and race-safe: two parallel
 * first uses insert one row (the loser waits on the unique name index, then
 * re-reads it). Fails closed when a row with that name exists but has another
 * type, is inactive, or is ambiguous.
 */
export async function ensureExpenseCategory(scope: TenantScope, type: ExpenseCategoryType): Promise<ExpenseCategoryRow> {
  const name = EXPENSE_CATEGORY_NAMES[type];
  let found = await listExpenseCategoriesByName(scope, name);
  if (found.length === 0) {
    const created = await insertExpenseCategoryIfAbsent(scope, { name, categoryType: type });
    if (created) {
      await insertAuditLogs(scope, [{
        entityType: 'expense_category', entityId: created.id, action: 'CREATE', beforeData: null,
        afterData: { name: created.name, categoryType: created.categoryType, reason: 'expense_category_first_use' },
      }]);
    }
    found = await listExpenseCategoriesByName(scope, name);
  }
  const [category] = found;
  if (!category || found.length !== 1 || category.categoryType !== type || !category.isActive) {
    throw unprocessable(NOT_USABLE, 'This expense category cannot be used.', ['categoryType']);
  }
  return category;
}

/**
 * Confirmation re-reads the stored category against the six-type allowlist, so a
 * row retyped or created outside the application (including PAYONEER_FEE) can
 * never post. Fails closed.
 */
export function assertCategoryUsableForPosting(category: ExpenseCategoryRow | null): void {
  if (!category || !category.isActive || !isManualCategoryType(category.categoryType)) {
    throw unprocessable(NOT_USABLE, 'This expense category cannot be used, so the expense cannot be confirmed.');
  }
}
