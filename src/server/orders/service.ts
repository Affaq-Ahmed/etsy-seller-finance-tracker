import 'server-only';
import { z } from 'zod';
import { compareCalendarDates, instantToZonedDate, zonedDateToInstant } from '@/lib/dates';
import { formatDbMoney, parseMoneyInput, toDbMoney } from '@/lib/money';
import type { Database } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { loadBusinessContext, resolveRecordCurrency } from '@/server/business/context';
import { insertAuditLogs, type AuditEntry } from '@/server/dal/audit-logs';
import {
  countOrders, findOrderById, findOrderForUpdate, insertOrder, listOrders as listOrderRows, updateOrder, type OrderRow,
} from '@/server/dal/orders';
import {
  deleteOrderItems, findReferencedItemIds, insertOrderItems, listOrderItems, listOrderItemsForOrders, type OrderItemRow,
} from '@/server/dal/order-items';
import { costSummaryByOrder } from '@/server/dal/order-profit';
import { findProductsByIds } from '@/server/dal/products';
import { listPurchasesForOrder } from '@/server/dal/supplier-purchase-items';
import { tenantScope, type PageRequest, type TenantScope } from '@/server/dal/tenant-scope';
import { conflict, invalidState, notFound, unprocessable } from '@/server/domain/errors';
import { getPostgresConstraintName, getPostgresErrorCode, PG_UNIQUE_VIOLATION } from '@/server/db/errors';
import { runInTransaction } from '@/server/db/transaction';
import { toPage, type Page } from '@/server/http/pagination';
import {
  calendarDateField, currencyField, etsyOrderIdField, MAX_ITEMS_PER_ORDER, moneyField, nameField, notesField, quantityField, skuField, uuidField,
} from '@/server/validation/fields';
import { buildOrderProfit, type OrderProfitView } from './profit';
import {
  allowedNextStatuses, canTransition, isOrderEditable, SETTABLE_ORDER_STATUSES, type OrderStatus,
} from './status';

const ETSY_ORDER_ID_CONSTRAINT = 'orders_tenant_etsy_id_uq';

// ---------------------------------------------------------------- input schemas

/** Either an existing product (name and SKU are snapshotted from it) or a free-text item. */
const orderItemInputSchema = z.strictObject({
  productId: uuidField.optional(),
  productName: nameField.optional(),
  sku: skuField.optional(),
  quantity: quantityField,
}).refine((item) => (item.productId === undefined
  ? item.productName !== undefined
  : item.productName === undefined && item.sku === undefined));
export type OrderItemInput = z.output<typeof orderItemInputSchema>;

const orderItemsSchema = z.array(orderItemInputSchema).min(1).max(MAX_ITEMS_PER_ORDER);

export const createOrderSchema = z.strictObject({
  etsyOrderId: etsyOrderIdField,
  orderDate: calendarDateField,
  /** The net amount Etsy pays the seller. Fees are NOT deducted again (PRODUCT.md §5 rule 7). */
  netPayableAmount: moneyField,
  currency: currencyField.optional(),
  notes: notesField.optional(),
  items: orderItemsSchema,
});
export type CreateOrderInput = z.output<typeof createOrderSchema>;

export const updateOrderSchema = z.strictObject({
  etsyOrderId: etsyOrderIdField.optional(),
  orderDate: calendarDateField.optional(),
  netPayableAmount: moneyField.optional(),
  notes: notesField.optional(),
  items: orderItemsSchema.optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined));
export type UpdateOrderInput = z.output<typeof updateOrderSchema>;

export const orderStatusChangeSchema = z.strictObject({
  status: z.enum(SETTABLE_ORDER_STATUSES),
  deliveredDate: calendarDateField.optional(),
});
export type OrderStatusChangeInput = z.output<typeof orderStatusChangeSchema>;

// ---------------------------------------------------------------------- views

