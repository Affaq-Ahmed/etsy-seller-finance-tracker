import 'server-only';
import { accountSettings } from '@/db/schema';
import type { TenantInsert, TenantRow, TenantScope } from './tenant-scope';

export type AccountSettingRow = TenantRow<typeof accountSettings>;
export type AccountSettingInsert = TenantInsert<typeof accountSettings>;

export function insertAccountSettings(scope: TenantScope, rows: readonly AccountSettingInsert[]): Promise<AccountSettingRow[]> {
  return scope.insert(accountSettings, rows);
}

export function listAccountSettings(scope: TenantScope): Promise<AccountSettingRow[]> {
  return scope.select(accountSettings);
}
