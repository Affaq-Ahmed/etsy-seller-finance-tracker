import 'server-only';
import { insertAuditLogs } from '@/server/dal/audit-logs';
import {
  insertFinancialAccountIfAbsent, listActiveAccountsByName, listActiveAccountsByRole, type FinancialAccountRow,
} from '@/server/dal/financial-accounts';
import type { TenantScope } from '@/server/dal/tenant-scope';
import { unprocessable } from '@/server/domain/errors';

/**
 * Supplier Payable (ARCHITECTURE.md A25): a LIABILITY account with the existing
 * UNCLASSIFIED role. Confirming a purchase debits SUPPLIER_COST and credits this
 * account, so the cost is recognized once and the obligation to pay stays open.
 * Phase 3 settles it from the Payoneer or bank payment (debit Supplier Payable,
 * credit the paying asset) and must never post the supplier cost again.
 *
 * No new account role exists; the account is found by exact name, type and
 * currency. The application never renames or retypes accounts.
 */
export const SUPPLIER_PAYABLE_ACCOUNT_NAME = 'Supplier Payable';

const UNAVAILABLE = 'LEDGER_ACCOUNT_UNAVAILABLE';

/** The tenant's single active SUPPLIER_COST account in `currency`; ambiguity fails closed. */
export async function resolveSupplierCostAccount(scope: TenantScope, currency: string): Promise<FinancialAccountRow> {
  const accounts = await listActiveAccountsByRole(scope, 'SUPPLIER_COST', currency);
  const [account] = accounts;
  if (!account) {
    throw unprocessable(UNAVAILABLE, `No active ${currency} supplier cost account is set up for this business.`);
  }
  if (accounts.length > 1) {
    throw unprocessable(UNAVAILABLE, `More than one active ${currency} supplier cost account exists; the posting account is ambiguous.`);
  }
  return account;
}

/**
 * The tenant's Supplier Payable account in `currency`. Businesses onboarded
 * before this account existed get it created here, inside the caller's
 * transaction (idempotent and race-safe through the unique name/currency index).
 */
export async function ensureSupplierPayableAccount(scope: TenantScope, currency: string): Promise<FinancialAccountRow> {
  const find = () => listActiveAccountsByName(scope, SUPPLIER_PAYABLE_ACCOUNT_NAME, 'LIABILITY', currency);
  let accounts = await find();
  if (accounts.length === 0) {
    const created = await insertFinancialAccountIfAbsent(scope, {
      name: SUPPLIER_PAYABLE_ACCOUNT_NAME, accountType: 'LIABILITY', accountRole: 'UNCLASSIFIED', currency,
    });
    if (created) {
      await insertAuditLogs(scope, [{
        entityType: 'financial_account', entityId: created.id, action: 'CREATE', beforeData: null,
        afterData: { name: created.name, accountType: created.accountType, accountRole: created.accountRole, currency: created.currency, reason: 'supplier_payable_backfill' },
      }]);
    }
    accounts = await find();
  }
  const [account] = accounts;
  if (!account) {
    // A same-named account of another type or an inactive one blocks creation.
    throw unprocessable(UNAVAILABLE, `No active ${currency} ${SUPPLIER_PAYABLE_ACCOUNT_NAME} liability account is available.`);
  }
  if (accounts.length > 1) throw unprocessable(UNAVAILABLE, `More than one active ${currency} ${SUPPLIER_PAYABLE_ACCOUNT_NAME} account exists.`);
  return account;
}
