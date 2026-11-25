import 'server-only';
import { and, eq } from 'drizzle-orm';
import { businessAccounts } from '@/db/schema';
import type { DbExecutor } from '@/server/db/client';
import type { TenantContext } from '@/server/auth/tenant-context';

// `business_accounts` is the tenant root: it has no `account_id`. It is keyed by
// the session user (`owner_user_id`) for resolution, and by the session-derived
// tenant *and* owner for reads, so a mismatched pair can never return a row.

export type BusinessAccountRow = typeof businessAccounts.$inferSelect;

/** Tenant resolution: the business owned by the authenticated user, if any. */
export async function findBusinessIdByOwner(db: DbExecutor, ownerUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: businessAccounts.id })
    .from(businessAccounts)
    .where(eq(businessAccounts.ownerUserId, ownerUserId))
    .limit(1);
  return row?.id ?? null;
}

export async function findBusinessByOwner(db: DbExecutor, ownerUserId: string): Promise<BusinessAccountRow | null> {
  const [row] = await db.select().from(businessAccounts).where(eq(businessAccounts.ownerUserId, ownerUserId)).limit(1);
  return row ?? null;
}

/**
 * Inserts the owner's business unless one exists. Relies on the unique
 * `business_accounts_owner_uq` index: a concurrent or repeated insert returns
 * null instead of raising, so the caller's transaction stays usable.
 */
export async function insertBusinessIfAbsent(
  db: DbExecutor,
  ownerUserId: string,
  values: { readonly shopName: string },
): Promise<BusinessAccountRow | null> {
  const [row] = await db
    .insert(businessAccounts)
    .values({ ownerUserId, shopName: values.shopName })
    .onConflictDoNothing({ target: businessAccounts.ownerUserId })
    .returning();
  return row ?? null;
}

export async function getTenantBusiness(db: DbExecutor, tenant: TenantContext): Promise<BusinessAccountRow | null> {
  const { accountId, userId } = tenant;
  const [row] = await db
    .select()
    .from(businessAccounts)
    .where(and(eq(businessAccounts.id, accountId), eq(businessAccounts.ownerUserId, userId)))
    .limit(1);
  return row ?? null;
}
