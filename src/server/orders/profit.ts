import 'server-only';
import { formatMoney, parseDbMoney } from '@/lib/money';
import type { OrderCostSummary } from '@/server/dal/order-profit';
import type { OrderStatus } from './status';

/**
 * "Direct profit before expenses and refunds" (owner decision, Phase 2a):
 *
 *   Etsy net payable - confirmed, unreversed supplier costs on the order's items
 *
 * A CANCELLED order counts **zero** Etsy revenue (owner decision D9): Etsy will
 * not pay for it. Supplier costs that were already confirmed stay recorded and
 * keep counting, so a cancelled order with confirmed costs shows a loss. Nothing
 * is reversed automatically when an order is cancelled.
 *
 * Draft, cancelled and reversed purchases are excluded. Order expenses and
 * refunds are NOT included yet (Phase 2b); the flags below are part of the
 * response so no client can present this as final profit. All arithmetic is
 * exact (scale-4 integers); nothing is rounded.
 */
export interface OrderProfitView {
  /** The recorded Etsy net payable. Shown for every order, including cancelled ones. */
  readonly netPayable: string;
  /** What counts toward profit: the net payable, or 0 when the order is cancelled. */
  readonly revenue: string;
  readonly revenueExcluded: boolean;
  readonly confirmedSupplierCosts: string;
  readonly directProfitBeforeExpensesAndRefunds: string;
  /** Draft purchase lines for this order. Shown for information; never counted. */
  readonly draftSupplierCosts: string;
  readonly includesExpenses: false;
  readonly includesRefunds: false;
}

const NO_COSTS: OrderCostSummary = { confirmedCost: '0', draftCost: '0' };

export function buildOrderProfit(netPayableAmount: string, summary: OrderCostSummary | undefined, status: OrderStatus): OrderProfitView {
  const costs = summary ?? NO_COSTS;
  const net = parseDbMoney(netPayableAmount);
  const confirmed = parseDbMoney(costs.confirmedCost);
  const revenueExcluded = status === 'CANCELLED';
  const revenue = revenueExcluded ? BigInt(0) : net;
  return {
    netPayable: formatMoney(net),
    revenue: formatMoney(revenue),
    revenueExcluded,
    confirmedSupplierCosts: formatMoney(confirmed),
    directProfitBeforeExpensesAndRefunds: formatMoney(revenue - confirmed),
    draftSupplierCosts: formatMoney(parseDbMoney(costs.draftCost)),
    includesExpenses: false,
    includesRefunds: false,
  };
}
