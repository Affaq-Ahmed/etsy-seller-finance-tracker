import 'server-only';
import { formatMoney, parseDbMoney } from '@/lib/money';
import type { OrderCostSummary, OrderExpenseSummary } from '@/server/dal/order-profit';
import type { OrderStatus } from './status';

/**
 * "Direct profit before refunds" (owner decisions, Phase 2a and Phase 2b Slice 1):
 *
 *   Etsy net payable - confirmed, unreversed supplier costs on the order's items
 *                    - confirmed, unreversed DIRECT expenses on the order
 *
 * A CANCELLED order counts **zero** Etsy revenue (owner decision D9): Etsy will
 * not pay for it. Supplier costs that were already confirmed stay recorded and
 * keep counting, and so do DIRECT expenses (PRODUCT.md §6.3, ARCHITECTURE.md
 * A38), so a cancelled order with costs or expenses shows a loss. Nothing is
 * reversed automatically when an order is cancelled.
 *
 * Draft, cancelled, voided and reversed records are excluded. SHARED expenses are
 * never part of an order's profit. Refunds are NOT included yet (Phase 2b); the
 * flags below are part of the response so no client can present this as final
 * profit. All arithmetic is exact (scale-4 integers); nothing is rounded.
 */
export interface OrderProfitView {
  /** The recorded Etsy net payable. Shown for every order, including cancelled ones. */
  readonly netPayable: string;
  /** What counts toward profit: the net payable, or 0 when the order is cancelled. */
  readonly revenue: string;
  readonly revenueExcluded: boolean;
  readonly confirmedSupplierCosts: string;
  /** Draft purchase lines for this order. Shown for information; never counted. */
  readonly draftSupplierCosts: string;
  readonly confirmedDirectExpenses: string;
  /** Draft DIRECT expenses for this order. Shown for information; never counted. */
  readonly draftDirectExpenses: string;
  readonly directProfitBeforeRefunds: string;
  readonly includesExpenses: true;
  readonly includesRefunds: false;
}

const NO_COSTS: OrderCostSummary = { confirmedCost: '0', draftCost: '0' };
const NO_EXPENSES: OrderExpenseSummary = { confirmedExpenses: '0', draftExpenses: '0' };

export function buildOrderProfit(
  netPayableAmount: string, summary: OrderCostSummary | undefined, expenseSummary: OrderExpenseSummary | undefined, status: OrderStatus,
): OrderProfitView {
  const costs = summary ?? NO_COSTS;
  const expenses = expenseSummary ?? NO_EXPENSES;
  const net = parseDbMoney(netPayableAmount);
  const confirmedCosts = parseDbMoney(costs.confirmedCost);
  const confirmedExpenses = parseDbMoney(expenses.confirmedExpenses);
  const revenueExcluded = status === 'CANCELLED';
  const revenue = revenueExcluded ? BigInt(0) : net;
  return {
    netPayable: formatMoney(net),
    revenue: formatMoney(revenue),
    revenueExcluded,
    confirmedSupplierCosts: formatMoney(confirmedCosts),
    draftSupplierCosts: formatMoney(parseDbMoney(costs.draftCost)),
    confirmedDirectExpenses: formatMoney(confirmedExpenses),
    draftDirectExpenses: formatMoney(parseDbMoney(expenses.draftExpenses)),
    directProfitBeforeRefunds: formatMoney(revenue - confirmedCosts - confirmedExpenses),
    includesExpenses: true,
    includesRefunds: false,
  };
}
