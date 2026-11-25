declare const tenantIdBrand: unique symbol;

/**
 * A business account ID that was derived from the authenticated server-side
 * session. Only `src/server/auth/session.ts` creates values of this type
 * (enforced by tests/app/unit/static-guards.test.ts).
 */
export type TenantId = string & { readonly [tenantIdBrand]: true };

export interface SessionContext {
  readonly userId: string;
  readonly sessionId: string;
}

export interface TenantContext extends SessionContext {
  readonly accountId: TenantId;
}
