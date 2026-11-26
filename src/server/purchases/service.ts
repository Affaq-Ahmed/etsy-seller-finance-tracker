import 'server-only';
import { z } from 'zod';
import { instantToZonedDate, zonedDateToInstant } from '@/lib/dates';
import {
  formatDbMoney, formatMoney, isWithinMoneyLimit, multiplyByQuantity, parseDbMoney, parseMoneyInput, sumMoney, toDbMoney, type Money,
} from '@/lib/money';
import { findPiiProblem } from '@/lib/validation';
import type { Database, DbExecutor } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { loadBusinessContext, resolveRecordCurrency } from '@/server/business/context';
import { insertAuditLogs, type AuditEntry } from '@/server/dal/audit-logs';
import { findOrderItemsWithOrders } from '@/server/dal/order-items';
import { lockOrdersForUpdate, updateOrder } from '@/server/dal/orders';
import { findSupplierById } from '@/server/dal/suppliers';
import {
  countPurchases, findPurchaseForUpdate, findPurchaseWithSupplier, insertPurchase, listPurchases as listPurchaseRows,
  updatePurchase, type PurchaseListRow, type PurchaseUpdate,
} from '@/server/dal/supplier-purchases';
import {
  activePurchasedQuantities, deletePurchaseItems, insertPurchaseItems, listPurchaseLines, type PurchaseLineRow,
} from '@/server/dal/supplier-purchase-items';
import { tenantScope, type PageRequest, type TenantScope } from '@/server/dal/tenant-scope';
import { conflict, invalidState, notFound, unprocessable } from '@/server/domain/errors';
import { getPostgresConstraintName, getPostgresErrorCode, PG_UNIQUE_VIOLATION } from '@/server/db/errors';
import { runInTransaction } from '@/server/db/transaction';
import { toPage, type Page } from '@/server/http/pagination';
import { ensureSupplierPayableAccount, resolveSupplierCostAccount } from '@/server/ledger/accounts';
import { findSupplierPurchasePosting, postSupplierPurchase, reverseSupplierPurchasePosting } from '@/server/ledger/posting';
import { statusAudit } from '@/server/orders/service';
import {
  calendarDateField, currencyField, MAX_LINES_PER_PURCHASE, moneyField, notesField, quantityField, referenceField, urlField, uuidField,
} from '@/server/validation/fields';

const REFERENCE_CONSTRAINT = 'supplier_purchase_reference_uq';

// ---------------------------------------------------------------- input schemas

const purchaseLineSchema = z.strictObject({
  orderItemId: uuidField,
  quantity: quantityField,
  /** Exact unit price, at most 2 decimals. The line total is quantity x unit price, with no rounding. */
  unitCost: moneyField,
});
export type PurchaseLineInput = z.output<typeof purchaseLineSchema>;
const linesSchema = z.array(purchaseLineSchema).min(1).max(MAX_LINES_PER_PURCHASE);

export const createPurchaseSchema = z.strictObject({
  supplierId: uuidField,
  supplierOrderReference: referenceField.nullable().optional(),
  purchaseUrl: urlField.optional(),
  purchaseDate: calendarDateField,
  currency: currencyField.optional(),
  notes: notesField.optional(),
  /** A reversed purchase this one replaces; recorded in the notes. */
  replacesPurchaseId: uuidField.optional(),
  lines: linesSchema,
});
export type CreatePurchaseInput = z.output<typeof createPurchaseSchema>;

export const updatePurchaseSchema = z.strictObject({
  supplierId: uuidField.optional(),
  supplierOrderReference: referenceField.nullable().optional(),
  purchaseUrl: urlField.optional(),
  purchaseDate: calendarDateField.optional(),
  notes: notesField.optional(),
  lines: linesSchema.optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined));
export type UpdatePurchaseInput = z.output<typeof updatePurchaseSchema>;

export const REVERSAL_REASON_MAX_LENGTH = 500;
export const reversePurchaseSchema = z.strictObject({
  reason: z.string().trim().min(1).max(REVERSAL_REASON_MAX_LENGTH).refine((value) => findPiiProblem(value) === null),
});
export type ReversePurchaseInput = z.output<typeof reversePurchaseSchema>;

// ---------------------------------------------------------------------- views

