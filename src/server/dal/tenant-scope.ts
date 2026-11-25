import 'server-only';
import { and, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable, PgUpdateSetSource, PgInsertValue } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';

/** A tenant-owned table: has the non-null `account_id` tenant column. */
export type TenantTable = PgTable & { readonly accountId: AnyPgColumn };

export type TenantRow<T extends TenantTable> = T['$inferSelect'];
/** Insert values never carry the tenant; it comes from the session context. */
export type TenantInsert<T extends TenantTable> = Omit<T['$inferInsert'], 'accountId'>;
/** Updates can never move a row to another tenant. */
export type TenantUpdate<T extends TenantTable> = Partial<Omit<T['$inferInsert'], 'accountId' | 'id'>>;

/** Keys that must never be supplied by callers of the tenant scope. */
export const FORBIDDEN_TENANT_KEYS: readonly string[] = ['accountId', 'account_id', 'tenantId', 'tenant_id', 'ownerUserId', 'owner_user_id'];

export class TenantScopeViolationError extends Error {
  constructor(reason: string) {
    super(`Tenant scope violation: ${reason}`);
    this.name = 'TenantScopeViolationError';
  }
}

function assertNoTenantKeys(values: object): void {
  for (const key of FORBIDDEN_TENANT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new TenantScopeViolationError(`caller supplied "${key}"`);
    }
  }
}

/**
 * The only way DAL modules read or write tenant-owned tables. Every SELECT,
 * UPDATE and DELETE is constrained to `account_id = tenant.accountId`, and
 * every INSERT takes `account_id` from the session-derived context.
 */
export interface TenantScope {
  readonly tenant: TenantContext;
  select<T extends TenantTable>(table: T, where?: SQL): Promise<TenantRow<T>[]>;
  insert<T extends TenantTable>(table: T, rows: readonly TenantInsert<T>[]): Promise<TenantRow<T>[]>;
  update<T extends TenantTable>(table: T, values: TenantUpdate<T>, where: SQL): Promise<TenantRow<T>[]>;
  delete<T extends TenantTable>(table: T, where: SQL): Promise<TenantRow<T>[]>;
}

export function tenantScope(db: DbExecutor, tenant: TenantContext): TenantScope {
  const scoped = (table: TenantTable, where?: SQL): SQL => {
    const predicate = and(eq(table.accountId, tenant.accountId), where);
    if (!predicate) throw new TenantScopeViolationError('missing tenant predicate');
    return predicate;
  };

  return {
    tenant,

    async select<T extends TenantTable>(table: T, where?: SQL) {
      const rows = await db.select().from(table as PgTable).where(scoped(table, where));
      return rows as TenantRow<T>[];
    },

    async insert<T extends TenantTable>(table: T, rows: readonly TenantInsert<T>[]) {
      if (rows.length === 0) return [];
      const values = rows.map((row) => {
        assertNoTenantKeys(row);
        return { ...row, accountId: tenant.accountId };
      });
      const inserted = await db.insert(table).values(values as PgInsertValue<T>[]).returning();
      return inserted as TenantRow<T>[];
    },

    async update<T extends TenantTable>(table: T, values: TenantUpdate<T>, where: SQL) {
      assertNoTenantKeys(values);
      const updated = await db.update(table).set(values as PgUpdateSetSource<T>).where(scoped(table, where)).returning();
      return updated as TenantRow<T>[];
    },

    async delete<T extends TenantTable>(table: T, where: SQL) {
      const deleted = await db.delete(table).where(scoped(table, where)).returning();
      return deleted as TenantRow<T>[];
    },
  };
}
