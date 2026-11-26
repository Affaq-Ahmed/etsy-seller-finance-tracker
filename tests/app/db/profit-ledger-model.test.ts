import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { formatMoney, multiplyByQuantity, parseDbMoney, parseMoneyInput, sumMoney, type Money } from '@/lib/money';
import type { AppContainer } from '@/server/container';
import { changeOrderStatus, getOrderDetail } from '@/server/orders/service';
import { cancelDraftPurchase, confirmPurchase, createPurchase, reversePurchase } from '@/server/purchases/service';
import { hasTestDatabase } from '../support/database';
import { createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import { makeOrder, makeSupplier, openRaw, PURCHASE_DATE } from '../support/phase2';

// Model-based check: random sequences of purchase operations (and a possible
// cancellation of the order, PRODUCT.md D9) are replayed
// against an independent bigint model. After EVERY step the order's profit
// view must equal the model, and at the end the ledger itself (journal
// balances) must agree with the same model, so the profit view and the books
// cannot drift apart unnoticed.

type State = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
interface ModelPurchase { id: string; state: State; reversed: boolean; lines: Array<{ itemId: string; quantity: number; unit: Money }> }

/** Small deterministic PRNG so a failing sequence can be replayed from its seed. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const total = (purchase: ModelPurchase): Money => sumMoney(purchase.lines.map((line) => multiplyByQuantity(line.unit, line.quantity)));
const money = (cents: number): Money => {
  const parsed = parseMoneyInput(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`);
  if (parsed === null) throw new Error('bad cents');
  return parsed;
};

describe.skipIf(!hasTestDatabase)('profit and ledger agree under random operation sequences', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let user: OnboardedUser;
  let supplierId: string;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    user = await registerAndOnboard(app, 'Model Shop', 'model');
    supplierId = (await makeSupplier(app, user)).id;
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  // A cancelled order counts zero revenue; confirmed, unreversed costs always count.
  const expectedProfit = (net: Money, purchases: ModelPurchase[], orderCancelled: boolean) => {
    const confirmed = sumMoney(purchases.filter((p) => p.state === 'CONFIRMED' && !p.reversed).map(total));
    const drafts = sumMoney(purchases.filter((p) => p.state === 'DRAFT').map(total));
    const revenue = orderCancelled ? BigInt(0) : net;
    return {
      netPayable: formatMoney(net), revenue: formatMoney(revenue), revenueExcluded: orderCancelled,
      confirmedSupplierCosts: formatMoney(confirmed), draftSupplierCosts: formatMoney(drafts),
      directProfitBeforeExpensesAndRefunds: formatMoney(revenue - confirmed),
    };
  };

  const coverage = { cancelledSequences: 0, rejectedCreates: 0, rejectedConfirmations: 0 };

  it.each([[1], [7], [2026], [31337], [4242], [99]])('seed %i', async (seed) => {
    const random = mulberry32(seed);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    const netCents = 1_000 + Math.floor(random() * 90_000);
    const net = money(netCents);
    const order = await makeOrder(app, user, {
      netPayableAmount: formatMoney(net),
      items: [{ productName: 'A', quantity: 5 }, { productName: 'B', quantity: 5 }, { productName: 'C', quantity: 5 }],
    });
    const purchases: ModelPurchase[] = [];
    let orderCancelled = false;
    let applied = 0;

    for (let step = 0; step < 30; step++) {
      const operation = purchases.length === 0 ? 'create' : pick(['create', 'create', 'confirm', 'confirm', 'cancel', 'reverse', 'cancel-order']);
      if (operation === 'cancel-order') {
        if (!orderCancelled) {
          await changeOrderStatus(app.db, user.tenant, order.order.id, { status: 'CANCELLED' });
          orderCancelled = true;
          coverage.cancelledSequences++;
        }
      } else if (operation === 'create') {
        const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
          itemId: pick(order.items).id, quantity: 1 + Math.floor(random() * 4), unit: money(1 + Math.floor(random() * 20_000)),
        }));
        const attempt = createPurchase(app.db, user.tenant, {
          supplierId, purchaseDate: PURCHASE_DATE,
          lines: lines.map((line) => ({ orderItemId: line.itemId, quantity: line.quantity, unitCost: formatMoney(line.unit) })),
        });
        if (orderCancelled) {
          // A cancelled order accepts no new purchase, and nothing is created.
          await expect(attempt, `seed ${seed}, step ${step}`).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
          coverage.rejectedCreates++;
        } else {
          const created = await attempt;
          purchases.push({ id: created.purchase.id, state: 'DRAFT', reversed: false, lines });
        }
      } else {
        const candidates = purchases.filter((p) => (operation === 'reverse' ? p.state === 'CONFIRMED' && !p.reversed : p.state === 'DRAFT'));
        const target = candidates.length > 0 ? pick(candidates) : undefined;
        if (!target) continue;
        if (operation === 'confirm') {
          if (orderCancelled) {
            // A draft on a cancelled order cannot be confirmed; it stays a draft.
            await expect(confirmPurchase(app.db, user.tenant, target.id), `seed ${seed}, step ${step}`).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
            coverage.rejectedConfirmations++;
          } else {
            await confirmPurchase(app.db, user.tenant, target.id);
            target.state = 'CONFIRMED';
          }
        }
        if (operation === 'cancel') { await cancelDraftPurchase(app.db, user.tenant, target.id); target.state = 'CANCELLED'; }
        // Confirmed costs of a cancelled order can still be reversed by hand.
        if (operation === 'reverse') { await reversePurchase(app.db, user.tenant, target.id, { reason: `model step ${step}` }); target.reversed = true; }
      }
      applied++;
      const { profit, order: current } = await getOrderDetail(app.db, user.tenant, order.order.id);
      expect(current.status === 'CANCELLED', `seed ${seed}, step ${step}: order status`).toBe(orderCancelled);
      expect(profit, `seed ${seed}, step ${step}, after ${operation}`).toMatchObject(expectedProfit(net, purchases, orderCancelled));
    }

    // The books agree with the model: for this order's purchases, the SUPPLIER_COST
    // account nets to the confirmed, unreversed total and Supplier Payable mirrors it.
    const ids = purchases.map((p) => p.id);
    const [books] = await raw`
      WITH entries AS (
        SELECT e.id FROM journal_entries e WHERE e.account_id = ${user.tenant.accountId}
          AND ((e.source_type = 'supplier_purchase' AND e.source_id = ANY(${ids}::uuid[]))
            OR (e.reversal_of_entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'supplier_purchase' AND source_id = ANY(${ids}::uuid[]))))
          AND e.status = 'FINALIZED')
      SELECT coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE fa.account_role = 'SUPPLIER_COST'), 0)::text AS cost_balance,
             coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE fa.name = 'Supplier Payable'), 0)::text AS payable_balance,
             coalesce(sum(l.debit_amount), 0)::text AS debits, coalesce(sum(l.credit_amount), 0)::text AS credits
      FROM entries JOIN journal_lines l ON l.journal_entry_id = entries.id JOIN financial_accounts fa ON fa.id = l.financial_account_id`;
    const confirmedTotal = sumMoney(purchases.filter((p) => p.state === 'CONFIRMED' && !p.reversed).map(total));
    // Compared as exact integers: SQL returns a bare 0 (not 0.0000) when the sequence confirmed nothing.
    expect(parseDbMoney(String(books?.cost_balance)), `seed ${seed} supplier cost balance`).toBe(confirmedTotal);
    expect(parseDbMoney(String(books?.payable_balance)), `seed ${seed} supplier payable balance`).toBe(confirmedTotal);
    expect(parseDbMoney(String(books?.debits)), `seed ${seed} debits equal credits`).toBe(parseDbMoney(String(books?.credits)));
    expect(applied).toBeGreaterThan(3);
  });

  it('the random sequences exercised the cancelled-order rules (cancellation, rejected creates, rejected confirmations)', () => {
    expect(coverage.cancelledSequences).toBeGreaterThan(0);
    expect(coverage.rejectedCreates + coverage.rejectedConfirmations).toBeGreaterThan(0);
  });
});