export type PurchaseEffectiveStatus = 'DRAFT' | 'CONFIRMED' | 'REVERSED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export interface PurchaseView {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly supplierOrderReference: string | null;
  readonly purchaseUrl: string | null;
  /** Calendar date in the business timezone. */
  readonly purchaseDate: string | null;
  readonly totalAmount: string;
  readonly currency: string;
  /** The stored status. A reversed purchase stays CONFIRMED (confirmed rows are immutable). */
  readonly status: string;
  /** What users see: REVERSED when the purchase's posting has been reversed. */
  readonly effectiveStatus: PurchaseEffectiveStatus;
  readonly confirmedAt: string | null;
  /** The confirmation's calendar date in the business timezone (use this for display, not `confirmedAt`). */
  readonly confirmedDate: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PurchaseLineView {
  readonly id: string;
  readonly orderItemId: string;
  readonly orderId: string;
  readonly etsyOrderId: string;
  readonly productName: string;
  readonly orderedQuantity: number;
  readonly quantity: number;
  readonly unitCost: string;
  readonly totalCost: string;
  readonly currency: string;
}

export interface PurchaseWarning {
  readonly code: 'QUANTITY_EXCEEDS_ORDERED';
  readonly orderItemId: string;
  readonly productName: string;
  readonly orderedQuantity: number;
  readonly purchasedQuantity: number;
}

export interface PurchaseDetail {
  readonly purchase: PurchaseView;
  readonly lines: readonly PurchaseLineView[];
  readonly warnings: readonly PurchaseWarning[];
  readonly canConfirm: boolean;
  /** Why a draft cannot be confirmed, when it cannot (PRODUCT.md D9). */
  readonly confirmBlockedReason: 'ORDER_CANCELLED' | null;
  readonly canEdit: boolean;
  readonly canCancel: boolean;
  readonly canReverse: boolean;
}

function effectiveStatusOf(row: PurchaseListRow): PurchaseEffectiveStatus {
  return row.reversed ? 'REVERSED' : row.status;
}

