import 'server-only';
import type { Database } from '@/server/db/client';
import { findBusinessIdByOwner } from '@/server/dal/business-accounts';
import type { Auth } from './auth';
import type { SessionContext, TenantContext, TenantId } from './tenant-context';

// Request-agnostic session and tenant resolution. Everything here derives
// identity from the Better Auth session cookie in `headers`; tenant IDs from
// bodies, query strings, route params, other headers or cookies are never read.

export interface SessionDeps {
  readonly auth: Auth;
  readonly db: Database;
}

export type TenantResolution =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'not_onboarded'; readonly session: SessionContext }
  | { readonly status: 'ok'; readonly tenant: TenantContext };

function brandTenantId(accountId: string): TenantId {
  return accountId as TenantId;
}

/** Null for a missing, malformed, tampered, expired, revoked or signed-out session. */
export async function resolveSession(deps: SessionDeps, headers: Headers): Promise<SessionContext | null> {
  const result = await deps.auth.api.getSession({ headers });
  if (!result) return null;
  return { userId: result.user.id, sessionId: result.session.id };
}

export async function resolveTenant(deps: SessionDeps, headers: Headers): Promise<TenantResolution> {
  const session = await resolveSession(deps, headers);
  if (!session) return { status: 'unauthenticated' };
  const accountId = await findBusinessIdByOwner(deps.db, session.userId);
  if (!accountId) return { status: 'not_onboarded', session };
  return { status: 'ok', tenant: { ...session, accountId: brandTenantId(accountId) } };
}

export class TenantOwnershipError extends Error {
  constructor() {
    super('Business is not owned by the session user');
    this.name = 'TenantOwnershipError';
  }
}

/**
 * Tenant context for a business the session user has just created during
 * onboarding (same transaction). Refuses any business the user does not own.
 */
export function tenantForOwnedBusiness(
  session: SessionContext,
  business: { readonly id: string; readonly ownerUserId: string },
): TenantContext {
  if (business.ownerUserId !== session.userId) throw new TenantOwnershipError();
  return { ...session, accountId: brandTenantId(business.id) };
}
