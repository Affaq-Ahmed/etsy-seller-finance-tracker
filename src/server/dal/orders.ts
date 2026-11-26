import 'server-only';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { orders } from '@/db/schema';
import {
  countTenantRows, expectRow, type PageRequest, type TenantInsert, type TenantRow, type TenantScope, type TenantUpdate,
} from './tenant-scope';

export type OrderRow = TenantRow<typeof orders>;
export type OrderInsert = TenantInsert<typeof orders>;
export type OrderUpdate = TenantUpdate<typeof orders>;

export async function insertOrder(scope: TenantScope, values: OrderInsert): Promise<OrderRow> {
  return expectRow(await scope.insert(orders, [values]));
}

/** Another tenant's ID yields null, exactly like an ID that does not exist. */
export async function findOrderById(scope: TenantScope, id: string): Promise<OrderRow | null> {
  const [row] = await scope.select(orders, eq(orders.id, id));
  return row ?? null;
}

/** Row-locks the order for the rest of the transaction. */
export async function findOrderForUpdate(scope: TenantScope, id: string): Promise<OrderRow | null> {
  const [row] = await scope.executor.select().from(orders)
    .where(and(scope.tenantEq(orders), eq(orders.id, id))).for('update');
  return row ?? null;
}

/**
 * Row-locks several orders for the rest of the transaction. Rows are locked in
 * ID order, so concurrent callers always acquire them in the same order.
 * Foreign and unknown IDs are simply absent from the result.
 *
 * Lock-order rule (ARCHITECTURE.md A35): purchase row, then order rows (this
 * function), then the first write, which takes the tenant lock. Never lock an
 * order after writing.
 */
export function lockOrdersForUpdate(scope: TenantScope, ids: readonly string[]): Promise<OrderRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return scope.executor.select().from(orders)
    .where(and(scope.tenantEq(orders), inArray(orders.id, [...ids])))
    .orderBy(asc(orders.id)).for('update');
}

/** Newest first; the ID breaks ties so pages are stable. */
export function listOrders(scope: TenantScope, page: PageRequest): Promise<OrderRow[]> {
  return scope.executor.select().from(orders)
    .where(scope.tenantEq(orders))
    .orderBy(desc(orders.orderDate), desc(orders.id))
    .limit(page.limit).offset(page.offset);
}

export function countOrders(scope: TenantScope): Promise<number> {
  return countTenantRows(scope, orders);
}

export async function updateOrder(scope: TenantScope, id: string, values: OrderUpdate): Promise<OrderRow | null> {
  const [row] = await scope.update(orders, { ...values, updatedAt: new Date() }, eq(orders.id, id));
  return row ?? null;
}