export function toPurchaseView(row: PurchaseListRow, timeZone: string): PurchaseView {
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    supplierOrderReference: row.supplierOrderReference,
    purchaseUrl: row.purchaseUrl,
    purchaseDate: row.purchaseDate ? instantToZonedDate(row.purchaseDate, timeZone) : null,
    totalAmount: formatDbMoney(row.totalAmount),
    currency: row.currency,
    status: row.status,
    effectiveStatus: effectiveStatusOf(row),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    confirmedDate: row.confirmedAt ? instantToZonedDate(row.confirmedAt, timeZone) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toLineView(line: PurchaseLineRow): PurchaseLineView {
  return {
    id: line.id, orderItemId: line.orderItemId, orderId: line.orderId, etsyOrderId: line.etsyOrderId,
    productName: line.productNameSnapshot, orderedQuantity: line.orderedQuantity, quantity: line.quantity,
    unitCost: formatDbMoney(line.unitCost), totalCost: formatDbMoney(line.totalCost), currency: line.currency,
  };
}

const CONFIRMED_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export async function buildPurchaseDetail(scope: TenantScope, purchaseId: string, timeZone: string): Promise<PurchaseDetail> {
  const row = await findPurchaseWithSupplier(scope, purchaseId);
  if (!row) throw notFound('Purchase');
  const lines = await listPurchaseLines(scope, purchaseId);
  const counts = row.status === 'CANCELLED' || row.reversed ? new Map<string, number>() : await activePurchasedQuantities(scope, lines.map((line) => line.orderItemId));
  const warnings: PurchaseWarning[] = [];
  for (const line of lines) {
    const purchased = counts.get(line.orderItemId);
    if (purchased !== undefined && purchased > line.orderedQuantity && !warnings.some((w) => w.orderItemId === line.orderItemId)) {
      warnings.push({ code: 'QUANTITY_EXCEEDS_ORDERED', orderItemId: line.orderItemId, productName: line.productNameSnapshot, orderedQuantity: line.orderedQuantity, purchasedQuantity: purchased });
    }
  }
  const confirmed = row.confirmedAt !== null && CONFIRMED_STATUSES.has(row.status);
  const blockedByCancelledOrder = row.status === 'DRAFT' && lines.some((line) => line.orderStatus === 'CANCELLED');
  return {
    purchase: toPurchaseView(row, timeZone),
    lines: lines.map(toLineView),
    warnings,
    canConfirm: row.status === 'DRAFT' && !blockedByCancelledOrder,
    confirmBlockedReason: blockedByCancelledOrder ? 'ORDER_CANCELLED' : null,
    canEdit: row.status === 'DRAFT',
    canCancel: row.status === 'DRAFT',
    canReverse: confirmed && !row.reversed,
  };
}

// ----------------------------------------------------------------- line pricing

interface PricedLine {
  readonly orderItemId: string;
  readonly quantity: number;
  readonly unitCost: Money;
  readonly totalCost: Money;
}

function requireMoney(text: string): Money {
  const parsed = parseMoneyInput(text);
  if (parsed === null) throw new Error('Money input escaped validation');
  return parsed;
}

/**
 * Exact line pricing (PRODUCT.md D3 interim): total = unit price x quantity,
 * both exact, so no rounding is ever needed. A total that does not divide
 * evenly is entered as several lines (for example 1 x 3.34 and 2 x 3.33).
 */
export function priceLines(lines: readonly PurchaseLineInput[]): { priced: PricedLine[]; total: Money } {
  const priced = lines.map((line, index) => {
    const unitCost = requireMoney(line.unitCost);
    const totalCost = multiplyByQuantity(unitCost, line.quantity);
    if (!isWithinMoneyLimit(totalCost)) throw unprocessable('AMOUNT_TOO_LARGE', 'A line total is too large.', [`lines.${index}.unitCost`]);
    return { orderItemId: line.orderItemId, quantity: line.quantity, unitCost, totalCost };
  });
  const total = sumMoney(priced.map((line) => line.totalCost));
  if (!isWithinMoneyLimit(total)) throw unprocessable('AMOUNT_TOO_LARGE', 'The purchase total is too large.', ['lines']);
  return { priced, total };
}

/**
 * Every line must reference an order item of this tenant, on an order that is
 * not cancelled (PRODUCT.md D9) and is in the purchase currency.
 *
 * The orders are row-locked first, in ID order, before this transaction's first
 * write (ARCHITECTURE.md A35). A concurrent cancellation therefore either
 * committed already, and is seen here, or waits until this transaction ends.
 */
async function assertLinesAllocatable(scope: TenantScope, currency: string, priced: readonly PricedLine[]): Promise<void> {
  const found = await findOrderItemsWithOrders(scope, [...new Set(priced.map((line) => line.orderItemId))]);
  const itemsById = new Map(found.map((item) => [item.id, item]));
  const lockedOrders = new Map((await lockOrdersForUpdate(scope, [...new Set(found.map((item) => item.orderId))])).map((order) => [order.id, order]));
  priced.forEach((line, index) => {
    const field = [`lines.${index}.orderItemId`];
    // A foreign tenant's order item is simply absent from the tenant-scoped lookups.
    const item = itemsById.get(line.orderItemId);
    const order = item ? lockedOrders.get(item.orderId) : undefined;
    if (!item || !order) throw unprocessable('ORDER_ITEM_NOT_FOUND', 'Order item not found.', field);
    if (order.status === 'CANCELLED') {
      throw unprocessable('ORDER_CANCELLED', 'This order is cancelled, so supplier purchases cannot be added to it.', field);
    }
    if (order.currency !== currency) {
      throw unprocessable('CURRENCY_MISMATCH', 'A purchase and the orders it covers must use the same currency.', field);
    }
  });
}

async function assertSupplierExists(scope: TenantScope, supplierId: string): Promise<void> {
  if (!(await findSupplierById(scope, supplierId))) throw unprocessable('SUPPLIER_NOT_FOUND', 'Supplier not found.', ['supplierId']);
}

function mapPurchaseConflict(error: unknown): never {
  if (getPostgresErrorCode(error) === PG_UNIQUE_VIOLATION && getPostgresConstraintName(error) === REFERENCE_CONSTRAINT) {
    throw conflict('DUPLICATE_SUPPLIER_REFERENCE', 'This supplier order reference is already recorded for this supplier.', ['supplierOrderReference']);
  }
  throw error;
}

// ------------------------------------------------------------------ operations

export async function createPurchase(db: Database, tenant: TenantContext, input: CreatePurchaseInput): Promise<PurchaseDetail> {
  try {
    return await runInTransaction(db, async (tx) => {
      const scope = tenantScope(tx, tenant);
      const business = await loadBusinessContext(tx, tenant);
      const currency = resolveRecordCurrency(input.currency, business);
      await assertSupplierExists(scope, input.supplierId);
      const { priced, total } = priceLines(input.lines);
      await assertLinesAllocatable(scope, currency, priced);

      let notes = input.notes ?? null;
      if (input.replacesPurchaseId !== undefined) {
        const replaced = await findPurchaseWithSupplier(scope, input.replacesPurchaseId);
        if (!replaced || !replaced.reversed) {
          throw unprocessable('REPLACED_PURCHASE_INVALID', 'Only a reversed purchase can be replaced.', ['replacesPurchaseId']);
        }
        notes = `Replaces purchase ${replaced.id}.${notes ? `\n${notes}` : ''}`;
      }

      const purchase = await insertPurchase(scope, {
        supplierId: input.supplierId,
        supplierOrderReference: input.supplierOrderReference ?? null,
        purchaseUrl: input.purchaseUrl ?? null,
        purchaseDate: zonedDateToInstant(input.purchaseDate, business.timeZone),
        totalAmount: toDbMoney(total),
        currency,
        status: 'DRAFT',
        notes,
      });
      await insertPurchaseItems(scope, purchase.id, priced.map((line) => ({
        orderItemId: line.orderItemId, quantity: line.quantity,
        unitCost: toDbMoney(line.unitCost), totalCost: toDbMoney(line.totalCost), currency,
      })));
      await insertAuditLogs(scope, [{
        entityType: 'supplier_purchase', entityId: purchase.id, action: 'CREATE', beforeData: null,
        afterData: { status: 'DRAFT', supplierId: purchase.supplierId, totalAmount: purchase.totalAmount, currency, lineCount: priced.length, replacesPurchaseId: input.replacesPurchaseId ?? null },
      }]);
      return buildPurchaseDetail(scope, purchase.id, business.timeZone);
    });
  } catch (error) {
    return mapPurchaseConflict(error);
  }
}

export async function listPurchases(db: Database, tenant: TenantContext, request: PageRequest): Promise<Page<PurchaseView>> {
  const scope = tenantScope(db, tenant);
  const business = await loadBusinessContext(db, tenant);
  const [rows, total] = await Promise.all([listPurchaseRows(scope, request), countPurchases(scope)]);
  return toPage(rows.map((row) => toPurchaseView(row, business.timeZone)), request, total);
}

export async function getPurchaseDetail(db: Database, tenant: TenantContext, purchaseId: string): Promise<PurchaseDetail> {
  const scope = tenantScope(db, tenant);
  const business = await loadBusinessContext(db, tenant);
  return buildPurchaseDetail(scope, purchaseId, business.timeZone);
}

/** Only DRAFT purchases can change; nothing is posted by creating or editing. */
export async function updateDraftPurchase(db: Database, tenant: TenantContext, purchaseId: string, patch: UpdatePurchaseInput): Promise<PurchaseDetail> {
  try {
    return await runInTransaction(db, async (tx) => {
      const scope = tenantScope(tx, tenant);
      const business = await loadBusinessContext(tx, tenant);
      const purchase = await findPurchaseForUpdate(scope, purchaseId);
      if (!purchase) throw notFound('Purchase');
      if (purchase.status !== 'DRAFT') throw invalidState('PURCHASE_NOT_EDITABLE', 'Only a draft purchase can be edited. Corrections to a confirmed purchase use a reversal.');

      const changed: string[] = [];
      const values: PurchaseUpdate = {};
      if (patch.supplierId !== undefined) { await assertSupplierExists(scope, patch.supplierId); values.supplierId = patch.supplierId; changed.push('supplierId'); }
      if (patch.supplierOrderReference !== undefined) { values.supplierOrderReference = patch.supplierOrderReference; changed.push('supplierOrderReference'); }
      if (patch.purchaseUrl !== undefined) { values.purchaseUrl = patch.purchaseUrl; changed.push('purchaseUrl'); }
      if (patch.purchaseDate !== undefined) { values.purchaseDate = zonedDateToInstant(patch.purchaseDate, business.timeZone); changed.push('purchaseDate'); }
      if (patch.notes !== undefined) { values.notes = patch.notes; changed.push('notes'); }
      if (patch.lines !== undefined) {
        const { priced, total } = priceLines(patch.lines);
        await assertLinesAllocatable(scope, purchase.currency, priced);
        await deletePurchaseItems(scope, purchase.id);
        await insertPurchaseItems(scope, purchase.id, priced.map((line) => ({
          orderItemId: line.orderItemId, quantity: line.quantity,
          unitCost: toDbMoney(line.unitCost), totalCost: toDbMoney(line.totalCost), currency: purchase.currency,
        })));
        values.totalAmount = toDbMoney(total);
        changed.push('lines');
      }
      await updatePurchase(scope, purchase.id, values);
      await insertAuditLogs(scope, [{ entityType: 'supplier_purchase', entityId: purchase.id, action: 'UPDATE', beforeData: null, afterData: { changed } }]);
      return buildPurchaseDetail(scope, purchase.id, business.timeZone);
    });
  } catch (error) {
    return mapPurchaseConflict(error);
  }
}

/** Cancels a draft. Confirmed purchases cannot be cancelled; they are reversed. A repeat is a no-op. */
export function cancelDraftPurchase(db: Database, tenant: TenantContext, purchaseId: string): Promise<PurchaseDetail> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const business = await loadBusinessContext(tx, tenant);
    const purchase = await findPurchaseForUpdate(scope, purchaseId);
    if (!purchase) throw notFound('Purchase');
    if (purchase.status === 'CANCELLED') return buildPurchaseDetail(scope, purchase.id, business.timeZone);
    if (purchase.status !== 'DRAFT') throw invalidState('PURCHASE_NOT_CANCELLABLE', 'Only a draft purchase can be cancelled. Reverse a confirmed purchase instead.');
    await updatePurchase(scope, purchase.id, { status: 'CANCELLED' });
    await insertAuditLogs(scope, [{ entityType: 'supplier_purchase', entityId: purchase.id, action: 'CANCEL', beforeData: { status: 'DRAFT' }, afterData: { status: 'CANCELLED' } }]);
    return buildPurchaseDetail(scope, purchase.id, business.timeZone);
  });
}

