import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { suppliers } from '@/db/schema';
import { countTenantRows, expectRow, type PageRequest, type TenantInsert, type TenantRow, type TenantScope } from './tenant-scope';

export type SupplierRow = TenantRow<typeof suppliers>;
export type SupplierInsert = TenantInsert<typeof suppliers>;

export async function insertSupplier(scope: TenantScope, values: SupplierInsert): Promise<SupplierRow> {
  return expectRow(await scope.insert(suppliers, [values]));
}

/** Another tenant's ID yields null, exactly like an ID that does not exist. */
export async function findSupplierById(scope: TenantScope, id: string): Promise<SupplierRow | null> {
  const [row] = await scope.select(suppliers, eq(suppliers.id, id));
  return row ?? null;
}

export function listSuppliers(scope: TenantScope, page: PageRequest): Promise<SupplierRow[]> {
  return scope.executor.select().from(suppliers)
    .where(scope.tenantEq(suppliers))
    .orderBy(asc(suppliers.name), asc(suppliers.id))
    .limit(page.limit).offset(page.offset);
}

export function countSuppliers(scope: TenantScope): Promise<number> {
  return countTenantRows(scope, suppliers);
}
