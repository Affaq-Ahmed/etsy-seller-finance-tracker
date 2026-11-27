import 'server-only';
import { z } from 'zod';
import { instantToZonedDate, zonedDateToInstant } from '@/lib/dates';
import { EXPENSE_CATEGORY_TYPES, EXPENSE_REVERSAL_REASON_MAX_LENGTH, PAYONEER_FEE_CATEGORY_TYPE } from '@/lib/expenses';
import { formatDbMoney, parseDbMoney, parseMoneyInput, toDbMoney } from '@/lib/money';
import { findPiiProblem } from '@/lib/validation';
import type { Database, DbExecutor } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { loadBusinessContext, resolveRecordCurrency } from '@/server/business/context';
import { insertAuditLogs } from '@/server/dal/audit-logs';
import { findExpenseCategoryById } from '@/server/dal/expense-categories';
import {
  countExpenses, findExpenseDetailRow, findExpenseForUpdate, insertExpense, listExpenses as listExpenseRows, updateExpense,
  type ExpenseListRow,
} from '@/server/dal/expenses';
import { lockOrdersForUpdate } from '@/server/dal/orders';
import { tenantScope, type PageRequest, type TenantScope } from '@/server/dal/tenant-scope';
import { invalidState, notFound, unprocessable } from '@/server/domain/errors';
import { runInTransaction } from '@/server/db/transaction';
import { toPage, type Page } from '@/server/http/pagination';
import { ensureExpensesPayableAccount, resolveExpenseAccount } from '@/server/ledger/accounts';
import { findExpensePosting, postExpense, reverseExpensePosting } from '@/server/ledger/posting';
import { calendarDateField, currencyField, moneyField, notesField, referenceField, uuidField } from '@/server/validation/fields';
import { assertCategoryUsableForPosting, assertManualCategoryType, ensureExpenseCategory } from './categories';

// ---------------------------------------------------------------- input schemas

/** The reserved Payoneer-fee type is accepted by the schema so that the block answers 422 with its own code. */
const requestedCategoryTypeSchema = z.enum([...EXPENSE_CATEGORY_TYPES, PAYONEER_FEE_CATEGORY_TYPE]);

export const createExpenseSchema = z.strictObject({
  expenseType: z.enum(['DIRECT', 'SHARED']),
  /** Required for a DIRECT expense, forbidden for a SHARED one. */
  orderId: uuidField.optional(),
  categoryType: requestedCategoryTypeSchema,
  /** Above zero, at most 2 decimals, as a string (never a JSON number). */
  amount: moneyField,
  currency: currencyField.optional(),
  expenseDate: calendarDateField,
  description: notesField.optional(),
  sourceReference: referenceField.nullable().optional(),
}).refine(
  (expense) => (expense.expenseType === 'DIRECT' ? expense.orderId !== undefined : expense.orderId === undefined),
  { path: ['orderId'] },
);
export type CreateExpenseInput = z.output<typeof createExpenseSchema>;

export const reverseExpenseSchema = z.strictObject({
  reason: z.string().trim().min(1).max(EXPENSE_REVERSAL_REASON_MAX_LENGTH).refine((value) => findPiiProblem(value) === null),
});
export type ReverseExpenseInput = z.output<typeof reverseExpenseSchema>;

// ---------------------------------------------------------------------- views

export type ExpenseEffectiveStatus = 'DRAFT' | 'CONFIRMED' | 'REVERSED' | 'VOIDED';

export interface ExpenseView {
  readonly id: string;
  readonly expenseType: 'DIRECT' | 'SHARED';
  readonly orderId: string | null;
  readonly etsyOrderId: string | null;
  readonly categoryName: string;
  readonly categoryType: string;
  readonly amount: string;
  readonly currency: string;
  /** Calendar date in the business timezone. */
  readonly expenseDate: string;
  readonly description: string | null;
  readonly sourceReference: string | null;
  /** The stored status. A reversed expense stays CONFIRMED (posted rows are immutable). */
  readonly status: 'DRAFT' | 'CONFIRMED' | 'VOIDED';
  /** What users see: REVERSED when the expense's posting has been reversed. */
  readonly effectiveStatus: ExpenseEffectiveStatus;
  /** The confirmation instant: the INITIAL journal entry's finalization time. */
  readonly confirmedAt: string | null;
  /** The confirmation's calendar date in the business timezone (use this for display). */
  readonly confirmedDate: string | null;
  readonly createdAt: string;
}

