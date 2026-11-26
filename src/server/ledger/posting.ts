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
