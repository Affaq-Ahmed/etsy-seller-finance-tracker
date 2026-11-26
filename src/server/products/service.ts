import 'server-only';
import { z } from 'zod';
import { formatDbMoney, parseMoneyInput, toDbMoney } from '@/lib/money';
import type { Database } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { loadBusinessContext } from '@/server/business/context';
import { insertAuditLogs } from '@/server/dal/audit-logs';
import { countProducts, insertProduct, listProducts as listProductRows, type ProductRow } from '@/server/dal/products';
import { findSupplierById } from '@/server/dal/suppliers';
import { tenantScope, type PageRequest } from '@/server/dal/tenant-scope';
import { conflict, unprocessable } from '@/server/domain/errors';
import { getPostgresConstraintName, getPostgresErrorCode, PG_UNIQUE_VIOLATION } from '@/server/db/errors';
import { runInTransaction } from '@/server/db/transaction';
import { toPage, type Page } from '@/server/http/pagination';
import { moneyField, nameField, notesField, skuField, urlField, uuidField } from '@/server/validation/fields';

const PRODUCT_SKU_CONSTRAINT = 'products_tenant_sku_uq';

export const createProductSchema = z.strictObject({
  name: nameField,
  sku: skuField.optional(),
  imageUrl: urlField.optional(),
  defaultSupplierId: uuidField.nullable().optional(),
  /** Informational only: never an actual cost and never posted (PRODUCT.md §5 rule 5). */
  defaultUnitCost: moneyField.nullable().optional(),
  notes: notesField.optional(),
});
export type CreateProductInput = z.output<typeof createProductSchema>;

export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly imageUrl: string | null;
  readonly defaultSupplierId: string | null;
  /** Informational default cost; it never affects order profit or the ledger. */
  readonly defaultUnitCost: string | null;
  readonly currency: string;
  readonly notes: string | null;
  readonly createdAt: string;
}

export function toProductView(row: ProductRow): ProductView {
  return {
    id: row.id, name: row.name, sku: row.sku, imageUrl: row.imageUrl, defaultSupplierId: row.defaultSupplierId,
    defaultUnitCost: row.defaultUnitCost === null ? null : formatDbMoney(row.defaultUnitCost),
    currency: row.currency, notes: row.notes, createdAt: row.createdAt.toISOString(),
  };
}

export async function createProduct(db: Database, tenant: TenantContext, input: CreateProductInput): Promise<ProductView> {
  try {
    return await runInTransaction(db, async (tx) => {
      const scope = tenantScope(tx, tenant);
      const business = await loadBusinessContext(tx, tenant);
      if (input.defaultSupplierId && !(await findSupplierById(scope, input.defaultSupplierId))) {
        throw unprocessable('SUPPLIER_NOT_FOUND', 'Supplier not found.', ['defaultSupplierId']);
      }
      const unitCost = input.defaultUnitCost ? parseMoneyInput(input.defaultUnitCost) : null;
      const row = await insertProduct(scope, {
        name: input.name, sku: input.sku ?? null, imageUrl: input.imageUrl ?? null,
        defaultSupplierId: input.defaultSupplierId ?? null,
        defaultUnitCost: unitCost === null ? null : toDbMoney(unitCost),
        currency: business.baseCurrency, notes: input.notes ?? null,
      });
      await insertAuditLogs(scope, [{
        entityType: 'product', entityId: row.id, action: 'CREATE', beforeData: null,
        afterData: { name: row.name, sku: row.sku, defaultSupplierId: row.defaultSupplierId },
      }]);
      return toProductView(row);
    });
  } catch (error) {
    if (getPostgresErrorCode(error) === PG_UNIQUE_VIOLATION && getPostgresConstraintName(error) === PRODUCT_SKU_CONSTRAINT) {
      throw conflict('DUPLICATE_SKU', 'A product with this SKU already exists.', ['sku']);
    }
    throw error;
  }
}

export async function listProducts(db: Database, tenant: TenantContext, request: PageRequest): Promise<Page<ProductView>> {
  const scope = tenantScope(db, tenant);
  const [rows, total] = await Promise.all([listProductRows(scope, request), countProducts(scope)]);
  return toPage(rows.map(toProductView), request, total);
}
