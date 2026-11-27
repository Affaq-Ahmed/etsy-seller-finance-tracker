import 'server-only';
import { toDbMoney, type Money } from '@/lib/money';
import {
  finalizeJournalEntry, findJournalEntryBySource, findFinalizedReversalOf, insertDraftJournalEntry, insertJournalLines,
  reverseJournalEntry, type JournalEntryRow,
} from '@/server/dal/journal';
import type { TenantScope } from '@/server/dal/tenant-scope';

// Deterministic event keys make postings idempotent: a repeat of the same
// event can only collide with itself (unique idempotency key and unique
// source event per tenant), never create a second journal.

export const SUPPLIER_PURCHASE_SOURCE = 'supplier_purchase';
export const INITIAL_EVENT = 'INITIAL';

export const supplierPurchaseInitialKey = (purchaseId: string) => `${SUPPLIER_PURCHASE_SOURCE}:${purchaseId}:${INITIAL_EVENT}`;
export const supplierPurchaseReversalKey = (purchaseId: string) => `${SUPPLIER_PURCHASE_SOURCE}:${purchaseId}:REVERSAL`;

export interface SupplierPurchasePosting {
  readonly purchaseId: string;
  readonly currency: string;
  /** Exact total of the purchase; must be positive. */
  readonly amount: Money;
  /** The purchase date, so the ledger date matches the purchase date. */
  readonly transactionDate: Date;
  readonly costAccountId: string;
  readonly payableAccountId: string;
}

/**
 * Posts a confirmed purchase: DEBIT SUPPLIER_COST, CREDIT Supplier Payable, for
 * the exact purchase total, in one finalized entry. Must run inside the
 * confirmation transaction; the database validates the posting rules, balance
 * and the "confirmation and journal commit together" rule at COMMIT.
 */
export async function postSupplierPurchase(scope: TenantScope, posting: SupplierPurchasePosting): Promise<JournalEntryRow> {
  if (posting.amount <= BigInt(0)) throw new Error('A supplier purchase posting needs a positive amount');
  const amount = toDbMoney(posting.amount);
  const entry = await insertDraftJournalEntry(scope, {
    sourceType: SUPPLIER_PURCHASE_SOURCE,
    sourceId: posting.purchaseId,
    sourceEvent: INITIAL_EVENT,
    currency: posting.currency,
    transactionDate: posting.transactionDate,
    description: 'Supplier purchase confirmed',
    idempotencyKey: supplierPurchaseInitialKey(posting.purchaseId),
  });
  await insertJournalLines(scope, [
    { journalEntryId: entry.id, financialAccountId: posting.costAccountId, debitAmount: amount, creditAmount: '0', currency: posting.currency },
    { journalEntryId: entry.id, financialAccountId: posting.payableAccountId, debitAmount: '0', creditAmount: amount, currency: posting.currency },
  ]);
  await finalizeJournalEntry(scope, entry.id, new Date());
  return entry;
}

export function findSupplierPurchasePosting(scope: TenantScope, purchaseId: string): Promise<JournalEntryRow | null> {
  return findJournalEntryBySource(scope, SUPPLIER_PURCHASE_SOURCE, purchaseId, INITIAL_EVENT);
}

/**
 * Reverses a purchase's INITIAL posting with the exact-opposite database
 * function. The original stays finalized and untouched. Returns the existing
 * reversal when one already exists (idempotent).
 */
export async function reverseSupplierPurchasePosting(
  scope: TenantScope, purchaseId: string, original: JournalEntryRow, reversedAt: Date,
): Promise<{ reversalId: string; alreadyReversed: boolean }> {
  const existing = await findFinalizedReversalOf(scope, original.id);
  if (existing) return { reversalId: existing.id, alreadyReversed: true };
  const reversalId = await reverseJournalEntry(scope, original.id, supplierPurchaseReversalKey(purchaseId), reversedAt);
  return { reversalId, alreadyReversed: false };
}

// ------------------------------------------------------------------- expenses

export const EXPENSE_SOURCE = 'expense';

export const expenseInitialKey = (expenseId: string) => `${EXPENSE_SOURCE}:${expenseId}:${INITIAL_EVENT}`;
export const expenseReversalKey = (expenseId: string) => `${EXPENSE_SOURCE}:${expenseId}:REVERSAL`;

export interface ExpensePosting {
  readonly expenseId: string;
  readonly currency: string;
  /** Exact amount of the expense; must be positive. */
  readonly amount: Money;
  /** The expense date, so the ledger date matches the expense date. */
  readonly transactionDate: Date;
  /** The DIRECT_EXPENSE or SHARED_EXPENSE account (by the expense's type). */
  readonly expenseAccountId: string;
  readonly payableAccountId: string;
}

/**
 * Posts a confirmed expense: DEBIT DIRECT_EXPENSE or SHARED_EXPENSE, CREDIT
 * Expenses Payable, for the exact amount, in one finalized entry. Must run
 * inside the confirmation transaction, AFTER the expense row was set to
 * CONFIRMED (the posted-source guard ignores DRAFT journals, so the update has
 * to come first). The database validates the posting rule and balance at COMMIT.
 * The journal description is fixed text: free text is never copied into the ledger.
 */
export async function postExpense(scope: TenantScope, posting: ExpensePosting): Promise<JournalEntryRow> {
  if (posting.amount <= BigInt(0)) throw new Error('An expense posting needs a positive amount');
  const amount = toDbMoney(posting.amount);
  const entry = await insertDraftJournalEntry(scope, {
    sourceType: EXPENSE_SOURCE,
    sourceId: posting.expenseId,
    sourceEvent: INITIAL_EVENT,
    currency: posting.currency,
    transactionDate: posting.transactionDate,
    description: 'Expense confirmed',
    idempotencyKey: expenseInitialKey(posting.expenseId),
  });
  await insertJournalLines(scope, [
    { journalEntryId: entry.id, financialAccountId: posting.expenseAccountId, debitAmount: amount, creditAmount: '0', currency: posting.currency },
    { journalEntryId: entry.id, financialAccountId: posting.payableAccountId, debitAmount: '0', creditAmount: amount, currency: posting.currency },
  ]);
  await finalizeJournalEntry(scope, entry.id, new Date());
  return entry;
}

export function findExpensePosting(scope: TenantScope, expenseId: string): Promise<JournalEntryRow | null> {
  return findJournalEntryBySource(scope, EXPENSE_SOURCE, expenseId, INITIAL_EVENT);
}

/**
 * Reverses an expense's INITIAL posting with the exact-opposite database
 * function. The original stays finalized and untouched. Returns the existing
 * reversal when one already exists (idempotent).
 */
export async function reverseExpensePosting(
  scope: TenantScope, expenseId: string, original: JournalEntryRow, reversedAt: Date,
): Promise<{ reversalId: string; alreadyReversed: boolean }> {
  const existing = await findFinalizedReversalOf(scope, original.id);
  if (existing) return { reversalId: existing.id, alreadyReversed: true };
  const reversalId = await reverseJournalEntry(scope, original.id, expenseReversalKey(expenseId), reversedAt);
  return { reversalId, alreadyReversed: false };
}
