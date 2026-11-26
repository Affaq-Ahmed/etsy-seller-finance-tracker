import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { suppliers, supplierPurchases } from '@/db/schema';
import { purchaseIsReversedSql } from './journal';
import {
  countTenantRows, expectRow, type PageRequest, type TenantInsert, type TenantRow, type TenantScope, type TenantUpdate,
} from './tenant-scope';

export type PurchaseRow = TenantRow<typeof supplierPurchases>;
export type PurchaseInsert = TenantInsert<typeof supplierPurchases>;
export type PurchaseUpdate = TenantUpdate<typeof supplierPurchases>;

/** A purchase with its supplier's name and whether its posting has been reversed. */
export interface PurchaseListRow extends PurchaseRow {
  readonly supplierName: string;
  readonly reversed: boolean;
}

export async function insertPurchase(scope: TenantScope, values: PurchaseInsert): Promise<PurchaseRow> {
  return expectRow(await scope.insert(supplierPurchases, [values]));
}

/** Another tenant's ID yields null, exactly like an ID that does not exist. */
export async function findPurchaseById(scope: TenantScope, id: string): Promise<PurchaseRow | null> {
  const [row] = await scope.select(supplierPurchases, eq(supplierPurchases.id, id));
  return row ?? null;
}

/** Row-locks the purchase for the rest of the transaction (serializes confirm, edit and reverse). */
export async function findPurchaseForUpdate(scope: TenantScope, id: string): Promise<PurchaseRow | null> {
  const [row] = await scope.executor.select().from(supplierPurchases)
    .where(and(scope.tenantEq(supplierPurchases), eq(supplierPurchases.id, id))).for('update');
  return row ?? null;
}

export async function updatePurchase(scope: TenantScope, id: string, values: PurchaseUpdate): Promise<PurchaseRow | null> {
  const [row] = await scope.update(supplierPurchases, { ...values, updatedAt: new Date() }, eq(supplierPurchases.id, id));
  return row ?? null;
}

function listColumns() {
  return { purchase: supplierPurchases, supplierName: suppliers.name };
}

export async function findPurchaseWithSupplier(scope: TenantScope, id: string): Promise<PurchaseListRow | null> {
  const [row] = await scope.executor
    .select({ ...listColumns(), reversed: purchaseIsReversedSql(supplierPurchases.accountId, supplierPurchases.id) })
    .from(supplierPurchases)
    .innerJoin(suppliers, and(eq(suppliers.accountId, supplierPurchases.accountId), eq(suppliers.id, supplierPurchases.supplierId)))
    .where(and(scope.tenantEq(supplierPurchases), scope.tenantEq(suppliers), eq(supplierPurchases.id, id)));
  return row ? { ...row.purchase, supplierName: row.supplierName, reversed: row.reversed } : null;
}

/** Newest first; the ID breaks ties so pages are stable. */
export async function listPurchases(scope: TenantScope, page: PageRequest): Promise<PurchaseListRow[]> {
  const rows = await scope.executor
    .select({ ...listColumns(), reversed: purchaseIsReversedSql(supplierPurchases.accountId, supplierPurchases.id) })
    .from(supplierPurchases)
    .innerJoin(suppliers, and(eq(suppliers.accountId, supplierPurchases.accountId), eq(suppliers.id, supplierPurchases.supplierId)))
    .where(and(scope.tenantEq(supplierPurchases), scope.tenantEq(suppliers)))
    .orderBy(desc(supplierPurchases.createdAt), desc(supplierPurchases.id))
    .limit(page.limit).offset(page.offset);
  return rows.map((row) => ({ ...row.purchase, supplierName: row.supplierName, reversed: row.reversed }));
}

export function countPurchases(scope: TenantScope): Promise<number> {
  return countTenantRows(scope, supplierPurchases);
}