export interface ExpenseDetail {
  readonly expense: ExpenseView;
  readonly canConfirm: boolean;
  readonly canVoid: boolean;
  readonly canReverse: boolean;
}

export function effectiveStatusOf(row: Pick<ExpenseListRow, 'reversed' | 'status'>): ExpenseEffectiveStatus {
  return row.reversed ? 'REVERSED' : row.status;
}

export function toExpenseView(row: ExpenseListRow, timeZone: string): ExpenseView {
  return {
    id: row.id,
    expenseType: row.expenseType,
    orderId: row.orderId,
    etsyOrderId: row.etsyOrderId,
    categoryName: row.categoryName,
    categoryType: row.categoryType,
    amount: formatDbMoney(row.amount),
    currency: row.currency,
    expenseDate: instantToZonedDate(row.expenseDate, timeZone),
    description: row.description,
    sourceReference: row.sourceReference,
    status: row.status,
    effectiveStatus: effectiveStatusOf(row),
    confirmedAt: row.postedAt ? row.postedAt.toISOString() : null,
    confirmedDate: row.postedAt ? instantToZonedDate(row.postedAt, timeZone) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function buildExpenseDetail(scope: TenantScope, expenseId: string, timeZone: string): Promise<ExpenseDetail> {
  const row = await findExpenseDetailRow(scope, expenseId);
  if (!row) throw notFound('Expense');
  return {
    expense: toExpenseView(row, timeZone),
    canConfirm: row.status === 'DRAFT',
    canVoid: row.status === 'DRAFT',
    canReverse: row.status === 'CONFIRMED' && !row.reversed,
  };
}

function requireMoney(text: string) {
  const parsed = parseMoneyInput(text);
  if (parsed === null) throw new Error('Money input escaped validation');
  return parsed;
}

// ------------------------------------------------------------------ operations

/**
 * Creates a DRAFT expense. Nothing is posted and nothing counts toward profit.
 *
 * Lock order (ARCHITECTURE.md A35, A38): for a DIRECT expense the order row is
 * locked FIRST, before the first write (the category insert and the expense
 * insert take the tenant lock). The fixed category row is created lazily and
 * audited after that lock and before the expense insert.
 */
export function createExpense(db: Database, tenant: TenantContext, input: CreateExpenseInput): Promise<ExpenseDetail> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const business = await loadBusinessContext(tx, tenant);
    const currency = resolveRecordCurrency(input.currency, business);
    assertManualCategoryType(input.categoryType);
    const amount = requireMoney(input.amount);
    if (amount <= BigInt(0)) throw unprocessable('EXPENSE_AMOUNT_REQUIRED', 'An expense amount must be above zero.', ['amount']);

    // The API schema already enforces this; the service repeats it so no other caller can link a shared expense to an order.
    if (input.expenseType === 'SHARED' && input.orderId !== undefined) {
      throw unprocessable('ORDER_NOT_ALLOWED', 'A shared expense does not belong to an order.', ['orderId']);
    }
    let orderId: string | null = null;
    if (input.expenseType === 'DIRECT') {
      if (input.orderId === undefined) throw unprocessable('ORDER_NOT_FOUND', 'Order not found.', ['orderId']);
      // A foreign tenant's order is simply absent from the tenant-scoped lock query.
      const [order] = await lockOrdersForUpdate(scope, [input.orderId]);
      if (!order) throw unprocessable('ORDER_NOT_FOUND', 'Order not found.', ['orderId']);
      if (order.currency !== currency) throw unprocessable('CURRENCY_MISMATCH', 'An expense and its order must use the same currency.', ['currency']);
      orderId = order.id;
    }

    const category = await ensureExpenseCategory(scope, input.categoryType);
    const expense = await insertExpense(scope, {
      categoryId: category.id,
      orderId,
      expenseType: input.expenseType,
      amount: toDbMoney(amount),
      currency,
      expenseDate: zonedDateToInstant(input.expenseDate, business.timeZone),
      description: input.description ?? null,
      sourceReference: input.sourceReference ?? null,
      status: 'DRAFT',
    });
    // The description and reference are free text and are never copied into audit data.
    await insertAuditLogs(scope, [{
      entityType: 'expense', entityId: expense.id, action: 'CREATE', beforeData: null,
      afterData: { status: 'DRAFT', expenseType: expense.expenseType, categoryId: expense.categoryId, orderId: expense.orderId, amount: expense.amount, currency },
    }]);
    return buildExpenseDetail(scope, expense.id, business.timeZone);
  });
}

