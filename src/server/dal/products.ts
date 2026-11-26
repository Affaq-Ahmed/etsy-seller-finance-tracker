import 'server-only';
import { asc, eq, inArray } from 'drizzle-orm';
import { products } from '@/db/schema';
import { countTenantRows, expectRow, type PageRequest, type TenantInsert, type TenantRow, type TenantScope } from './tenant-scope';

export type ProductRow = TenantRow<typeof products>;
export type ProductInsert = TenantInsert<typeof products>;

export async function insertProduct(scope: TenantScope, values: ProductInsert): Promise<ProductRow> {
  return expectRow(await scope.insert(products, [values]));
}

export async function findProductById(scope: TenantScope, id: string): Promise<ProductRow | null> {
  const [row] = await scope.select(products, eq(products.id, id));
  return row ?? null;
}

/** Only the session tenant's products are returned; unknown or foreign IDs are simply absent. */
export function findProductsByIds(scope: TenantScope, ids: readonly string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return scope.select(products, inArray(products.id, [...ids]));
}

export function listProducts(scope: TenantScope, page: PageRequest): Promise<ProductRow[]> {
  return scope.executor.select().from(products)
    .where(scope.tenantEq(products))
    .orderBy(asc(products.name), asc(products.id))
    .limit(page.limit).offset(page.offset);
}

export function countProducts(scope: TenantScope): Promise<number> {
  return countTenantRows(scope, products);
}
