import { randomInt, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { AppContainer } from '@/server/container';
import { createOrder, type CreateOrderInput, type OrderDetail } from '@/server/orders/service';
import { createProduct, type ProductView } from '@/server/products/service';
import { createPurchase, type CreatePurchaseInput, type PurchaseDetail } from '@/server/purchases/service';
import { createSupplier, type SupplierView } from '@/server/suppliers/service';
import { testDatabaseUrl } from './database';
import type { OnboardedUser } from './app';

export const ORDER_DATE = '2026-11-20';
export const PURCHASE_DATE = '2026-11-22';

export function uniqueEtsyId(): string {
  return `${randomInt(1_000_000_000, 9_999_999_999)}${randomInt(10, 99)}`;
}

export function openRaw(): postgres.Sql {
  return postgres(testDatabaseUrl(), { max: 3, onnotice: () => undefined });
}

export function makeSupplier(app: AppContainer, user: OnboardedUser, overrides: Partial<Parameters<typeof createSupplier>[2]> = {}): Promise<SupplierView> {
  return createSupplier(app.db, user.tenant, { name: 'Test Supplier', marketplace: 'EBAY', ...overrides });
}

export function makeProduct(app: AppContainer, user: OnboardedUser, overrides: Partial<Parameters<typeof createProduct>[2]> = {}): Promise<ProductView> {
  return createProduct(app.db, user.tenant, { name: `Product ${randomUUID().slice(0, 8)}`, ...overrides });
}

export function makeOrder(app: AppContainer, user: OnboardedUser, overrides: Partial<CreateOrderInput> = {}): Promise<OrderDetail> {
  return createOrder(app.db, user.tenant, {
    etsyOrderId: uniqueEtsyId(),
    orderDate: ORDER_DATE,
    netPayableAmount: '100.00',
    items: [{ productName: 'Mug', quantity: 2 }, { productName: 'Plate', quantity: 1 }],
    ...overrides,
  });
}

/** A DRAFT purchase covering the order's items at the given unit costs (defaults: 10.00 and 5.05). */
export function makeDraftPurchase(
  app: AppContainer, user: OnboardedUser, supplierId: string, order: OrderDetail,
  overrides: Partial<CreatePurchaseInput> = {},
): Promise<PurchaseDetail> {
  const [first, second] = order.items;
  if (!first || !second) throw new Error('makeDraftPurchase needs an order with two items');
  return createPurchase(app.db, user.tenant, {
    supplierId,
    purchaseDate: PURCHASE_DATE,
    lines: [
      { orderItemId: first.id, quantity: 2, unitCost: '10.10' },
      { orderItemId: second.id, quantity: 1, unitCost: '5.05' },
    ],
    ...overrides,
  });
}

/** Total of the default makeDraftPurchase lines: 2 x 10.10 + 1 x 5.05. */
export const DEFAULT_PURCHASE_TOTAL = '25.25';

export async function journalEntryCount(raw: postgres.Sql, tenantId: string, sourceType?: string): Promise<number> {
  const rows = sourceType
    ? await raw`SELECT count(*)::int AS n FROM journal_entries WHERE account_id = ${tenantId} AND source_type = ${sourceType}`
    : await raw`SELECT count(*)::int AS n FROM journal_entries WHERE account_id = ${tenantId}`;
  return Number(rows[0]?.n ?? 0);
}

export async function auditCount(raw: postgres.Sql, tenantId: string, entityType: string, action: string, entityId?: string): Promise<number> {
  const rows = entityId
    ? await raw`SELECT count(*)::int AS n FROM audit_logs WHERE account_id = ${tenantId} AND entity_type = ${entityType} AND action = ${action} AND entity_id = ${entityId}`
    : await raw`SELECT count(*)::int AS n FROM audit_logs WHERE account_id = ${tenantId} AND entity_type = ${entityType} AND action = ${action}`;
  return Number(rows[0]?.n ?? 0);
}
