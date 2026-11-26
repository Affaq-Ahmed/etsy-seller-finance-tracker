import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import type { AppContainer } from '@/server/container';
import type { OrderDetail } from '@/server/orders/service';
import { confirmPurchase, confirmPurchaseInTransaction, createPurchase, reversePurchase, updateDraftPurchase } from '@/server/purchases/service';
import { getOrderDetail } from '@/server/orders/service';
import { NO_STORE } from '@/server/http/responses';
import { hasTestDatabase, testDatabaseUrl } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import {
  auditCount, DEFAULT_PURCHASE_TOTAL, journalEntryCount, makeDraftPurchase, makeOrder, makeSupplier, openRaw, PURCHASE_DATE,
} from '../support/phase2';

describe.skipIf(!hasTestDatabase)('supplier purchases', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let user: OnboardedUser;
  let supplierId: string;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    user = await registerAndOnboard(app, 'Purchases Shop', 'purchases');
    supplierId = (await makeSupplier(app, user)).id;
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  const tenantId = () => user.tenant.accountId;
  const purchaseRoute = (name: 'get' | 'patch' | 'confirm' | 'cancel' | 'reverse', id: string, options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {}) =>
    callRoute(routes.purchases[name], apiRequest(app, `/api/v1/purchases/${id}`, { method: options.method ?? 'POST', cookie: user.cookie, body: options.body }), { purchaseId: id });
  const confirmViaApi = (id: string) => purchaseRoute('confirm', id);
  const orderDetail = (order: OrderDetail) => getOrderDetail(app.db, user.tenant, order.order.id);
  const journalOf = async (purchaseId: string) =>
    raw`SELECT * FROM journal_entries WHERE account_id = ${tenantId()} AND source_type = 'supplier_purchase' AND source_id = ${purchaseId}`;
  const linesOf = async (journalId: string) =>
    raw`SELECT fa.name, fa.account_role, fa.account_type, l.debit_amount::text AS debit, l.credit_amount::text AS credit
        FROM journal_lines l JOIN financial_accounts fa ON fa.id = l.financial_account_id WHERE l.journal_entry_id = ${journalId} ORDER BY l.debit_amount DESC`;

  describe('draft purchases post nothing', () => {
    it('creates a DRAFT through the API with an exact total and no ledger effect', async () => {
      const order = await makeOrder(app, user);
      const [first, second] = order.items;
      const before = await journalEntryCount(raw, tenantId());
      const response = await routes.purchases.create(apiRequest(app, '/api/v1/purchases', {
        method: 'POST', cookie: user.cookie,
        body: {
          supplierId, supplierOrderReference: `EB-${Date.now()}`, purchaseUrl: 'https://www.ebay.com/itm/123456789', purchaseDate: PURCHASE_DATE,
          notes: 'Bought on sale',
          lines: [{ orderItemId: first?.id, quantity: 2, unitCost: '10.10' }, { orderItemId: second?.id, quantity: 1, unitCost: '5.05' }],
        },
      }));
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      const body = await response.json();
      expect(body.purchase).toMatchObject({
        status: 'DRAFT', effectiveStatus: 'DRAFT', totalAmount: DEFAULT_PURCHASE_TOTAL, currency: 'USD',
        purchaseDate: PURCHASE_DATE, confirmedAt: null, supplierName: 'Test Supplier',
      });
      expect(body.lines.map((line: { quantity: number; unitCost: string; totalCost: string }) => [line.quantity, line.unitCost, line.totalCost]))
        .toEqual([[2, '10.10', '20.20'], [1, '5.05', '5.05']]);
      expect(body).toMatchObject({ canConfirm: true, canEdit: true, canCancel: true, canReverse: false });
      expect(await journalEntryCount(raw, tenantId())).toBe(before);
    });

    it('keeps a draft out of profit: shown separately, never counted', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      await makeDraftPurchase(app, user, supplierId, order);
      const { profit } = await orderDetail(order);
      expect(profit).toMatchObject({ confirmedSupplierCosts: '0.00', draftSupplierCosts: DEFAULT_PURCHASE_TOTAL, directProfitBeforeExpensesAndRefunds: '100.00' });
    });

    it('editing and cancelling a draft post nothing and change no profit', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      const before = await journalEntryCount(raw, tenantId());
      const edited = await purchaseRoute('patch', draft.purchase.id, {
        method: 'PATCH', body: { notes: 'edited', lines: [{ orderItemId: order.items[0]?.id, quantity: 1, unitCost: '3.00' }] },
      });
      expect(edited.status).toBe(200);
      expect((await edited.json()).purchase.totalAmount).toBe('3.00');
      const cancelled = await purchaseRoute('cancel', draft.purchase.id);
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()).purchase).toMatchObject({ status: 'CANCELLED', effectiveStatus: 'CANCELLED' });
      expect(await journalEntryCount(raw, tenantId())).toBe(before);
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedSupplierCosts: '0.00', draftSupplierCosts: '0.00' });
      expect((await purchaseRoute('cancel', draft.purchase.id)).status).toBe(200);
    });
  });

  describe('exact money (no rounding, no floats)', () => {
    it('sums 0.10 + 0.20 to exactly 0.30', async () => {
      const order = await makeOrder(app, user, { items: [{ productName: 'Pen', quantity: 2 }] });
      const item = order.items[0];
      const draft = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE,
        lines: [{ orderItemId: item?.id ?? '', quantity: 1, unitCost: '0.10' }, { orderItemId: item?.id ?? '', quantity: 1, unitCost: '0.20' }],
      });
      expect(draft.purchase.totalAmount).toBe('0.30');
      const [row] = await raw`SELECT total_amount::text AS total FROM supplier_purchases WHERE id = ${draft.purchase.id}`;
      expect(row?.total).toBe('0.3000');
    });

    it('records an uneven total as several lines: 10.00 for 3 units = 1 x 3.34 + 2 x 3.33', async () => {
      const order = await makeOrder(app, user, { items: [{ productName: 'Trio', quantity: 3 }] });
      const item = order.items[0]?.id ?? '';
      const draft = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE,
        lines: [{ orderItemId: item, quantity: 1, unitCost: '3.34' }, { orderItemId: item, quantity: 2, unitCost: '3.33' }],
      });
      expect(draft.purchase.totalAmount).toBe('10.00');
      expect(draft.lines.map((line) => line.totalCost)).toEqual(['3.34', '6.66']);
    });

    it('stores each line total as exactly quantity x unit cost', async () => {
      const order = await makeOrder(app, user, { items: [{ productName: 'Bulk', quantity: 99_999 }] });
      const draft = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id ?? '', quantity: 99_999, unitCost: '12345.67' }],
      });
      expect(draft.lines[0]?.totalCost).toBe('1234554654.33');
      const rows = await raw`SELECT (quantity * unit_cost = total_cost) AS exact FROM supplier_purchase_items WHERE supplier_purchase_id = ${draft.purchase.id}`;
      expect(rows.every((row) => row.exact === true)).toBe(true);
    });

    it.each([
      ['three decimal places', '3.333'],
      ['a negative amount', '-1.00'],
      ['exponent notation', '1e3'],
      ['a thousands separator', '1,000.00'],
      ['an empty string', ''],
      ['more than 12 integer digits', '1000000000000.00'],
    ])('rejects a unit cost with %s', async (_label, unitCost) => {
      const order = await makeOrder(app, user);
      const response = await routes.purchases.create(apiRequest(app, '/api/v1/purchases', {
        method: 'POST', cookie: user.cookie,
        body: { supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id, quantity: 1, unitCost }] },
      }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.fields).toEqual(['lines.0.unitCost']);
    });

    it('rejects a JSON number for an amount and a line total above the limit', async () => {
      const order = await makeOrder(app, user);
      const itemId = order.items[0]?.id;
      const asNumber = await routes.purchases.create(apiRequest(app, '/api/v1/purchases', {
        method: 'POST', cookie: user.cookie, body: { supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: itemId, quantity: 1, unitCost: 10.1 }] },
      }));
      expect(asNumber.status).toBe(400);
      const huge = await routes.purchases.create(apiRequest(app, '/api/v1/purchases', {
        method: 'POST', cookie: user.cookie, body: { supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: itemId, quantity: 100_000, unitCost: '999999999999.99' }] },
      }));
      expect(huge.status).toBe(422);
      expect((await huge.json()).error.code).toBe('AMOUNT_TOO_LARGE');
    });
  });

  describe('creation rules', () => {
    it('rejects unknown suppliers and order items, and bad free text', async () => {
      const order = await makeOrder(app, user);
      const itemId = order.items[0]?.id;
      const create = (body: Record<string, unknown>) => routes.purchases.create(apiRequest(app, '/api/v1/purchases', {
        method: 'POST', cookie: user.cookie, body: { supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: itemId, quantity: 1, unitCost: '1.00' }], ...body },
      }));
      const noSupplier = await create({ supplierId: '00000000-0000-4000-8000-000000000001' });
      expect([noSupplier.status, (await noSupplier.json()).error.code]).toEqual([422, 'SUPPLIER_NOT_FOUND']);
      const noItem = await create({ lines: [{ orderItemId: '00000000-0000-4000-8000-000000000002', quantity: 1, unitCost: '1.00' }] });
      const noItemBody = await noItem.json();
      expect([noItem.status, noItemBody.error.code, noItemBody.error.fields]).toEqual([422, 'ORDER_ITEM_NOT_FOUND', ['lines.0.orderItemId']]);
      expect((await create({ notes: 'refund to jane@example.com' })).status).toBe(400);
      for (const purchaseUrl of ['ftp://x.example/a', 'javascript:alert(1)', 'https://user:pw@x.example/', 'https://x.example/?e=a@b.com', `https://x.example/${'a'.repeat(2050)}`]) {
        const response = await create({ purchaseUrl });
        expect([response.status, (await response.json()).error.fields], purchaseUrl.slice(0, 40)).toEqual([400, ['purchaseUrl']]);
      }
      expect((await create({ purchaseUrl: 'https://www.aliexpress.com/item/1005001.html', currency: 'USD' })).status).toBe(201);
      expect((await create({ buyerName: 'x' })).status).toBe(400);
    });

    it('rejects a currency that is not the business currency', async () => {
      const order = await makeOrder(app, user);
      await expect(createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, currency: 'PKR', lines: [{ orderItemId: order.items[0]?.id ?? '', quantity: 1, unitCost: '1.00' }],
      })).rejects.toMatchObject({ code: 'CURRENCY_NOT_SUPPORTED' });
    });

    it('rejects lines on an order in another currency', async () => {
      const orderId = crypto.randomUUID();
      const itemId = crypto.randomUUID();
      await raw`INSERT INTO orders(id, account_id, etsy_order_id, order_date, net_payable_amount, currency) VALUES (${orderId}, ${tenantId()}, ${`PKR-${orderId}`}, now(), 5000, 'PKR')`;
      await raw`INSERT INTO order_items(id, account_id, order_id, product_name_snapshot, quantity) VALUES (${itemId}, ${tenantId()}, ${orderId}, 'Legacy', 1)`;
      await expect(createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: itemId, quantity: 1, unitCost: '1.00' }],
      })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', fields: ['lines.0.orderItemId'] });
    });

    it('enforces unique supplier references per supplier, allowing blanks and other suppliers', async () => {
      const order = await makeOrder(app, user);
      const reference = `REF-${Date.now()}`;
      await makeDraftPurchase(app, user, supplierId, order, { supplierOrderReference: reference });
      const duplicate = await makeDraftPurchase(app, user, supplierId, order, { supplierOrderReference: reference }).then(() => null, (error: unknown) => error);
      expect(duplicate).toMatchObject({ code: 'DUPLICATE_SUPPLIER_REFERENCE', fields: ['supplierOrderReference'] });
      const other = await makeSupplier(app, user, { name: 'Second supplier', marketplace: 'AMAZON' });
      await expect(makeDraftPurchase(app, user, other.id, order, { supplierOrderReference: reference })).resolves.toBeDefined();
      await expect(makeDraftPurchase(app, user, supplierId, order)).resolves.toBeDefined();
      await expect(makeDraftPurchase(app, user, supplierId, order)).resolves.toBeDefined();
    });

    it('warns, without blocking, when more units are bought than ordered', async () => {
      const order = await makeOrder(app, user, { items: [{ productName: 'Mug', quantity: 2 }] });
      const draft = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id ?? '', quantity: 3, unitCost: '1.00' }],
      });
      expect(draft.warnings).toEqual([expect.objectContaining({ code: 'QUANTITY_EXCEEDS_ORDERED', orderedQuantity: 2, purchasedQuantity: 3 })]);
      const cancelled = await (await purchaseRoute('cancel', draft.purchase.id)).json();
      expect(cancelled.warnings).toEqual([]);
    });

    it('locks order items once a purchase line references them', async () => {
      const order = await makeOrder(app, user);
      await makeDraftPurchase(app, user, supplierId, order);
      const detail = await orderDetail(order);
      expect(detail.items.every((item) => item.locked)).toBe(true);
      expect(detail.purchases).toEqual([expect.objectContaining({ orderTotal: DEFAULT_PURCHASE_TOTAL, effectiveStatus: 'DRAFT' })]);
      const response = await callRoute(routes.orders.patch, apiRequest(app, `/api/v1/orders/${order.order.id}`, {
        method: 'PATCH', cookie: user.cookie, body: { items: [{ productName: 'New', quantity: 1 }] },
      }), { orderId: order.order.id });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('ORDER_ITEMS_LOCKED');
      // The header stays editable.
      const header = await callRoute(routes.orders.patch, apiRequest(app, `/api/v1/orders/${order.order.id}`, {
        method: 'PATCH', cookie: user.cookie, body: { netPayableAmount: '110.00' },
      }), { orderId: order.order.id });
      expect(header.status).toBe(200);
    });
  });

  describe('confirmation posts the cost exactly once', () => {
    it('posts DEBIT supplier cost / CREDIT Supplier Payable for the exact total, dated at the purchase date', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      const response = await confirmViaApi(draft.purchase.id);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      const body = await response.json();
      expect(body.alreadyConfirmed).toBe(false);
      expect(body.purchase).toMatchObject({ status: 'CONFIRMED', effectiveStatus: 'CONFIRMED' });
      expect(body.purchase.confirmedAt).not.toBeNull();
      expect(body).toMatchObject({ canConfirm: false, canEdit: false, canCancel: false, canReverse: true });

      const entries = await journalOf(draft.purchase.id);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry).toMatchObject({
        source_event: 'INITIAL', status: 'FINALIZED', currency: 'USD', idempotency_key: `supplier_purchase:${draft.purchase.id}:INITIAL`,
      });
      const [purchaseRow] = await raw`SELECT purchase_date FROM supplier_purchases WHERE id = ${draft.purchase.id}`;
      expect((entry?.transaction_date as Date).toISOString()).toBe((purchaseRow?.purchase_date as Date).toISOString());

      expect(await linesOf(entry?.id as string)).toEqual([
        { name: 'Supplier Costs', account_role: 'SUPPLIER_COST', account_type: 'EXPENSE', debit: '25.2500', credit: '0.0000' },
        { name: 'Supplier Payable', account_role: 'UNCLASSIFIED', account_type: 'LIABILITY', debit: '0.0000', credit: '25.2500' },
      ]);
      // Payoneer is not credited: Phase 3 settles the payable, so the payment is never counted twice.
      const lines = await raw`SELECT count(*)::int AS n FROM journal_lines l JOIN financial_accounts fa ON fa.id = l.financial_account_id WHERE l.journal_entry_id = ${entry?.id} AND fa.account_role = 'PAYONEER'`;
      expect(lines[0]?.n).toBe(0);
    });

    it('counts the confirmed cost in profit and moves a NEW order to SUPPLIER_ORDERED', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      expect(order.order.status).toBe('NEW');
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      const detail = await orderDetail(order);
      expect(detail.order.status).toBe('SUPPLIER_ORDERED');
      expect(detail.profit).toMatchObject({ confirmedSupplierCosts: DEFAULT_PURCHASE_TOTAL, directProfitBeforeExpensesAndRefunds: '74.75', draftSupplierCosts: '0.00' });
      expect(await auditCount(raw, tenantId(), 'order', 'STATUS_CHANGE', order.order.id)).toBe(1);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CONFIRM', draft.purchase.id)).toBe(1);
    });

    it('does not move an order that is already past NEW', async () => {
      const order = await makeOrder(app, user);
      for (const status of ['SUPPLIER_ORDERED', 'SHIPPED']) {
        await callRoute(routes.orders.status, apiRequest(app, `/api/v1/orders/${order.order.id}/status`, { method: 'POST', cookie: user.cookie, body: { status } }), { orderId: order.order.id });
      }
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      expect((await orderDetail(order)).order.status).toBe('SHIPPED');
    });

    it('is idempotent: repeating the confirmation returns the same posting and writes nothing', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      const first = await (await confirmViaApi(draft.purchase.id)).json();
      const second = await (await confirmViaApi(draft.purchase.id)).json();
      expect([first.alreadyConfirmed, second.alreadyConfirmed]).toEqual([false, true]);
      expect(second.purchase.confirmedAt).toBe(first.purchase.confirmedAt);
      expect(await journalOf(draft.purchase.id)).toHaveLength(1);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CONFIRM', draft.purchase.id)).toBe(1);
    });

    it('refuses to confirm a cancelled draft, a zero-cost draft and unknown purchases', async () => {
      const order = await makeOrder(app, user);
      const cancelled = await makeDraftPurchase(app, user, supplierId, order);
      await purchaseRoute('cancel', cancelled.purchase.id);
      const response = await confirmViaApi(cancelled.purchase.id);
      expect([response.status, (await response.json()).error.code]).toEqual([409, 'PURCHASE_NOT_CONFIRMABLE']);

      const free = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id ?? '', quantity: 1, unitCost: '0.00' }],
      });
      const zero = await confirmViaApi(free.purchase.id);
      expect([zero.status, (await zero.json()).error.code]).toEqual([422, 'PURCHASE_TOTAL_REQUIRED']);
      expect(await journalOf(free.purchase.id)).toHaveLength(0);

      expect((await confirmViaApi('00000000-0000-4000-8000-000000000003')).status).toBe(404);
    });

    it('rejects a draft whose stored total disagrees with its lines, and leaves it a draft', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await raw`UPDATE supplier_purchases SET total_amount = 99 WHERE id = ${draft.purchase.id}`;
      const response = await confirmViaApi(draft.purchase.id);
      expect([response.status, (await response.json()).error.code]).toEqual([409, 'PURCHASE_TOTAL_MISMATCH']);
      expect(await journalOf(draft.purchase.id)).toHaveLength(0);
    });
  });

  describe('concurrency', () => {
    it('parallel confirmations create exactly one posting and every caller succeeds', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      const results = await Promise.all(Array.from({ length: 8 }, () => confirmPurchase(app.db, user.tenant, draft.purchase.id)));
      expect(results.filter((result) => !result.alreadyConfirmed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.journalEntryId)).size).toBe(1);
      expect(await journalOf(draft.purchase.id)).toHaveLength(1);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CONFIRM', draft.purchase.id)).toBe(1);
      expect(await auditCount(raw, tenantId(), 'order', 'STATUS_CHANGE', order.order.id)).toBe(1);
    });

    it('parallel confirmations of purchases that share orders neither deadlock nor double count', async () => {
      const first = await makeOrder(app, user);
      const second = await makeOrder(app, user);
      const lineFor = (order: OrderDetail) => ({ orderItemId: order.items[0]?.id ?? '', quantity: 1, unitCost: '2.00' });
      const purchases = await Promise.all([
        createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(first), lineFor(second)] }),
        createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: [lineFor(second), lineFor(first)] }),
      ]);
      await Promise.all(purchases.map((purchase) => confirmPurchase(app.db, user.tenant, purchase.purchase.id)));
      for (const order of [first, second]) {
        const detail = await orderDetail(order);
        expect(detail.profit.confirmedSupplierCosts).toBe('4.00');
        expect(detail.order.status).toBe('SUPPLIER_ORDERED');
      }
    });

    async function waitForLockWait(): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await raw`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
        if ((row?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the second confirmation never waited on the first transaction');
    }

    it.each([
      ['COMMIT', true],
      ['ROLLBACK', false],
    ] as const)('an overlapping confirmation waits for the first transaction (%s)', async (outcome, secondIsAlreadyConfirmed) => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      const firstWriter = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await firstWriter`BEGIN`;
        const first = await confirmPurchaseInTransaction(drizzle(firstWriter, { schema }), user.tenant, draft.purchase.id);
        expect(first.alreadyConfirmed).toBe(false);

        const second = confirmPurchase(app.db, user.tenant, draft.purchase.id);
        await waitForLockWait();
        await (outcome === 'COMMIT' ? firstWriter`COMMIT` : firstWriter`ROLLBACK`);

        const result = await second;
        expect(result.alreadyConfirmed).toBe(secondIsAlreadyConfirmed);
        expect(await journalOf(draft.purchase.id)).toHaveLength(1);
        expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CONFIRM', draft.purchase.id)).toBe(1);
      } finally {
        await firstWriter.end();
      }
    });
  });

  describe('atomic rollback', () => {
    it('a posting failure leaves the purchase a draft with no journal, audit or order change, and a retry works', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      // Occupy the idempotency key so the posting insert fails after the status update.
      const blockerId = crypto.randomUUID();
      await raw`INSERT INTO journal_entries(id, account_id, source_type, source_id, source_event, currency, transaction_date, idempotency_key)
        VALUES (${blockerId}, ${tenantId()}, 'adjustment', ${crypto.randomUUID()}, 'MANUAL', 'USD', now(), ${`supplier_purchase:${draft.purchase.id}:INITIAL`})`;

      const failed = await confirmViaApi(draft.purchase.id);
      expect(failed.status).toBe(409);
      expect((await failed.json()).error.code).toBe('CONFLICT');

      const [row] = await raw`SELECT status, confirmed_at FROM supplier_purchases WHERE id = ${draft.purchase.id}`;
      expect(row).toMatchObject({ status: 'DRAFT', confirmed_at: null });
      expect(await journalOf(draft.purchase.id)).toHaveLength(0);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'CONFIRM', draft.purchase.id)).toBe(0);
      expect((await orderDetail(order)).order.status).toBe('NEW');
      expect((await orderDetail(order)).profit.confirmedSupplierCosts).toBe('0.00');

      await raw`DELETE FROM journal_entries WHERE id = ${blockerId}`;
      const retry = await confirmViaApi(draft.purchase.id);
      expect(retry.status).toBe(200);
      expect((await retry.json()).alreadyConfirmed).toBe(false);
      expect(await journalOf(draft.purchase.id)).toHaveLength(1);
    });

    it('fails closed, changing nothing, when the cost account is missing, inactive or ambiguous', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      const expectUnavailable = async () => {
        const response = await confirmViaApi(draft.purchase.id);
        expect([response.status, (await response.json()).error.code]).toEqual([422, 'LEDGER_ACCOUNT_UNAVAILABLE']);
        expect((await raw`SELECT status FROM supplier_purchases WHERE id = ${draft.purchase.id}`)[0]?.status).toBe('DRAFT');
        expect(await journalOf(draft.purchase.id)).toHaveLength(0);
      };

      await raw`UPDATE financial_accounts SET is_active = false WHERE account_id = ${tenantId()} AND account_role = 'SUPPLIER_COST'`;
      await expectUnavailable();
      await raw`UPDATE financial_accounts SET is_active = true WHERE account_id = ${tenantId()} AND account_role = 'SUPPLIER_COST'`;

      await raw`INSERT INTO financial_accounts(account_id, name, account_type, account_role, currency) VALUES (${tenantId()}, 'Second supplier costs', 'EXPENSE', 'SUPPLIER_COST', 'USD')`;
      await expectUnavailable();
      await raw`DELETE FROM financial_accounts WHERE account_id = ${tenantId()} AND name = 'Second supplier costs'`;

      expect((await confirmViaApi(draft.purchase.id)).status).toBe(200);
    });

    it('creates a missing Supplier Payable account, once, inside the confirmation (businesses onboarded earlier)', async () => {
      const older = await registerAndOnboard(app, 'Older Shop', 'purchases-older');
      await raw`DELETE FROM financial_accounts WHERE account_id = ${older.tenant.accountId} AND name = 'Supplier Payable'`;
      const supplier = await makeSupplier(app, older);
      const order = await makeOrder(app, older);
      const [first, second] = await Promise.all([
        makeDraftPurchase(app, older, supplier.id, order),
        makeDraftPurchase(app, older, supplier.id, order),
      ]);
      await Promise.all([confirmPurchase(app.db, older.tenant, first.purchase.id), confirmPurchase(app.db, older.tenant, second.purchase.id)]);
      const accounts = await raw`SELECT account_type, account_role, currency FROM financial_accounts WHERE account_id = ${older.tenant.accountId} AND name = 'Supplier Payable'`;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ account_type: 'LIABILITY', account_role: 'UNCLASSIFIED', currency: 'USD' });
      // 11 starter accounts audited at onboarding (the deleted one included), plus exactly one backfill.
      expect(await auditCount(raw, older.tenant.accountId, 'financial_account', 'CREATE')).toBe(12);
    });
  });

  describe('confirmed records are immutable', () => {
    it('refuses edits, cancellation and re-confirmation through the API', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      const edit = await purchaseRoute('patch', draft.purchase.id, { method: 'PATCH', body: { notes: 'sneaky' } });
      expect([edit.status, (await edit.json()).error.code]).toEqual([409, 'PURCHASE_NOT_EDITABLE']);
      const cancel = await purchaseRoute('cancel', draft.purchase.id);
      expect([cancel.status, (await cancel.json()).error.code]).toEqual([409, 'PURCHASE_NOT_CANCELLABLE']);
    });

    it('the database refuses direct changes to a confirmed purchase, its lines and its journal', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      const [entry] = await journalOf(draft.purchase.id);
      const fails = async (run: () => Promise<unknown>, pattern: RegExp) => {
        const error = await run().then(() => null, (failure: unknown) => failure as Error);
        expect(error?.message).toMatch(pattern);
      };
      await fails(() => raw`UPDATE supplier_purchases SET total_amount = 1 WHERE id = ${draft.purchase.id}`, /require adjustments/);
      await fails(() => raw`DELETE FROM supplier_purchases WHERE id = ${draft.purchase.id}`, /cannot be deleted/);
      await fails(() => raw`DELETE FROM supplier_purchase_items WHERE supplier_purchase_id = ${draft.purchase.id}`, /immutable/);
      await fails(() => raw`UPDATE journal_entries SET description = 'x' WHERE id = ${entry?.id}`, /immutable/);
      await fails(() => raw`DELETE FROM journal_lines WHERE journal_entry_id = ${entry?.id}`, /immutable/);
    });
  });

  describe('reversal', () => {
    it('reverses with the exact opposite entry, leaves the original untouched and removes the cost from profit', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      const [original] = await journalOf(draft.purchase.id);
      const originalLines = await linesOf(original?.id as string);

      const response = await purchaseRoute('reverse', draft.purchase.id, { body: { reason: 'Entered the wrong total' } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.alreadyReversed).toBe(false);
      expect(body.purchase).toMatchObject({ status: 'CONFIRMED', effectiveStatus: 'REVERSED' });
      expect(body).toMatchObject({ canReverse: false, canEdit: false });

      const [reversal] = await raw`SELECT * FROM journal_entries WHERE account_id = ${tenantId()} AND reversal_of_entry_id = ${original?.id}`;
      expect(reversal).toMatchObject({ status: 'FINALIZED', source_event: 'REVERSAL', currency: 'USD' });
      expect(await linesOf(reversal?.id as string)).toEqual([
        { name: 'Supplier Payable', account_role: 'UNCLASSIFIED', account_type: 'LIABILITY', debit: '25.2500', credit: '0.0000' },
        { name: 'Supplier Costs', account_role: 'SUPPLIER_COST', account_type: 'EXPENSE', debit: '0.0000', credit: '25.2500' },
      ]);
      // The original is exactly as it was.
      const [after] = await journalOf(draft.purchase.id);
      expect(after).toMatchObject({ id: original?.id, status: 'FINALIZED' });
      expect(await linesOf(original?.id as string)).toEqual(originalLines);

      expect((await orderDetail(order)).profit).toMatchObject({ confirmedSupplierCosts: '0.00', directProfitBeforeExpensesAndRefunds: '100.00' });
      const [audit] = await raw`SELECT after_data FROM audit_logs WHERE entity_id = ${draft.purchase.id} AND action = 'REVERSE'`;
      expect(audit?.after_data).toMatchObject({ reason: 'Entered the wrong total' });
    });

    it('is idempotent: a repeated reversal changes and audits nothing', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      await purchaseRoute('reverse', draft.purchase.id, { body: { reason: 'First' } });
      const again = await purchaseRoute('reverse', draft.purchase.id, { body: { reason: 'Second' } });
      expect(again.status).toBe(200);
      expect((await again.json()).alreadyReversed).toBe(true);
      const [count] = await raw`SELECT count(*)::int AS n FROM journal_entries WHERE account_id = ${tenantId()} AND source_id IN (SELECT id FROM journal_entries WHERE source_id = ${draft.purchase.id})`;
      expect(count?.n).toBe(1);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'REVERSE', draft.purchase.id)).toBe(1);
    });

    it('serializes concurrent reversals into one', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      await confirmViaApi(draft.purchase.id);
      const results = await Promise.all(Array.from({ length: 5 }, () => reversePurchase(app.db, user.tenant, draft.purchase.id, { reason: 'Duplicate' })));
      expect(results.filter((result) => !result.alreadyReversed)).toHaveLength(1);
      expect(await auditCount(raw, tenantId(), 'supplier_purchase', 'REVERSE', draft.purchase.id)).toBe(1);
    });

    it('requires a reason and a confirmed purchase', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDraftPurchase(app, user, supplierId, order);
      expect((await purchaseRoute('reverse', draft.purchase.id, { body: { reason: 'Too early' } })).status).toBe(409);
      await confirmViaApi(draft.purchase.id);
      for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'contact jane@example.com' }, { reason: 'x'.repeat(501) }, { reason: 'ok', extra: 1 }]) {
        expect((await purchaseRoute('reverse', draft.purchase.id, { body })).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect((await orderDetail(order)).profit.confirmedSupplierCosts).toBe(DEFAULT_PURCHASE_TOTAL);
    });

    it('a corrected purchase notes what it replaces, cannot reuse the reference, and replaces the cost in profit', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const reference = `FIX-${Date.now()}`;
      const wrong = await makeDraftPurchase(app, user, supplierId, order, { supplierOrderReference: reference });
      await confirmViaApi(wrong.purchase.id);

      const notReversed = await makeDraftPurchase(app, user, supplierId, order, { replacesPurchaseId: wrong.purchase.id }).then(() => null, (error: unknown) => error);
      expect(notReversed).toMatchObject({ code: 'REPLACED_PURCHASE_INVALID', fields: ['replacesPurchaseId'] });

      await purchaseRoute('reverse', wrong.purchase.id, { body: { reason: 'Wrong supplier price' } });
      const clash = await makeDraftPurchase(app, user, supplierId, order, { supplierOrderReference: reference, replacesPurchaseId: wrong.purchase.id }).then(() => null, (error: unknown) => error);
      expect(clash).toMatchObject({ code: 'DUPLICATE_SUPPLIER_REFERENCE' });

      const [first, second] = order.items;
      const corrected = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, replacesPurchaseId: wrong.purchase.id, notes: 'Corrected price',
        lines: [{ orderItemId: first?.id ?? '', quantity: 2, unitCost: '9.00' }, { orderItemId: second?.id ?? '', quantity: 1, unitCost: '5.00' }],
      });
      expect(corrected.purchase.notes).toBe(`Replaces purchase ${wrong.purchase.id}.\nCorrected price`);
      await confirmViaApi(corrected.purchase.id);
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedSupplierCosts: '23.00', directProfitBeforeExpensesAndRefunds: '77.00' });
      const purchases = (await orderDetail(order)).purchases.map((purchase) => purchase.effectiveStatus).sort();
      expect(purchases).toEqual(['CONFIRMED', 'REVERSED']);
    });
  });

  describe('actual profit uses confirmed, unreversed costs only', () => {
    it('splits a purchase across orders and sums several purchases exactly', async () => {
      const orderA = await makeOrder(app, user, { netPayableAmount: '50.00', items: [{ productName: 'A1', quantity: 1 }] });
      const orderB = await makeOrder(app, user, { netPayableAmount: '0.30', items: [{ productName: 'B1', quantity: 1 }] });
      const spanning = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE,
        lines: [{ orderItemId: orderA.items[0]?.id ?? '', quantity: 1, unitCost: '12.34' }, { orderItemId: orderB.items[0]?.id ?? '', quantity: 1, unitCost: '0.10' }],
      });
      const extra = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: orderB.items[0]?.id ?? '', quantity: 1, unitCost: '0.10' }],
      });
      await confirmViaApi(spanning.purchase.id);
      await confirmViaApi(extra.purchase.id);
      expect((await orderDetail(orderA)).profit).toMatchObject({ confirmedSupplierCosts: '12.34', directProfitBeforeExpensesAndRefunds: '37.66' });
      expect((await orderDetail(orderB)).profit).toMatchObject({ confirmedSupplierCosts: '0.20', directProfitBeforeExpensesAndRefunds: '0.10' });
    });

    it('shows a loss as a negative amount', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '10.00', items: [{ productName: 'Loss', quantity: 1 }] });
      const draft = await createPurchase(app.db, user.tenant, {
        supplierId, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id ?? '', quantity: 1, unitCost: '14.75' }],
      });
      await confirmViaApi(draft.purchase.id);
      expect((await orderDetail(order)).profit.directProfitBeforeExpensesAndRefunds).toBe('-4.75');
    });

    it('excludes draft, cancelled and reversed purchases', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00', items: [{ productName: 'Mix', quantity: 1 }] });
      const line = (unitCost: string) => [{ orderItemId: order.items[0]?.id ?? '', quantity: 1, unitCost }];
      const counted = await createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: line('1.00') });
      const reversed = await createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: line('2.00') });
      const cancelled = await createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: line('4.00') });
      await createPurchase(app.db, user.tenant, { supplierId, purchaseDate: PURCHASE_DATE, lines: line('8.00') });
      await confirmViaApi(counted.purchase.id);
      await confirmViaApi(reversed.purchase.id);
      await purchaseRoute('reverse', reversed.purchase.id, { body: { reason: 'Mistake' } });
      await purchaseRoute('cancel', cancelled.purchase.id);
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedSupplierCosts: '1.00', draftSupplierCosts: '8.00', directProfitBeforeExpensesAndRefunds: '99.00' });
    });

    it('keeps the ledger balanced in every currency after confirmations and reversals', async () => {
      const rows = await raw`SELECT l.currency, sum(l.debit_amount)::text AS debits, sum(l.credit_amount)::text AS credits
        FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = ${tenantId()} AND e.status = 'FINALIZED' GROUP BY l.currency`;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.debits).toBe(row.credits);
    });
  });

  it('an edit that cannot be allocated leaves the draft unchanged', async () => {
    const order = await makeOrder(app, user);
    const draft = await makeDraftPurchase(app, user, supplierId, order);
    await expect(updateDraftPurchase(app.db, user.tenant, draft.purchase.id, {
      lines: [{ orderItemId: '00000000-0000-4000-8000-0000000000bb', quantity: 1, unitCost: '1.00' }],
    })).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_FOUND' });
    const [row] = await raw`SELECT total_amount::text AS total, (SELECT count(*)::int FROM supplier_purchase_items WHERE supplier_purchase_id = ${draft.purchase.id}) AS lines FROM supplier_purchases WHERE id = ${draft.purchase.id}`;
    expect(row).toMatchObject({ total: '25.2500', lines: 2 });
  });
});
