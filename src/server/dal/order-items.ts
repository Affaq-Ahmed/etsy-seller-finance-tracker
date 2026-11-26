import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { orderItems, orders, supplierPurchaseItems } from '@/db/schema';
import type { TenantInsert, TenantRow, TenantScope } from './tenant-scope';

export type OrderItemRow = TenantRow<typeof orderItems>;
export type OrderItemInsert = TenantInsert<typeof orderItems>;

/**
 * order_items has no position column, so the creation order is preserved by
 * giving each item a createdAt one millisecond after the previous one (all
 * rows of one statement would otherwise share the transaction timestamp).
 */
export function insertOrderItems(scope: TenantScope, orderId: string, rows: readonly Omit<OrderItemInsert, 'orderId' | 'createdAt'>[]): Promise<OrderItemRow[]> {
  const base = Date.now();
  return scope.insert(orderItems, rows.map((row, index) => ({ ...row, orderId, createdAt: new Date(base + index) })));
}

export function listOrderItems(scope: TenantScope, orderId: string): Promise<OrderItemRow[]> {
  return scope.executor.select().from(orderItems)
    .where(and(scope.tenantEq(orderItems), eq(orderItems.orderId, orderId)))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
}

export function listOrderItemsForOrders(scope: TenantScope, orderIds: readonly string[]): Promise<OrderItemRow[]> {
  if (orderIds.length === 0) return Promise.resolve([]);
  return scope.executor.select().from(orderItems)
    .where(and(scope.tenantEq(orderItems), inArray(orderItems.orderId, [...orderIds])))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
}

export function deleteOrderItems(scope: TenantScope, orderId: string): Promise<OrderItemRow[]> {
  return scope.delete(orderItems, eq(orderItems.orderId, orderId));
}

export interface OrderItemWithOrder {
  readonly id: string;
  readonly orderId: string;
  readonly quantity: number;
  readonly productNameSnapshot: string;
  readonly etsyOrderId: string;
  readonly orderCurrency: string;
  readonly orderStatus: TenantRow<typeof orders>['status'];
}

/** Items (with their order's currency and status) among `ids` that belong to the session tenant. */
export function findOrderItemsWithOrders(scope: TenantScope, ids: readonly string[]): Promise<OrderItemWithOrder[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return scope.executor
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      quantity: orderItems.quantity,
      productNameSnapshot: orderItems.productNameSnapshot,
      etsyOrderId: orders.etsyOrderId,
      orderCurrency: orders.currency,
      orderStatus: orders.status,
    })
    .from(orderItems)
    .innerJoin(orders, and(eq(orders.accountId, orderItems.accountId), eq(orders.id, orderItems.orderId)))
    .where(and(scope.tenantEq(orderItems), scope.tenantEq(orders), inArray(orderItems.id, [...ids])));
}

/** IDs of the order's items that any supplier purchase line (of any status) references. */
export async function findReferencedItemIds(scope: TenantScope, orderId: string): Promise<string[]> {
  const rows = await scope.executor
    .selectDistinct({ orderItemId: supplierPurchaseItems.orderItemId })
    .from(supplierPurchaseItems)
    .innerJoin(orderItems, and(eq(orderItems.accountId, supplierPurchaseItems.accountId), eq(orderItems.id, supplierPurchaseItems.orderItemId)))
    .where(and(scope.tenantEq(supplierPurchaseItems), scope.tenantEq(orderItems), eq(orderItems.orderId, orderId)));
  return rows.map((row) => row.orderItemId);
}
