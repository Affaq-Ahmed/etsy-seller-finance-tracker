import 'server-only';
import { sql } from 'drizzle-orm';
import { purchaseIsReversedSql } from './journal';
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