export async function listExpenses(db: Database, tenant: TenantContext, request: PageRequest): Promise<Page<ExpenseView>> {
  const scope = tenantScope(db, tenant);
  const business = await loadBusinessContext(db, tenant);
  const [rows, total] = await Promise.all([listExpenseRows(scope, request), countExpenses(scope)]);
  return toPage(rows.map((row) => toExpenseView(row, business.timeZone)), request, total);
}

export async function getExpenseDetail(db: Database, tenant: TenantContext, expenseId: string): Promise<ExpenseDetail> {
  const scope = tenantScope(db, tenant);
  const business = await loadBusinessContext(db, tenant);
  return buildExpenseDetail(scope, expenseId, business.timeZone);
}

/** Voids a DRAFT expense. Nothing was posted, so nothing is reversed. A repeat is a no-op; a confirmed expense is reversed instead. */
export function voidExpense(db: Database, tenant: TenantContext, expenseId: string): Promise<ExpenseDetail> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const business = await loadBusinessContext(tx, tenant);
    const expense = await findExpenseForUpdate(scope, expenseId);
    if (!expense) throw notFound('Expense');
    if (expense.status === 'VOIDED') return buildExpenseDetail(scope, expense.id, business.timeZone);
    if (expense.status !== 'DRAFT') throw invalidState('EXPENSE_NOT_VOIDABLE', 'Only a draft expense can be voided. Reverse a confirmed expense instead.');
    await updateExpense(scope, expense.id, { status: 'VOIDED' });
    await insertAuditLogs(scope, [{ entityType: 'expense', entityId: expense.id, action: 'VOID', beforeData: { status: 'DRAFT' }, afterData: { status: 'VOIDED' } }]);
    return buildExpenseDetail(scope, expense.id, business.timeZone);
  });
}

export interface ConfirmExpenseResult {
  readonly detail: ExpenseDetail;
  readonly journalEntryId: string | null;
  /** True when the expense had already been confirmed; nothing was posted by this call. */
  readonly alreadyConfirmed: boolean;
}

/**
 * Confirms a draft expense: the status change, the finalized journal (debit
 * DIRECT_EXPENSE or SHARED_EXPENSE, credit Expenses Payable) and the audit trail
 * commit together or not at all. Idempotent: the expense row is locked first, so
 * concurrent or repeated confirmations return the one existing posting.
 * Resolves only after COMMIT, when the database re-validates balance and the
 * posting rule.
 */
export function confirmExpense(db: Database, tenant: TenantContext, expenseId: string): Promise<ConfirmExpenseResult> {
  return runInTransaction(db, (tx) => confirmExpenseInTransaction(tx, tenant, expenseId));
}