export interface ConfirmPurchaseResult {
  readonly detail: PurchaseDetail;
  readonly journalEntryId: string | null;
  /** True when the purchase had already been confirmed; nothing was posted by this call. */
  readonly alreadyConfirmed: boolean;
}

/**
 * Confirms a draft purchase: the status change, the finalized journal
 * (debit SUPPLIER_COST, credit Supplier Payable) and the audit trail commit
 * together or not at all. Idempotent: the purchase row is locked first, so
 * concurrent or repeated confirmations return the one existing posting.
 * Resolves only after COMMIT, when the database re-validates balance, posting
 * rules and the confirmation/journal pairing.
 */
export function confirmPurchase(db: Database, tenant: TenantContext, purchaseId: string): Promise<ConfirmPurchaseResult> {
  return runInTransaction(db, (tx) => confirmPurchaseInTransaction(tx, tenant, purchaseId));
}

export async function confirmPurchaseInTransaction(tx: DbExecutor, tenant: TenantContext, purchaseId: string): Promise<ConfirmPurchaseResult> {
  const scope = tenantScope(tx, tenant);
  const business = await loadBusinessContext(tx, tenant);
  const purchase = await findPurchaseForUpdate(scope, purchaseId);
  if (!purchase) throw notFound('Purchase');

  if (purchase.confirmedAt !== null) {
    const entry = await findSupplierPurchasePosting(scope, purchase.id);
    return { detail: await buildPurchaseDetail(scope, purchase.id, business.timeZone), journalEntryId: entry?.id ?? null, alreadyConfirmed: true };
  }
  if (purchase.status !== 'DRAFT') throw invalidState('PURCHASE_NOT_CONFIRMABLE', 'Only a draft purchase can be confirmed.');
  if (purchase.purchaseDate === null) throw unprocessable('PURCHASE_DATE_REQUIRED', 'A purchase date is required to confirm.', ['purchaseDate']);
  if (purchase.currency !== business.baseCurrency) {
    throw unprocessable('CURRENCY_NOT_SUPPORTED', `Purchases must use the business currency (${business.baseCurrency}); currency conversion is not available yet.`, ['currency']);
  }

  const lines = await listPurchaseLines(scope, purchase.id);
  if (lines.length === 0) throw unprocessable('PURCHASE_HAS_NO_LINES', 'A purchase needs at least one line.', ['lines']);
  if (lines.some((line) => line.orderCurrency !== purchase.currency || line.currency !== purchase.currency)) {
    throw unprocessable('CURRENCY_MISMATCH', 'A purchase and the orders it covers must use the same currency.', ['lines']);
  }
  const total = sumMoney(lines.map((line) => parseDbMoney(line.totalCost)));
  if (total !== parseDbMoney(purchase.totalAmount)) {
    throw invalidState('PURCHASE_TOTAL_MISMATCH', 'The purchase total does not match the sum of its lines.');
  }
  if (total <= BigInt(0)) {
    throw unprocessable('PURCHASE_TOTAL_REQUIRED', `A purchase needs a cost above ${formatMoney(BigInt(0))} to be confirmed. Cancel the draft instead.`, ['lines']);
  }

  // Lock the orders (ID order) BEFORE the first write, then check them under the lock (A35, PRODUCT.md D9).
  // A concurrent cancellation either committed first (refused here) or waits until this confirmation commits,
  // in which case the confirmed cost stays and the cancelled order simply counts no revenue.
  const lockedOrders = new Map((await lockOrdersForUpdate(scope, [...new Set(lines.map((line) => line.orderId))])).map((order) => [order.id, order]));
  if (lines.some((line) => lockedOrders.get(line.orderId)?.status === 'CANCELLED')) {
    throw invalidState('ORDER_CANCELLED', 'This purchase covers a cancelled order, so it cannot be confirmed. Edit the draft to remove those lines, or cancel the draft.');
  }

  const costAccount = await resolveSupplierCostAccount(scope, purchase.currency);
  const payableAccount = await ensureSupplierPayableAccount(scope, purchase.currency);

  const confirmed = await updatePurchase(scope, purchase.id, { status: 'CONFIRMED', confirmedAt: new Date() });
  if (!confirmed) throw notFound('Purchase');
  const entry = await postSupplierPurchase(scope, {
    purchaseId: purchase.id,
    currency: purchase.currency,
    amount: total,
    transactionDate: purchase.purchaseDate,
    costAccountId: costAccount.id,
    payableAccountId: payableAccount.id,
  });

  const audit: AuditEntry[] = [{
    entityType: 'supplier_purchase', entityId: purchase.id, action: 'CONFIRM', beforeData: { status: 'DRAFT' },
    afterData: { status: 'CONFIRMED', journalEntryId: entry.id, totalAmount: confirmed.totalAmount, currency: confirmed.currency },
  }];
  // Confirming the first purchase moves a NEW order to SUPPLIER_ORDERED (the orders are already locked, in ID order).
  for (const orderId of [...lockedOrders.keys()].sort()) {
    const order = lockedOrders.get(orderId);
    if (order && order.status === 'NEW') {
      await updateOrder(scope, order.id, { status: 'SUPPLIER_ORDERED' });
      audit.push(statusAudit(order.id, 'NEW', 'SUPPLIER_ORDERED', 'supplier_purchase_confirmed'));
    }
  }
  await insertAuditLogs(scope, audit);
  return { detail: await buildPurchaseDetail(scope, purchase.id, business.timeZone), journalEntryId: entry.id, alreadyConfirmed: false };
}

