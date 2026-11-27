import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { formatMoney, multiplyByQuantity, parseDbMoney, parseMoneyInput, sumMoney, type Money } from '@/lib/money';
import type { AppContainer } from '@/server/container';
import { changeOrderStatus, getOrderDetail } from '@/server/orders/service';
import { confirmExpense, createExpense, reverseExpense, voidExpense } from '@/server/expenses/service';
import { cancelDraftPurchase, confirmPurchase, createPurchase, reversePurchase } from '@/server/purchases/service';
import { hasTestDatabase } from '../support/database';
import { createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import { makeOrder, makeSupplier, openRaw, PURCHASE_DATE } from '../support/phase2';

// Model-based check: random sequences of purchase and expense operations (and a
// possible cancellation of the order, PRODUCT.md D9 and ARCHITECTURE.md A38) are
// replayed against an independent bigint model. After EVERY step the order's profit
// view must equal the model, and at the end the ledger itself (journal
// balances) must agree with the same model, so the profit view and the books
// cannot drift apart unnoticed.

type State = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
interface ModelExpense { id: string; scope: 'DIRECT' | 'SHARED'; state: 'DRAFT' | 'CONFIRMED' | 'VOIDED'; reversed: boolean; amount: Money }
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

const STEPS = 100;
const CANCEL_FROM_STEP = 50;
/** Per seed: how often each kind of operation must really have happened (not merely been picked). */
const MINIMUM_OPERATIONS: Readonly<Record<string, number>> = {
  create: 3, confirm: 2, cancel: 1, reverse: 1,
  'create-expense': 5, 'confirm-expense': 2, 'void-expense': 1, 'reverse-expense': 1,
};
const MINIMUM_PURCHASE_OPERATIONS = 24;

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

  const confirmedExpenses = (expenses: ModelExpense[], scope: ModelExpense['scope']) =>
    sumMoney(expenses.filter((e) => e.scope === scope && e.state === 'CONFIRMED' && !e.reversed).map((e) => e.amount));

  // A cancelled order counts zero revenue; confirmed, unreversed costs and DIRECT expenses always count.
  // SHARED expenses never enter an order's profit.
  const expectedProfit = (net: Money, purchases: ModelPurchase[], expenses: ModelExpense[], orderCancelled: boolean) => {
    const confirmed = sumMoney(purchases.filter((p) => p.state === 'CONFIRMED' && !p.reversed).map(total));
    const drafts = sumMoney(purchases.filter((p) => p.state === 'DRAFT').map(total));
    const directConfirmed = confirmedExpenses(expenses, 'DIRECT');
    const directDrafts = sumMoney(expenses.filter((e) => e.scope === 'DIRECT' && e.state === 'DRAFT').map((e) => e.amount));
    const revenue = orderCancelled ? BigInt(0) : net;
    return {
      netPayable: formatMoney(net), revenue: formatMoney(revenue), revenueExcluded: orderCancelled,
      confirmedSupplierCosts: formatMoney(confirmed), draftSupplierCosts: formatMoney(drafts),
      confirmedDirectExpenses: formatMoney(directConfirmed), draftDirectExpenses: formatMoney(directDrafts),
      directProfitBeforeRefunds: formatMoney(revenue - confirmed - directConfirmed),
      includesExpenses: true, includesRefunds: false,
    };
  };

  const coverage = { cancelledSequences: 0, rejectedCreates: 0, rejectedConfirmations: 0, expensesAfterCancellation: 0, reversedExpenses: 0, sharedConfirmed: 0 };

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
    const expenses: ModelExpense[] = [];
    let orderCancelled = false;
    let applied = 0;

    // Operations that actually happened in this sequence (a step with no candidate is skipped and not counted).
    const done: Record<string, number> = {};
    const count = (kind: string) => { done[kind] = (done[kind] ?? 0) + 1; };

    for (let step = 0; step < STEPS; step++) {
      // The order is never cancelled in the first CANCEL_FROM_STEP steps, so every seed first exercises the open-order
      // rules (purchases and expenses) before the cancelled-order rules.
      const pool = [
        'create', 'create', 'confirm', 'confirm', 'cancel', 'reverse', 'cancel-order',
        'create-expense', 'create-expense', 'confirm-expense', 'confirm-expense', 'void-expense', 'reverse-expense',
      ].filter((kind) => kind !== 'cancel-order' || step >= CANCEL_FROM_STEP);
      const operation = purchases.length === 0 ? 'create' : pick(pool);
      if (operation === 'create-expense') {
        // Expenses stay valid on a cancelled order (A38), so this is never rejected.
        const scope = pick(['DIRECT', 'DIRECT', 'SHARED'] as const);
        const amount = money(1 + Math.floor(random() * 20_000));
        const created = await createExpense(app.db, user.tenant, {
          expenseType: scope, ...(scope === 'DIRECT' ? { orderId: order.order.id } : {}),
          categoryType: pick(['SHIPPING', 'ADVERTISING', 'MISCELLANEOUS'] as const), amount: formatMoney(amount), expenseDate: PURCHASE_DATE,
        });
        expenses.push({ id: created.expense.id, scope, state: 'DRAFT', reversed: false, amount });
        count('create-expense');
        if (orderCancelled && scope === 'DIRECT') coverage.expensesAfterCancellation++;
      } else if (operation === 'confirm-expense' || operation === 'void-expense' || operation === 'reverse-expense') {
        const candidates = expenses.filter((e) => (operation === 'reverse-expense' ? e.state === 'CONFIRMED' && !e.reversed : e.state === 'DRAFT'));
        const target = candidates.length > 0 ? pick(candidates) : undefined;
        if (!target) continue;
        if (operation === 'confirm-expense') {
          await confirmExpense(app.db, user.tenant, target.id);
          target.state = 'CONFIRMED';
          count('confirm-expense');
          if (target.scope === 'SHARED') coverage.sharedConfirmed++;
        }
        if (operation === 'void-expense') { await voidExpense(app.db, user.tenant, target.id); target.state = 'VOIDED'; count('void-expense'); }
        if (operation === 'reverse-expense') { await reverseExpense(app.db, user.tenant, target.id, { reason: `model step ${step}` }); target.reversed = true; coverage.reversedExpenses++; count('reverse-expense'); }
      } else if (operation === 'cancel-order') {
        if (!orderCancelled) {
          await changeOrderStatus(app.db, user.tenant, order.order.id, { status: 'CANCELLED' });
          orderCancelled = true;
          count('cancel-order');
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
          count('rejected-create');
        } else {
          const created = await attempt;
          purchases.push({ id: created.purchase.id, state: 'DRAFT', reversed: false, lines });
          count('create');
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
            count('rejected-confirm');
          } else {
            await confirmPurchase(app.db, user.tenant, target.id);
            target.state = 'CONFIRMED';
            count('confirm');
          }
        }
        if (operation === 'cancel') { await cancelDraftPurchase(app.db, user.tenant, target.id); target.state = 'CANCELLED'; count('cancel'); }
        // Confirmed costs of a cancelled order can still be reversed by hand.
        if (operation === 'reverse') { await reversePurchase(app.db, user.tenant, target.id, { reason: `model step ${step}` }); target.reversed = true; count('reverse'); }
      }
      applied++;
      const { profit, order: current } = await getOrderDetail(app.db, user.tenant, order.order.id);
      expect(current.status === 'CANCELLED', `seed ${seed}, step ${step}: order status`).toBe(orderCancelled);
      expect(profit, `seed ${seed}, step ${step}, after ${operation}`).toEqual(expectedProfit(net, purchases, expenses, orderCancelled));
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

    // The expense side of the books: DIRECT_EXPENSE and SHARED_EXPENSE net to the confirmed, unreversed sums of this
    // sequence's expenses, and Expenses Payable mirrors their total exactly. Reversals are recorded as 'adjustment'
    // entries that point at their original, so entries are selected through the original's source.
    const expenseIds = expenses.map((e) => e.id);
    const [expenseBooks] = await raw`
      WITH originals AS (
        SELECT id FROM journal_entries WHERE account_id = ${user.tenant.accountId} AND source_type = 'expense' AND source_id = ANY(${expenseIds}::uuid[])),
      entries AS (
        SELECT e.id FROM journal_entries e WHERE e.account_id = ${user.tenant.accountId} AND e.status = 'FINALIZED'
          AND (e.id IN (SELECT id FROM originals) OR e.reversal_of_entry_id IN (SELECT id FROM originals)))
      SELECT coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE fa.account_role = 'DIRECT_EXPENSE'), 0)::text AS direct_balance,
             coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE fa.account_role = 'SHARED_EXPENSE'), 0)::text AS shared_balance,
             coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE fa.name = 'Expenses Payable'), 0)::text AS payable_balance,
             coalesce(sum(l.debit_amount), 0)::text AS debits, coalesce(sum(l.credit_amount), 0)::text AS credits
      FROM entries JOIN journal_lines l ON l.journal_entry_id = entries.id JOIN financial_accounts fa ON fa.id = l.financial_account_id`;
    const directTotal = confirmedExpenses(expenses, 'DIRECT');
    const sharedTotal = confirmedExpenses(expenses, 'SHARED');
    expect(parseDbMoney(String(expenseBooks?.direct_balance)), `seed ${seed} direct expense balance`).toBe(directTotal);
    expect(parseDbMoney(String(expenseBooks?.shared_balance)), `seed ${seed} shared expense balance`).toBe(sharedTotal);
    expect(parseDbMoney(String(expenseBooks?.payable_balance)), `seed ${seed} expenses payable balance`).toBe(directTotal + sharedTotal);
    expect(parseDbMoney(String(expenseBooks?.debits)), `seed ${seed} expense debits equal credits`).toBe(parseDbMoney(String(expenseBooks?.credits)));
    expect(applied).toBeGreaterThan(3);

    // No seed may silently skip an operation kind: every kind happened at least the minimum number of times.
    for (const [kind, minimum] of Object.entries(MINIMUM_OPERATIONS)) {
      expect(done[kind] ?? 0, `seed ${seed}: ${kind} operations (done: ${JSON.stringify(done)})`).toBeGreaterThanOrEqual(minimum);
    }
    // Rejected attempts on a cancelled order are operations too: they exercise the D9 rules.
    const purchaseOperations = (done.create ?? 0) + (done.confirm ?? 0) + (done.cancel ?? 0) + (done.reverse ?? 0) + (done['rejected-create'] ?? 0) + (done['rejected-confirm'] ?? 0);
    expect(purchaseOperations, `seed ${seed}: purchase operations (done: ${JSON.stringify(done)})`).toBeGreaterThanOrEqual(MINIMUM_PURCHASE_OPERATIONS);
  });

  it('the random sequences exercised the cancelled-order rules (cancellation, rejected creates, rejected confirmations)', () => {
    expect(coverage.cancelledSequences).toBeGreaterThan(0);
    expect(coverage.rejectedCreates + coverage.rejectedConfirmations).toBeGreaterThan(0);
  });

  it('the random sequences exercised expenses: confirmed shared and reversed ones, and direct ones on a cancelled order', () => {
    expect(coverage.sharedConfirmed).toBeGreaterThan(0);
    expect(coverage.reversedExpenses).toBeGreaterThan(0);
    expect(coverage.expensesAfterCancellation).toBeGreaterThan(0);
  });
});
