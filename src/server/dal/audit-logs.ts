import 'server-only';
import { auditLogs } from '@/db/schema';
import type { TenantRow, TenantScope } from './tenant-scope';

export type AuditLogRow = TenantRow<typeof auditLogs>;

export interface AuditEntry {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly beforeData: unknown;
  readonly afterData: unknown;
}

/**
 * Writes audit entries for the session user. The actor always comes from the
 * tenant context; the composite FK `audit_logs_owner_tenant_fk` additionally
 * requires it to be the owner of `account_id`.
 */
export function insertAuditLogs(scope: TenantScope, entries: readonly AuditEntry[]): Promise<AuditLogRow[]> {
  return scope.insert(auditLogs, entries.map((entry) => ({ ...entry, userId: scope.tenant.userId })));
}

export function listAuditLogs(scope: TenantScope): Promise<AuditLogRow[]> {
  return scope.select(auditLogs);
}