export interface ReversePurchaseResult {
  readonly detail: PurchaseDetail;
  /** True when the purchase had already been reversed; nothing was posted by this call. */
  readonly alreadyReversed: boolean;
}

/**
 * Corrects a confirmed purchase by reversing its posting with the exact
 * opposite entry. The original journal, the purchase row and its lines are never
 * edited. The purchase then shows as REVERSED and leaves actual profit. A
 * corrected purchase is entered as a new one (see `replacesPurchaseId`).
 */
export function reversePurchase(db: Database, tenant: TenantContext, purchaseId: string, input: ReversePurchaseInput): Promise<ReversePurchaseResult> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const business = await loadBusinessContext(tx, tenant);
    const purchase = await findPurchaseForUpdate(scope, purchaseId);
    if (!purchase) throw notFound('Purchase');
    if (purchase.confirmedAt === null) throw invalidState('PURCHASE_NOT_CONFIRMED', 'Only a confirmed purchase can be reversed.');
    const original = await findSupplierPurchasePosting(scope, purchase.id);
    if (!original) throw invalidState('PURCHASE_HAS_NO_POSTING', 'This purchase has no posting to reverse.');

    const { reversalId, alreadyReversed } = await reverseSupplierPurchasePosting(scope, purchase.id, original, new Date());
    if (!alreadyReversed) {
      await insertAuditLogs(scope, [{
        entityType: 'supplier_purchase', entityId: purchase.id, action: 'REVERSE', beforeData: { journalEntryId: original.id },
        afterData: { reversalEntryId: reversalId, reason: input.reason },
      }]);
    }
    return { detail: await buildPurchaseDetail(scope, purchase.id, business.timeZone), alreadyReversed };
  });
}