export interface OrderView {
  readonly id: string;
  readonly etsyOrderId: string;
  /** Calendar date in the business timezone. */
  readonly orderDate: string;
  readonly netPayableAmount: string;
  readonly currency: string;
  readonly status: OrderStatus;
  readonly deliveredDate: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderItemView {
  readonly id: string;
  readonly productId: string | null;
  readonly productName: string;
  readonly sku: string | null;
  readonly quantity: number;
  /** True once any supplier purchase line references the item; locked items cannot be edited. */
  readonly locked: boolean;
}

export interface OrderPurchaseView {
  readonly purchaseId: string;
  readonly supplierName: string;
  readonly supplierOrderReference: string | null;
  readonly purchaseDate: string | null;
  /** The share of this purchase allocated to the order. */
  readonly orderTotal: string;
  readonly effectiveStatus: string;
}

export interface OrderListItem extends OrderView {
  readonly itemCount: number;
  readonly profit: OrderProfitView;
}

export interface OrderDetail {
  readonly order: OrderView;
  readonly items: readonly OrderItemView[];
  readonly profit: OrderProfitView;
  readonly purchases: readonly OrderPurchaseView[];
  readonly allowedNextStatuses: readonly string[];
  readonly editable: boolean;
}

export function toOrderView(row: OrderRow, timeZone: string): OrderView {
  return {
    id: row.id,
    etsyOrderId: row.etsyOrderId,
    orderDate: instantToZonedDate(row.orderDate, timeZone),
    netPayableAmount: formatDbMoney(row.netPayableAmount),
    currency: row.currency,
    status: row.status,
    deliveredDate: row.deliveredAt ? instantToZonedDate(row.deliveredAt, timeZone) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function effectivePurchaseStatus(status: string, reversed: boolean): string {
  return reversed ? 'REVERSED' : status;
}

/** Shared by reads and by mutations that return the updated order from inside their transaction. */
export async function buildOrderDetail(scope: TenantScope, order: OrderRow, timeZone: string): Promise<OrderDetail> {
  const [items, referenced, costs, purchases] = await Promise.all([
    listOrderItems(scope, order.id),
    findReferencedItemIds(scope, order.id),
    costSummaryByOrder(scope, [order.id]),
    listPurchasesForOrder(scope, order.id),
  ]);
  const lockedIds = new Set(referenced);
  return {
    order: toOrderView(order, timeZone),
    items: items.map((item) => toOrderItemView(item, lockedIds.has(item.id))),
    profit: buildOrderProfit(order.netPayableAmount, costs.get(order.id), order.status),
    purchases: purchases.map((purchase) => ({
      purchaseId: purchase.purchaseId,
      supplierName: purchase.supplierName,
      supplierOrderReference: purchase.supplierOrderReference,
      purchaseDate: purchase.purchaseDate ? instantToZonedDate(purchase.purchaseDate, timeZone) : null,
      orderTotal: formatDbMoney(purchase.orderTotal),
      effectiveStatus: effectivePurchaseStatus(purchase.status, purchase.reversed),
    })),
    allowedNextStatuses: allowedNextStatuses(order.status),
    editable: isOrderEditable(order.status),
  };
}

function toOrderItemView(item: OrderItemRow, locked: boolean): OrderItemView {
  return { id: item.id, productId: item.productId, productName: item.productNameSnapshot, sku: item.skuSnapshot, quantity: item.quantity, locked };
}

// ------------------------------------------------------------------ operations

interface ItemSnapshot {
  readonly productId: string | null;
  readonly productNameSnapshot: string;
  readonly skuSnapshot: string | null;
  readonly quantity: number;
}

/** Products are snapshotted onto items so later product edits never rewrite order history. */
async function snapshotItems(scope: TenantScope, items: readonly OrderItemInput[]): Promise<ItemSnapshot[]> {
  const productIds = [...new Set(items.flatMap((item) => (item.productId === undefined ? [] : [item.productId])))];
  const products = new Map((await findProductsByIds(scope, productIds)).map((product) => [product.id, product]));
  return items.map((item, index) => {
    if (item.productId === undefined) {
      if (item.productName === undefined) throw new Error('Item without a product needs a name');
      return { productId: null, productNameSnapshot: item.productName, skuSnapshot: item.sku ?? null, quantity: item.quantity };
    }
    // A foreign tenant's product is simply absent from the tenant-scoped lookup.
    const product = products.get(item.productId);
    if (!product) throw unprocessable('PRODUCT_NOT_FOUND', 'Product not found.', [`items.${index}.productId`]);
    return { productId: product.id, productNameSnapshot: product.name, skuSnapshot: product.sku, quantity: item.quantity };
  });
}

function requireMoney(text: string): bigint {
  const parsed = parseMoneyInput(text);
  if (parsed === null) throw new Error('Money input escaped validation');
  return parsed;
}

function mapOrderConflict(error: unknown): never {
  if (getPostgresErrorCode(error) === PG_UNIQUE_VIOLATION && getPostgresConstraintName(error) === ETSY_ORDER_ID_CONSTRAINT) {
    throw conflict('DUPLICATE_ETSY_ORDER_ID', 'An order with this Etsy Order ID already exists.', ['etsyOrderId']);
  }
  throw error;
}

export async function createOrder(db: Database, tenant: TenantContext, input: CreateOrderInput): Promise<OrderDetail> {
  try {
    return await runInTransaction(db, async (tx) => {
      const scope = tenantScope(tx, tenant);
      const business = await loadBusinessContext(tx, tenant);
      const currency = resolveRecordCurrency(input.currency, business);
      const items = await snapshotItems(scope, input.items);
      const order = await insertOrder(scope, {
        etsyOrderId: input.etsyOrderId,
        orderDate: zonedDateToInstant(input.orderDate, business.timeZone),
        netPayableAmount: toDbMoney(requireMoney(input.netPayableAmount)),
        currency,
        status: 'NEW',
        notes: input.notes ?? null,
      });
      await insertOrderItems(scope, order.id, items);
      await insertAuditLogs(scope, [{
        entityType: 'order', entityId: order.id, action: 'CREATE', beforeData: null,
        afterData: { etsyOrderId: order.etsyOrderId, netPayableAmount: order.netPayableAmount, currency: order.currency, itemCount: items.length },
      }]);
      return buildOrderDetail(scope, order, business.timeZone);
    });
  } catch (error) {
    return mapOrderConflict(error);
  }
}

export async function listOrders(db: Database, tenant: TenantContext, request: PageRequest): Promise<Page<OrderListItem>> {
  const scope = tenantScope(db, tenant);
  const business = await loadBusinessContext(db, tenant);
  const [rows, total] = await Promise.all([listOrderRows(scope, request), countOrders(scope)]);
  const ids = rows.map((row) => row.id);
  const [items, costs] = await Promise.all([listOrderItemsForOrders(scope, ids), costSummaryByOrder(scope, ids)]);
  const itemCounts = new Map<string, number>();
  for (const item of items) itemCounts.set(item.orderId, (itemCounts.get(item.orderId) ?? 0) + 1);
  return toPage(rows.map((row) => ({
    ...toOrderView(row, business.timeZone),
    itemCount: itemCounts.get(row.id) ?? 0,
    profit: buildOrderProfit(row.netPayableAmount, costs.get(row.id), row.status),
  })), request, total);
}

export async function getOrderDetail(db: Database, tenant: TenantContext, orderId: string): Promise<OrderDetail> {
  const scope = tenantScope(db, tenant);
  const business = await loadBusinessContext(db, tenant);
  const order = await findOrderById(scope, orderId);
  if (!order) throw notFound('Order');
  return buildOrderDetail(scope, order, business.timeZone);
}

export async function updateOrderDetails(db: Database, tenant: TenantContext, orderId: string, patch: UpdateOrderInput): Promise<OrderDetail> {
  try {
    return await runInTransaction(db, async (tx) => {
      const scope = tenantScope(tx, tenant);
      const business = await loadBusinessContext(tx, tenant);
      const order = await findOrderForUpdate(scope, orderId);
      if (!order) throw notFound('Order');
      if (!isOrderEditable(order.status)) throw invalidState('ORDER_NOT_EDITABLE', 'A cancelled order cannot be edited.');

      const changed: string[] = [];
      const values: Parameters<typeof updateOrder>[2] = {};
      if (patch.etsyOrderId !== undefined) { values.etsyOrderId = patch.etsyOrderId; changed.push('etsyOrderId'); }
      if (patch.orderDate !== undefined) {
        const instant = zonedDateToInstant(patch.orderDate, business.timeZone);
        if (order.deliveredAt && instant.getTime() > order.deliveredAt.getTime()) {
          throw unprocessable('ORDER_DATE_AFTER_DELIVERY', 'The order date cannot be after the delivery date.', ['orderDate']);
        }
        values.orderDate = instant;
        changed.push('orderDate');
      }
      if (patch.netPayableAmount !== undefined) { values.netPayableAmount = toDbMoney(requireMoney(patch.netPayableAmount)); changed.push('netPayableAmount'); }
      if (patch.notes !== undefined) { values.notes = patch.notes; changed.push('notes'); }
      if (patch.items !== undefined) {
        if ((await findReferencedItemIds(scope, order.id)).length > 0) {
          throw invalidState('ORDER_ITEMS_LOCKED', 'Items cannot change once a supplier purchase references them.');
        }
        const snapshots = await snapshotItems(scope, patch.items);
        await deleteOrderItems(scope, order.id);
        await insertOrderItems(scope, order.id, snapshots);
        changed.push('items');
      }

      const updated = await updateOrder(scope, order.id, values);
      if (!updated) throw notFound('Order');
      await insertAuditLogs(scope, [{ entityType: 'order', entityId: order.id, action: 'UPDATE', beforeData: null, afterData: { changed } }]);
      return buildOrderDetail(scope, updated, business.timeZone);
    });
  } catch (error) {
    return mapOrderConflict(error);
  }
}

export function changeOrderStatus(db: Database, tenant: TenantContext, orderId: string, input: OrderStatusChangeInput): Promise<OrderDetail> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const business = await loadBusinessContext(tx, tenant);
    const order = await findOrderForUpdate(scope, orderId);
    if (!order) throw notFound('Order');
    // A repeated request (double click, retry) is a no-op rather than an error.
    if (order.status === input.status) return buildOrderDetail(scope, order, business.timeZone);
    if (!canTransition(order.status, input.status)) {
      throw invalidState('INVALID_STATUS_TRANSITION', `An order that is ${order.status} cannot become ${input.status}.`);
    }

    let deliveredAt: Date | null = null;
    if (input.status === 'DELIVERED') {
      if (input.deliveredDate === undefined) throw unprocessable('DELIVERED_DATE_REQUIRED', 'A delivery date is required.', ['deliveredDate']);
      if (compareCalendarDates(input.deliveredDate, instantToZonedDate(order.orderDate, business.timeZone)) < 0) {
        throw unprocessable('DELIVERED_BEFORE_ORDER', 'The delivery date cannot be before the order date.', ['deliveredDate']);
      }
      deliveredAt = zonedDateToInstant(input.deliveredDate, business.timeZone);
    } else if (input.deliveredDate !== undefined) {
      throw unprocessable('DELIVERED_DATE_NOT_ALLOWED', 'A delivery date applies only to DELIVERED.', ['deliveredDate']);
    }

    const updated = await updateOrder(scope, order.id, { status: input.status, ...(deliveredAt ? { deliveredAt } : {}) });
    if (!updated) throw notFound('Order');
    await insertAuditLogs(scope, [statusAudit(order.id, order.status, input.status, 'user')]);
    return buildOrderDetail(scope, updated, business.timeZone);
  });
}

export function statusAudit(orderId: string, from: OrderStatus, to: OrderStatus, cause: 'user' | 'supplier_purchase_confirmed'): AuditEntry {
  return { entityType: 'order', entityId: orderId, action: 'STATUS_CHANGE', beforeData: { status: from }, afterData: { status: to, cause } };
}
