import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { AppContainer } from '@/server/container';
import { findOrderItemsWithOrders } from '@/server/dal/order-items';
import { lockOrdersForUpdate } from '@/server/dal/orders';
import { tenantScope } from '@/server/dal/tenant-scope';
import { getPostgresErrorCode } from '@/server/db/errors';
import { changeOrderStatus, getOrderDetail, type OrderDetail } from '@/server/orders/service';
import { confirmPurchase, createPurchase, getPurchaseDetail } from '@/server/purchases/service';
import { hasTestDatabase, testDatabaseUrl } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import { auditCount, DEFAULT_PURCHASE_TOTAL, journalEntryCount, makeDraftPurchase, makeOrder, makeSupplier, openRaw, PURCHASE_DATE } from '../support/phase2';

// PRODUCT.md D9: a cancelled order counts zero Etsy revenue, accepts no new
// supplier purchases, and its already-confirmed supplier costs stay (nothing
// is reversed automatically).

const MISSING = '00000000-0000-4000-8000-0000000000dd';
const PG_LOCK_NOT_AVAILABLE = '55P03';

describe.skipIf(!hasTestDatabase)('cancelled orders (D9)', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let user: OnboardedUser;
  let supplierId: string;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    user = await registerAndOnboard(app, 'Cancel Shop', 'cancel');
    supplierId = (await makeSupplier(app, user)).id;
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  const tenantId = () => user.tenant.accountId;
  const cancel = (order: OrderDetail) => changeOrderStatus(app.db, user.tenant, order.order.id, { status: 'CANCELLED' });
  const detail = (order: OrderDetail) => getOrderDetail(app.db, user.tenant, order.order.id);
  const purchaseRoute = (name: 'get' | 'patch' | 'confirm' | 'cancel', id: string, options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {}) =>
    callRoute(routes.purchases[name], apiRequest(app, `/api/v1/purchases/${id}`, { method: options.method ?? 'POST', cookie: user.cookie, body: options.body }), { purchaseId: id });
  const createViaApi = (body: unknown, who: OnboardedUser = user) =>
    routes.purchases.create(apiRequest(app, '/api/v1/purchases', { method: 'POST', cookie: who.cookie, body }));
  const lineFor = (order: OrderDetail, unitCost = '1.00') => ({ orderItemId: order.items[0]?.id ?? '', quantity: 1, unitCost });
  const purchaseCount = async () => Number((await raw`SELECT count(*)::int AS n FROM supplier_purchases WHERE account_id = ${tenantId()}`)[0]?.n);

  describe('cancelled before any purchase', () => {
    it('counts zero revenue, shows the recorded amount, and keeps profit at zero', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      await cancel(order);
      const after = await detail(order);
      expect(after.order.status).toBe('CANCELLED');
      expect(after.profit).toEqual({
        netPayable: '100.00', revenue: '0.00', revenueExcluded: true, confirmedSupplierCosts: '0.00',
        directProfitBeforeExpensesAndRefunds: '0.00', draftSupplierCosts: '0.00', includesExpenses: false, includesRefunds: false,
      });
      const api = await (await callRoute(routes.orders.get, apiRequest(app, `/api/v1/orders/${order.order.id}`, { cookie: user.cookie }), { orderId: order.order.id })).json();
      expect(api.profit).toMatchObject({ revenue: '0.00', revenueExcluded: true });
      const list = await (await routes.orders.list(apiRequest(app, '/api/v1/orders', { cookie: user.cookie, query: '?limit=100' }))).json();
      expect(list.items.find((item: { id: string }) => item.id === order.order.id).profit).toMatchObject({ netPayable: '100.00', revenue: '0.00', directProfitBeforeExpensesAndRefunds: '0.00' });
    });

    it('rejects a new purchase through the API with 422 naming the line, and creates nothing', async () => {
      const order = await makeOrder(app, user);
      await cancel(order);
      const purchases = await purchaseCount();
      const journals = await journalEntryCount(raw, tenantId());
      const audits = await auditCount(raw, tenantId(), 'supplier_purchase', 'CREATE');
      const response = await createViaApi({ supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(order)] });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: 'ORDER_CANCELLED', fields: ['lines.0.orderItemId'] });
      expect(await purchaseCount()).toBe(purchases);
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CREATE')).toBe(audits);
    });

    it('rejects it at the service level too, so no other caller can bypass the API', async () => {
      const order = await makeOrder(app, user);
      await cancel(order);
      await expect(createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(order)] }))
        .rejects.toMatchObject({ kind: 'unprocessable', code: 'ORDER_CANCELLED', fields: ['lines.0.orderItemId'] });
    });

    it('rejects a purchase that mixes an open order and a cancelled one, as a whole', async () => {
      const open = await makeOrder(app, user);
      const cancelled = await makeOrder(app, user);
      await cancel(cancelled);
      const purchases = await purchaseCount();
      const response = await createViaApi({ supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(open), lineFor(cancelled)] });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: 'ORDER_CANCELLED', fields: ['lines.1.orderItemId'] });
      expect(await purchaseCount()).toBe(purchases);
    });

    it('rejects editing a draft to add a cancelled order’s line, leaving the draft unchanged', async () => {
      const open = await makeOrder(app, user);
      const cancelled = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, open);
      await cancel(cancelled);
      const response = await purchaseRoute('patch', draft.purchase.id, {
        method: 'PATCH', body: { lines: [lineFor(open), lineFor(cancelled)] },
      });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: 'ORDER_CANCELLED', fields: ['lines.1.orderItemId'] });
      const unchanged = await getPurchaseDetail(app.db, user.tenant, draft.purchase.id);
      expect(unchanged.purchase.totalAmount).toBe(DEFAULT_PURCHASE_TOTAL);
      expect(unchanged.lines).toHaveLength(2);
    });

    it('does not reveal that another tenant’s order is cancelled', async () => {
      const other = await registerAndOnboard(app, 'Other Cancel Shop', 'cancel-other');
      const foreign = await makeOrder(app, other);
      await changeOrderStatus(app.db, other.tenant, foreign.order.id, { status: 'CANCELLED' });
      const body = (itemId: string) => ({ supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: itemId, quantity: 1, unitCost: '1.00' }] });
      const foreignResponse = await createViaApi(body(foreign.items[0]?.id ?? ''));
      const missingResponse = await createViaApi(body(MISSING));
      expect(foreignResponse.status).toBe(422);
      expect(await foreignResponse.json()).toEqual(await missingResponse.json());
    });

    it('data layer: order status is reported only for the session tenant, and locking another tenant’s order returns nothing', async () => {
      const own = await makeOrder(app, user);
      await cancel(own);
      const other = await registerAndOnboard(app, 'Third Cancel Shop', 'cancel-third');
      const foreign = await makeOrder(app, other);
      const scope = tenantScope(app.db, user.tenant);
      const items = await findOrderItemsWithOrders(scope, [own.items[0]?.id ?? '', foreign.items[0]?.id ?? '']);
      expect(items.map((item) => [item.id, item.orderStatus])).toEqual([[own.items[0]?.id, 'CANCELLED']]);
      expect(await lockOrdersForUpdate(scope, [foreign.order.id])).toEqual([]);
      expect((await lockOrdersForUpdate(scope, [own.order.id])).map((row) => row.status)).toEqual(['CANCELLED']);
    });
  });

  describe('cancelled while a draft purchase exists (before confirmation)', () => {
    it('refuses to confirm: 409, the draft stays a draft, nothing posts, the order stays cancelled', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await cancel(order);
      const journals = await journalEntryCount(raw, tenantId());

      const response = await purchaseRoute('confirm', draft.purchase.id);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('ORDER_CANCELLED');
      const [row] = await raw`SELECT status, confirmed_at FROM supplier_purchases WHERE id = ${draft.purchase.id}`;
      expect(row).toMatchObject({ status: 'DRAFT', confirmed_at: null });
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CONFIRM', draft.purchase.id)).toBe(0);
      const after = await detail(order);
      expect(after.order.status).toBe('CANCELLED');
      expect(after.profit).toMatchObject({ revenue: '0.00', confirmedSupplierCosts: '0.00', directProfitBeforeExpensesAndRefunds: '0.00', draftSupplierCosts: DEFAULT_PURCHASE_TOTAL });
    });

    it('tells the UI why: canConfirm is false and the reason is given; the draft can still be cancelled', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      expect(draft).toMatchObject({ canConfirm: true, confirmBlockedReason: null });
      await cancel(order);
      const blocked = await (await purchaseRoute('get', draft.purchase.id, { method: 'GET' })).json();
      expect(blocked).toMatchObject({ canConfirm: false, confirmBlockedReason: 'ORDER_CANCELLED', canCancel: true, canEdit: true });
      const cancelled = await (await purchaseRoute('cancel', draft.purchase.id)).json();
      expect(cancelled.purchase.effectiveStatus).toBe('CANCELLED');
      expect(cancelled.confirmBlockedReason).toBeNull();
    });

    it('can be repaired: re-pointing the draft at an open order makes it confirmable again', async () => {
      const cancelled = await makeOrder(app, user);
      const open = await makeOrder(app, user, { netPayableAmount: '60.00' });
      const draft = await makeDraftPurchase(app, user, supplierId, cancelled);
      await cancel(cancelled);
      const repaired = await purchaseRoute('patch', draft.purchase.id, { method: 'PATCH', body: { lines: [lineFor(open, '4.00')] } });
      expect(repaired.status).toBe(200);
      expect(await repaired.json()).toMatchObject({ canConfirm: true, confirmBlockedReason: null });
      const confirmed = await purchaseRoute('confirm', draft.purchase.id);
      expect(confirmed.status).toBe(200);
      expect((await detail(open)).profit).toMatchObject({ confirmedSupplierCosts: '4.00', directProfitBeforeExpensesAndRefunds: '56.00' });
      expect((await detail(cancelled)).profit.confirmedSupplierCosts).toBe('0.00');
    });
  });

  describe('cancelled after the purchase was confirmed', () => {
    it('keeps the confirmed cost and the posting, counts no revenue, and reverses nothing', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await purchaseRoute('confirm', draft.purchase.id);
      expect((await detail(order)).profit.directProfitBeforeExpensesAndRefunds).toBe('74.75');
      const journals = await journalEntryCount(raw, tenantId());

      await cancel(order);

      const after = await detail(order);
      expect(after.order.status).toBe('CANCELLED');
      expect(after.profit).toMatchObject({
        netPayable: '100.00', revenue: '0.00', revenueExcluded: true,
        confirmedSupplierCosts: DEFAULT_PURCHASE_TOTAL, directProfitBeforeExpensesAndRefunds: '-25.25',
      });
      expect(after.purchases).toEqual([expect.objectContaining({ effectiveStatus: 'CONFIRMED', orderTotal: DEFAULT_PURCHASE_TOTAL })]);
      // Nothing was erased or reversed: the same single posting, no reversal, no REVERSE audit.
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await raw`SELECT 1 FROM journal_entries WHERE account_id = ${tenantId()} AND reversal_of_entry_id IS NOT NULL AND source_id IN (SELECT id FROM journal_entries WHERE source_id = ${draft.purchase.id})`).toHaveLength(0);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'REVERSE', draft.purchase.id)).toBe(0);
      const purchase = await getPurchaseDetail(app.db, user.tenant, draft.purchase.id);
      expect(purchase.purchase).toMatchObject({ status: 'CONFIRMED', effectiveStatus: 'CONFIRMED' });
    });

    it('confirming again after the cancellation is a harmless no-op, not an error', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await purchaseRoute('confirm', draft.purchase.id);
      await cancel(order);
      const repeat = await purchaseRoute('confirm', draft.purchase.id);
      expect(repeat.status).toBe(200);
      expect((await repeat.json()).alreadyConfirmed).toBe(true);
    });

    it('a manual reversal afterwards still works and brings the loss back to zero', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await purchaseRoute('confirm', draft.purchase.id);
      await cancel(order);
      const reversal = await callRoute(routes.purchases.reverse, apiRequest(app, `/api/v1/purchases/${draft.purchase.id}/reverse`, {
        method: 'POST', cookie: user.cookie, body: { reason: 'Order cancelled, supplier refunded us' },
      }), { purchaseId: draft.purchase.id });
      expect(reversal.status).toBe(200);
      expect((await detail(order)).profit).toMatchObject({ confirmedSupplierCosts: '0.00', directProfitBeforeExpensesAndRefunds: '0.00' });
    });

    it('cancelling one order leaves a purchase that spans two orders confirmed, and the other order unaffected, to the cent', async () => {
      const orderA = await makeOrder(app, user, { netPayableAmount: '50.00', items: [{ productName: 'A1', quantity: 1 }] });
      const orderB = await makeOrder(app, user, { netPayableAmount: '50.00', items: [{ productName: 'B1', quantity: 1 }] });
      const spanning = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(orderA, '12.34'), lineFor(orderB, '0.10')],
      });
      await confirmPurchase(app.db, user.tenant, spanning.purchase.id);
      await cancel(orderA);
      expect((await detail(orderA)).profit).toMatchObject({ revenue: '0.00', confirmedSupplierCosts: '12.34', directProfitBeforeExpensesAndRefunds: '-12.34' });
      expect((await detail(orderB)).profit).toMatchObject({ revenue: '50.00', confirmedSupplierCosts: '0.10', directProfitBeforeExpensesAndRefunds: '49.90' });
      expect((await getPurchaseDetail(app.db, user.tenant, spanning.purchase.id)).purchase.effectiveStatus).toBe('CONFIRMED');
    });

    it('is exact with fractional cents: net 0.30 cancelled with costs 0.10 + 0.10 shows -0.20', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '0.30', items: [{ productName: 'Pen', quantity: 2 }] });
      const item = order.items[0]?.id ?? '';
      const purchase = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: item, quantity: 1, unitCost: '0.10' }, { orderItemId: item, quantity: 1, unitCost: '0.10' }],
      });
      await confirmPurchase(app.db, user.tenant, purchase.purchase.id);
      await cancel(order);
      expect((await detail(order)).profit).toMatchObject({ confirmedSupplierCosts: '0.20', directProfitBeforeExpensesAndRefunds: '-0.20' });
    });
  });

  describe('locking: the order is locked before the first write (ARCHITECTURE.md A35)', () => {
    async function waitForLockWait(): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await raw`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
        if ((row?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the operation never waited on the held order lock');
    }

    /** True when nobody holds the tenant row lock, which every financial write takes. */
    async function tenantLockIsFree(): Promise<boolean> {
      try {
        await raw`SELECT id FROM business_accounts WHERE id = ${tenantId()} FOR UPDATE NOWAIT`;
        return true;
      } catch (error) {
        if (getPostgresErrorCode(error) === PG_LOCK_NOT_AVAILABLE) return false;
        throw error;
      }
    }

    // Hold the order row lock as a concurrent status change would, start the operation, and check that the waiting
    // operation holds no tenant lock. With the old order (write first, lock orders afterwards) this failed, and
    // the two operations could deadlock against an order status change.
    it.each([
      ['confirmPurchase', async (order: OrderDetail) => {
        const draft = await makeDraftPurchase(app, user, supplierId, order);
        return () => confirmPurchase(app.db, user.tenant, draft.purchase.id);
      }],
      ['createPurchase', async (order: OrderDetail) => () => createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(order)] })],
    ] as const)('%s waits for the order lock without holding the tenant lock', async (_name, prepare) => {
      const order = await makeOrder(app, user);
      const start = await prepare(order);
      const holder = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM orders WHERE id = ${order.order.id} FOR UPDATE`;
        const pending = start();
        await waitForLockWait();
        expect(await tenantLockIsFree()).toBe(true);
        await holder`ROLLBACK`;
        await expect(pending).resolves.toBeDefined();
      } finally {
        await holder.end();
      }
    });

    it('confirming while the same order is being cancelled never deadlocks, and every outcome is consistent', async () => {
      const deadlocks = async () => Number((await raw`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)[0]?.deadlocks);
      const before = await deadlocks();
      const outcomes = { confirmedThenCancelled: 0, cancelledFirst: 0 };
      for (let round = 0; round < 40; round++) {
        const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
        const draft = await makeDraftPurchase(app, user, supplierId, order);
        const [confirmResult, cancelResult] = await Promise.allSettled([
          confirmPurchase(app.db, user.tenant, draft.purchase.id),
          changeOrderStatus(app.db, user.tenant, order.order.id, { status: 'CANCELLED' }),
        ]);
        expect(cancelResult.status, `round ${round}: the cancellation always succeeds`).toBe('fulfilled');
        const profit = (await detail(order)).profit;
        const journals = Number((await raw`SELECT count(*)::int AS n FROM journal_entries WHERE account_id = ${tenantId()} AND source_type = 'supplier_purchase' AND source_id = ${draft.purchase.id}`)[0]?.n);
        if (confirmResult.status === 'fulfilled') {
          outcomes.confirmedThenCancelled++;
          expect(journals, `round ${round}`).toBe(1);
          expect(profit, `round ${round}`).toMatchObject({ revenue: '0.00', confirmedSupplierCosts: DEFAULT_PURCHASE_TOTAL, directProfitBeforeExpensesAndRefunds: '-25.25' });
        } else {
          outcomes.cancelledFirst++;
          expect(confirmResult.reason, `round ${round}`).toMatchObject({ code: 'ORDER_CANCELLED' });
          expect(journals, `round ${round}`).toBe(0);
          expect(profit, `round ${round}`).toMatchObject({ revenue: '0.00', confirmedSupplierCosts: '0.00', directProfitBeforeExpensesAndRefunds: '0.00' });
        }
      }
      expect(outcomes.confirmedThenCancelled + outcomes.cancelledFirst).toBe(40);
      expect(await deadlocks() - before, `outcomes ${JSON.stringify(outcomes)}`).toBe(0);
    });
  });
});
