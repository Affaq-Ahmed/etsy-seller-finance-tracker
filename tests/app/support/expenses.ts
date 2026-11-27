import type postgres from 'postgres';
import { parseDbMoney } from '@/lib/money';
import type { AppContainer } from '@/server/container';
import { confirmExpense, createExpense, type CreateExpenseInput, type ExpenseDetail } from '@/server/expenses/service';
import type { OrderDetail } from '@/server/orders/service';
import type { OnboardedUser } from './app';

export const EXPENSE_DATE = '2026-11-21';

/** A DRAFT shared expense (software subscription, 19.99) unless overridden. */
export function makeSharedExpense(app: AppContainer, user: OnboardedUser, overrides: Partial<CreateExpenseInput> = {}): Promise<ExpenseDetail> {
  return createExpense(app.db, user.tenant, {
    expenseType: 'SHARED', categoryType: 'SOFTWARE_SUBSCRIPTION', amount: '19.99', expenseDate: EXPENSE_DATE, ...overrides,
  });
}

/** A DRAFT direct expense (shipping, 4.25) on an order unless overridden. */
export function makeDirectExpense(app: AppContainer, user: OnboardedUser, order: OrderDetail, overrides: Partial<CreateExpenseInput> = {}): Promise<ExpenseDetail> {
  return createExpense(app.db, user.tenant, {
    expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'SHIPPING', amount: '4.25', expenseDate: EXPENSE_DATE, ...overrides,
  });
}

export async function confirmedDirectExpense(app: AppContainer, user: OnboardedUser, order: OrderDetail, overrides: Partial<CreateExpenseInput> = {}): Promise<ExpenseDetail> {
  const draft = await makeDirectExpense(app, user, order, overrides);
  await confirmExpense(app.db, user.tenant, draft.expense.id);
  return draft;
}

/** All journal entries of an expense (any event), oldest first. */
export function journalOfExpense(raw: postgres.Sql, tenantId: string, expenseId: string) {
  // A reversal is recorded as an 'adjustment' entry that points at its original through reversal_of_entry_id.
  return raw`SELECT * FROM journal_entries WHERE account_id = ${tenantId}
    AND ((source_type = 'expense' AND source_id = ${expenseId})
      OR reversal_of_entry_id IN (SELECT id FROM journal_entries WHERE account_id = ${tenantId} AND source_type = 'expense' AND source_id = ${expenseId}))
    ORDER BY created_at, id`;
}

export function linesOfEntry(raw: postgres.Sql, journalId: string) {
  return raw`SELECT fa.name, fa.account_role, fa.account_type, l.debit_amount::text AS debit, l.credit_amount::text AS credit
    FROM journal_lines l JOIN financial_accounts fa ON fa.id = l.financial_account_id WHERE l.journal_entry_id = ${journalId}
    ORDER BY l.debit_amount DESC, fa.name`;
}

/** Net balance (debits minus credits) of a tenant's finalized journal lines on accounts matching `column = value`, as exact scale-4 integer (SQL returns a bare 0 for no rows). */
export async function netBalance(raw: postgres.Sql, tenantId: string, column: 'account_role' | 'name', value: string): Promise<bigint> {
  const rows = column === 'account_role'
    ? await raw`SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS balance FROM journal_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'FINALIZED'
        JOIN financial_accounts fa ON fa.id = l.financial_account_id WHERE e.account_id = ${tenantId} AND fa.account_role = ${value}`
    : await raw`SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS balance FROM journal_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'FINALIZED'
        JOIN financial_accounts fa ON fa.id = l.financial_account_id WHERE e.account_id = ${tenantId} AND fa.name = ${value}`;
  return parseDbMoney(String(rows[0]?.balance));
}
