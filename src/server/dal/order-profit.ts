import 'server-only';
import { sql } from 'drizzle-orm';
import { expenseIsReversedSql, purchaseIsReversedSql } from './journal';
import type { TenantScope } from './tenant-scope';

/**
 * Supplier costs per order, as exact NUMERIC text (no rounding anywhere).
 *
 *  - confirmedCost: lines of CONFIRMED purchases that have NOT been reversed.
 *    This is the only cost that affects actual profit.
 *  - draftCost: lines of DRAFT purchases, shown separately and never counted.
 *
 * Cancelled purchases and reversed purchases contribute to neither.
 * Purchase statuses PARTIALLY_REFUNDED and REFUNDED are counted at full cost
 * here; supplier refunds (Phase 2b) must subtract refund amounts in this query.
 */
export interface OrderCostSummary {
  readonly confirmedCost: string;
  readonly draftCost: string;
}

export async function costSummaryByOrder(scope: TenantScope, orderIds: readonly string[]): Promise<Map<string, OrderCostSummary>> {
  if (orderIds.length === 0) return new Map();
  const tenant = scope.tenant.accountId;
  const ids = sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await scope.executor.execute<{ order_id: string; confirmed_cost: string; draft_cost: string }>(sql`
    SELECT oi.order_id AS order_id,
      coalesce(sum(spi.total_cost) FILTER (
        WHERE sp.status IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED')
          AND NOT ${purchaseIsReversedSql(sql.raw('sp.account_id'), sql.raw('sp.id'))}), 0)::text AS confirmed_cost,
      coalesce(sum(spi.total_cost) FILTER (WHERE sp.status = 'DRAFT'), 0)::text AS draft_cost
    FROM order_items oi
    JOIN supplier_purchase_items spi ON spi.account_id = oi.account_id AND spi.order_item_id = oi.id
    JOIN supplier_purchases sp ON sp.account_id = spi.account_id AND sp.id = spi.supplier_purchase_id
    WHERE oi.account_id = ${tenant}::uuid AND spi.account_id = ${tenant}::uuid AND sp.account_id = ${tenant}::uuid
      AND oi.order_id IN (${ids})
    GROUP BY oi.order_id`);
  return new Map([...rows].map((row) => [row.order_id, { confirmedCost: row.confirmed_cost, draftCost: row.draft_cost }]));
}

/**
 * DIRECT order expenses per order, as exact NUMERIC text (no rounding anywhere).
 *
 *  - confirmedExpenses: expenses with status CONFIRMED that have a FINALIZED
 *    INITIAL `expense` journal entry and no finalized reversal. This is the only
 *    expense amount that affects actual profit. The status alone is never enough:
 *    a reversed expense keeps status CONFIRMED.
 *  - draftExpenses: DRAFT expenses, shown separately and never counted.
 *
 * VOIDED and reversed expenses contribute to neither. SHARED expenses (no order)
 * are never part of an order's profit.
 *
 * This is deliberately a SEPARATE query from `costSummaryByOrder`: joining
 * expenses into the purchase-line aggregate would multiply each expense by the
 * order's number of purchase lines (fan-out). Each aggregate groups one table.
 */
export interface OrderExpenseSummary {
  readonly confirmedExpenses: string;
  readonly draftExpenses: string;
}

export async function expenseSummaryByOrder(scope: TenantScope, orderIds: readonly string[]): Promise<Map<string, OrderExpenseSummary>> {
  if (orderIds.length === 0) return new Map();
  const tenant = scope.tenant.accountId;
  const ids = sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await scope.executor.execute<{ order_id: string; confirmed_expenses: string; draft_expenses: string }>(sql`
    SELECT e.order_id AS order_id,
      coalesce(sum(e.amount) FILTER (
        WHERE e.status = 'CONFIRMED'
          AND EXISTS (
            SELECT 1 FROM journal_entries posted
            WHERE posted.account_id = ${tenant}::uuid AND posted.source_type = 'expense' AND posted.source_id = e.id
              AND posted.source_event = 'INITIAL' AND posted.status = 'FINALIZED')
          AND NOT ${expenseIsReversedSql(sql.raw('e.account_id'), sql.raw('e.id'))}), 0)::text AS confirmed_expenses,
      coalesce(sum(e.amount) FILTER (WHERE e.status = 'DRAFT'), 0)::text AS draft_expenses
    FROM expenses e
    WHERE e.account_id = ${tenant}::uuid AND e.expense_type = 'DIRECT' AND e.order_id IN (${ids})
    GROUP BY e.order_id`);
  return new Map([...rows].map((row) => [row.order_id, { confirmedExpenses: row.confirmed_expenses, draftExpenses: row.draft_expenses }]));
}