export async function confirmExpenseInTransaction(tx: DbExecutor, tenant: TenantContext, expenseId: string): Promise<ConfirmExpenseResult> {
  const scope = tenantScope(tx, tenant);
  const business = await loadBusinessContext(tx, tenant);
  // Lock order (A35, A38): expense row, then the order row, then the first write.
  const expense = await findExpenseForUpdate(scope, expenseId);
  if (!expense) throw notFound('Expense');

  if (expense.status === 'CONFIRMED') {
    const entry = await findExpensePosting(scope, expense.id);
    return { detail: await buildExpenseDetail(scope, expense.id, business.timeZone), journalEntryId: entry?.id ?? null, alreadyConfirmed: true };
  }
  if (expense.status !== 'DRAFT') throw invalidState('EXPENSE_NOT_CONFIRMABLE', 'Only a draft expense can be confirmed.');

  const amount = parseDbMoney(expense.amount);
  if (amount <= BigInt(0)) throw unprocessable('EXPENSE_AMOUNT_REQUIRED', 'An expense amount must be above zero to be confirmed. Void the draft instead.', ['amount']);
  if (expense.currency !== business.baseCurrency) {
    throw unprocessable('CURRENCY_NOT_SUPPORTED', `Expenses must use the business currency (${business.baseCurrency}); currency conversion is not available yet.`, ['currency']);
  }
  // Re-read the stored category against the six-type allowlist (never the name): fails closed.
  assertCategoryUsableForPosting(await findExpenseCategoryById(scope, expense.categoryId));

  if (expense.expenseType === 'DIRECT') {
    // Locked BEFORE the first write. There is deliberately no status check: a DIRECT expense on a
    // cancelled order stays valid and counts toward profit (PRODUCT.md §6.3, ARCHITECTURE.md A38).
    const [order] = expense.orderId === null ? [] : await lockOrdersForUpdate(scope, [expense.orderId]);
    if (!order) throw unprocessable('ORDER_NOT_FOUND', 'Order not found.', ['orderId']);
    if (order.currency !== expense.currency) throw unprocessable('CURRENCY_MISMATCH', 'An expense and its order must use the same currency.', ['currency']);
  }

  const expenseAccount = await resolveExpenseAccount(scope, expense.expenseType, expense.currency);
  const payableAccount = await ensureExpensesPayableAccount(scope, expense.currency);

  // The status update must come BEFORE the journal is finalized: once a non-DRAFT journal exists the
  // posted-source guard rejects any update of the expense.
  const confirmed = await updateExpense(scope, expense.id, { status: 'CONFIRMED' });
  if (!confirmed) throw notFound('Expense');
  const entry = await postExpense(scope, {
    expenseId: expense.id,
    currency: expense.currency,
    amount,
    transactionDate: expense.expenseDate,
    expenseAccountId: expenseAccount.id,
    payableAccountId: payableAccount.id,
  });
  await insertAuditLogs(scope, [{
    entityType: 'expense', entityId: expense.id, action: 'CONFIRM', beforeData: { status: 'DRAFT' },
    afterData: { status: 'CONFIRMED', journalEntryId: entry.id, amount: confirmed.amount, currency: confirmed.currency },
  }]);
  return { detail: await buildExpenseDetail(scope, expense.id, business.timeZone), journalEntryId: entry.id, alreadyConfirmed: false };
}

export interface ReverseExpenseResult {
  readonly detail: ExpenseDetail;
  /** True when the expense had already been reversed; nothing was posted by this call. */
  readonly alreadyReversed: boolean;
}

/**
 * Corrects a confirmed expense by reversing its posting with the exact opposite
 * entry. The original journal and the expense row are never edited. The expense
 * then shows as REVERSED and leaves actual profit; a corrected expense is
 * entered as a new one.
 */
export function reverseExpense(db: Database, tenant: TenantContext, expenseId: string, input: ReverseExpenseInput): Promise<ReverseExpenseResult> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const business = await loadBusinessContext(tx, tenant);
    const expense = await findExpenseForUpdate(scope, expenseId);
    if (!expense) throw notFound('Expense');
    if (expense.status !== 'CONFIRMED') throw invalidState('EXPENSE_NOT_CONFIRMED', 'Only a confirmed expense can be reversed.');
    const original = await findExpensePosting(scope, expense.id);
    if (!original) throw invalidState('EXPENSE_HAS_NO_POSTING', 'This expense has no posting to reverse.');

    const { reversalId, alreadyReversed } = await reverseExpensePosting(scope, expense.id, original, new Date());
    if (!alreadyReversed) {
      await insertAuditLogs(scope, [{
        entityType: 'expense', entityId: expense.id, action: 'REVERSE', beforeData: { journalEntryId: original.id },
        afterData: { reversalEntryId: reversalId, reason: input.reason },
      }]);
    }
    return { detail: await buildExpenseDetail(scope, expense.id, business.timeZone), alreadyReversed };
  });
}
