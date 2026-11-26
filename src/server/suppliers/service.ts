import 'server-only';
import { z } from 'zod';
import type { Database } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';
import { insertAuditLogs } from '@/server/dal/audit-logs';
import { countSuppliers, insertSupplier, listSuppliers as listSupplierRows, type SupplierRow } from '@/server/dal/suppliers';
import { tenantScope, type PageRequest } from '@/server/dal/tenant-scope';
import { runInTransaction } from '@/server/db/transaction';
import { toPage, type Page } from '@/server/http/pagination';
import { nameField, notesField, urlField } from '@/server/validation/fields';

// Marketplaces are validated here; the column is free text and carries no
// database CHECK (owner decision, Phase 2a).
export const SUPPLIER_MARKETPLACES = ['EBAY', 'AMAZON', 'ALIEXPRESS', 'CUSTOM'] as const;
export type SupplierMarketplace = (typeof SUPPLIER_MARKETPLACES)[number];

export const createSupplierSchema = z.strictObject({
  name: nameField,
  marketplace: z.enum(SUPPLIER_MARKETPLACES),
  websiteUrl: urlField.optional(),
  notes: notesField.optional(),
});
export type CreateSupplierInput = z.output<typeof createSupplierSchema>;

export interface SupplierView {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly websiteUrl: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
}

export function toSupplierView(row: SupplierRow): SupplierView {
  return { id: row.id, name: row.name, marketplace: row.marketplace, websiteUrl: row.websiteUrl, notes: row.notes, createdAt: row.createdAt.toISOString() };
}

export function createSupplier(db: Database, tenant: TenantContext, input: CreateSupplierInput): Promise<SupplierView> {
  return runInTransaction(db, async (tx) => {
    const scope = tenantScope(tx, tenant);
    const row = await insertSupplier(scope, {
      name: input.name, marketplace: input.marketplace, websiteUrl: input.websiteUrl ?? null, notes: input.notes ?? null,
    });
    await insertAuditLogs(scope, [{
      entityType: 'supplier', entityId: row.id, action: 'CREATE', beforeData: null,
      afterData: { name: row.name, marketplace: row.marketplace },
    }]);
    return toSupplierView(row);
  });
}

export async function listSuppliers(db: Database, tenant: TenantContext, request: PageRequest): Promise<Page<SupplierView>> {
  const scope = tenantScope(db, tenant);
  const [rows, total] = await Promise.all([listSupplierRows(scope, request), countSuppliers(scope)]);
  return toPage(rows.map(toSupplierView), request, total);
}
