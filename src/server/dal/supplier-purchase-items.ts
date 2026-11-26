import 'server-only';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { orderItems, orders, supplierPurchaseItems, supplierPurchases } from '@/db/schema';
import { purchaseIsReversedSql } from './journal';
import type { TenantInsert, TenantRow, TenantScope } from './tenant-scope';

export type PurchaseItemRow = TenantRow<typeof supplierPurchaseItems>;
export type PurchaseItemInsert = TenantInsert<typeof supplierPurchaseItems>;

export function insertPurchaseItems(scope: TenantScope, purchaseId: string, rows: readonly Omit<PurchaseItemInsert, 'supplierPurchaseId' | 'createdAt'>[]): Promise<PurchaseItemRow[]> {
  // One millisecond apart so the entered line order survives (see order-items.ts).
  const base = Date.now();
  return scope.insert(supplierPurchaseItems, rows.map((row, index) => ({ ...row, supplierPurchaseId: purchaseId, createdAt: new Date(base + index) })));
}

/** Only valid for DRAFT purchases: the database refuses to touch confirmed purchase items. */
export function deletePurchaseItems(scope: TenantScope, purchaseId: string): Promise<PurchaseItemRow[]> {
  return scope.delete(supplierPurchaseItems, eq(supplierPurchaseItems.supplierPurchaseId, purchaseId));
}

/** A purchase line with the order item and order it is allocated to. */
export interface PurchaseLineRow {
  readonly id: string;
  readonly orderItemId: string;
  readonly orderId: string;
  readonly etsyOrderId: string;
  readonly orderCurrency: string;
  readonly orderStatus: TenantRow<typeof orders>['status'];
  readonly productNameSnapshot: string;
  readonly orderedQuantity: number;
  readonly quantity: number;
  readonly unitCost: string;
  readonly totalCost: string;
  readonly currency: string;
}

export function listPurchaseLines(scope: TenantScope, purchaseId: string): Promise<PurchaseLineRow[]> {
  return scope.executor
    .select({
      id: supplierPurchaseItems.id,
      orderItemId: supplierPurchaseItems.orderItemId,
      orderId: orders.id,
      etsyOrderId: orders.etsyOrderId,
      orderCurrency: orders.currency,
      orderStatus: orders.status,
      productNameSnapshot: orderItems.productNameSnapshot,
      orderedQuantity: orderItems.quantity,
      quantity: supplierPurchaseItems.quantity,
      unitCost: supplierPurchaseItems.unitCost,
      totalCost: supplierPurchaseItems.totalCost,
      currency: supplierPurchaseItems.currency,
    })
    .from(supplierPurchaseItems)
    .innerJoin(orderItems, and(eq(orderItems.accountId, supplierPurchaseItems.accountId), eq(orderItems.id, supplierPurchaseItems.orderItemId)))
    .innerJoin(orders, and(eq(orders.accountId, orderItems.accountId), eq(orders.id, orderItems.orderId)))
    .where(and(
      scope.tenantEq(supplierPurchaseItems), scope.tenantEq(orderItems), scope.tenantEq(orders),
      eq(supplierPurchaseItems.supplierPurchaseId, purchaseId),
    ))
    .orderBy(asc(supplierPurchaseItems.createdAt), asc(supplierPurchaseItems.id));
}

/** The purchases that have lines on an order, with that order's share of each. */
export interface OrderPurchaseRow {
  readonly purchaseId: string;
  readonly supplierName: string;
  readonly status: TenantRow<typeof supplierPurchases>['status'];
  readonly purchaseDate: Date | null;
  readonly supplierOrderReference: string | null;
  readonly reversed: boolean;
  readonly orderTotal: string;
}

export async function listPurchasesForOrder(scope: TenantScope, orderId: string): Promise<OrderPurchaseRow[]> {
  const rows = await scope.executor.execute<{
    purchase_id: string; supplier_name: string; status: OrderPurchaseRow['status']; purchase_date: string | null;
    supplier_order_reference: string | null; reversed: boolean; order_total: string;
  }>(sql`
    SELECT sp.id AS purchase_id, s.name AS supplier_name, sp.status AS status, to_json(sp.purchase_date) #>> '{}' AS purchase_date,
      sp.supplier_order_reference AS supplier_order_reference,
      ${purchaseIsReversedSql(sql.raw('sp.account_id'), sql.raw('sp.id'))} AS reversed,
      sum(spi.total_cost)::text AS order_total
    FROM supplier_purchase_items spi
    JOIN order_items oi ON oi.account_id = spi.account_id AND oi.id = spi.order_item_id
    JOIN supplier_purchases sp ON sp.account_id = spi.account_id AND sp.id = spi.supplier_purchase_id
    JOIN suppliers s ON s.account_id = sp.account_id AND s.id = sp.supplier_id
    WHERE spi.account_id = ${scope.tenant.accountId}::uuid AND oi.account_id = ${scope.tenant.accountId}::uuid
      AND sp.account_id = ${scope.tenant.accountId}::uuid AND s.account_id = ${scope.tenant.accountId}::uuid
      AND oi.order_id = ${orderId}::uuid
    GROUP BY sp.id, s.name, sp.status, sp.purchase_date, sp.supplier_order_reference, sp.account_id
    ORDER BY sp.created_at DESC, sp.id DESC`);
  return [...rows].map((row) => ({
    purchaseId: row.purchase_id, supplierName: row.supplier_name, status: row.status,
    // Raw SQL bypasses column mapping: the instant arrives as ISO-8601 text.
    purchaseDate: row.purchase_date === null ? null : new Date(row.purchase_date), supplierOrderReference: row.supplier_order_reference,
    reversed: row.reversed, orderTotal: row.order_total,
  }));
}

/**
 * Units already bought per order item across purchases that still count
 * (draft, confirmed and refunded; not cancelled or reversed). Used for the
 * "more than ordered" warning only.
 */
export async function activePurchasedQuantities(scope: TenantScope, orderItemIds: readonly string[]): Promise<Map<string, number>> {
  if (orderItemIds.length === 0) return new Map();
  const rows = await scope.executor
    .select({ orderItemId: supplierPurchaseItems.orderItemId, quantity: sql<string>`sum(${supplierPurchaseItems.quantity})::text` })
    .from(supplierPurchaseItems)
    .innerJoin(supplierPurchases, and(eq(supplierPurchases.accountId, supplierPurchaseItems.accountId), eq(supplierPurchases.id, supplierPurchaseItems.supplierPurchaseId)))
    .where(and(
      scope.tenantEq(supplierPurchaseItems), scope.tenantEq(supplierPurchases),
      inArray(supplierPurchaseItems.orderItemId, [...orderItemIds]),
      ne(supplierPurchases.status, 'CANCELLED'),
      sql`NOT ${purchaseIsReversedSql(supplierPurchases.accountId, supplierPurchases.id)}`,
    ))
    .groupBy(supplierPurchaseItems.orderItemId);
  return new Map(rows.map((row) => [row.orderItemId, Number(row.quantity)]));
}
