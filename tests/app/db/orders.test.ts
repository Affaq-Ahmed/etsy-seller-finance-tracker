import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { businessAccounts } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { NO_STORE } from '@/server/http/responses';
import { hasTestDatabase } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import { auditCount, makeOrder, makeProduct, openRaw, uniqueEtsyId, ORDER_DATE } from '../support/phase2';

describe.skipIf(!hasTestDatabase)('orders', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let user: OnboardedUser;
  let routes: ReturnType<typeof apiRoutes>;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    user = await registerAndOnboard(app, 'Orders Shop', 'orders');
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  const post = (path: string, body: unknown, who: OnboardedUser = user) =>
    routes.orders.create(apiRequest(app, path, { method: 'POST', cookie: who.cookie, body }));
  const orderBody = (overrides: Record<string, unknown> = {}) => ({
    etsyOrderId: uniqueEtsyId(), orderDate: ORDER_DATE, netPayableAmount: '87.50',
    items: [{ productName: 'Handmade Mug', sku: 'MUG-1', quantity: 2 }, { productName: 'Plate', quantity: 1 }],
    ...overrides,
  });
  const getOrder = (id: string, who: OnboardedUser = user) =>
    callRoute(routes.orders.get, apiRequest(app, `/api/v1/orders/${id}`, { cookie: who.cookie }), { orderId: id });
  const patchOrder = (id: string, body: unknown, who: OnboardedUser = user) =>
    callRoute(routes.orders.patch, apiRequest(app, `/api/v1/orders/${id}`, { method: 'PATCH', cookie: who.cookie, body }), { orderId: id });
  const setStatus = (id: string, body: unknown, who: OnboardedUser = user) =>
    callRoute(routes.orders.status, apiRequest(app, `/api/v1/orders/${id}/status`, { method: 'POST', cookie: who.cookie, body }), { orderId: id });

  describe('creating and retrieving', () => {
    it('creates an order with items through the API and returns it privately', async () => {
      const response = await post('/api/v1/orders', orderBody({ etsyOrderId: '1234567890', notes: 'Gift wrap requested' }));
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      const body = await response.json();
      expect(body.order).toMatchObject({
        etsyOrderId: '1234567890', orderDate: '2026-11-20', netPayableAmount: '87.50', currency: 'USD',
        status: 'NEW', deliveredDate: null, notes: 'Gift wrap requested',
      });
      expect(body.items.map((item: { productName: string; quantity: number; sku: string | null; locked: boolean }) => [item.productName, item.quantity, item.sku, item.locked]))
        .toEqual([['Handmade Mug', 2, 'MUG-1', false], ['Plate', 1, null, false]]);
      expect(body.profit).toEqual({
        netPayable: '87.50', revenue: '87.50', revenueExcluded: false, confirmedSupplierCosts: '0.00',
        directProfitBeforeExpensesAndRefunds: '87.50', draftSupplierCosts: '0.00', includesExpenses: false, includesRefunds: false,
      });
      expect(body.allowedNextStatuses).toEqual(['SUPPLIER_ORDERED', 'CANCELLED']);
      // Tenant and owner identity are never part of the response.
      expect(JSON.stringify(body)).not.toContain(user.tenant.accountId);
      expect(JSON.stringify(body)).not.toContain(user.session.userId);
    });

    it('retrieves it by ID and in the list', async () => {
      const created = await makeOrder(app, user, { etsyOrderId: '777000111' });
      const detail = await (await getOrder(created.order.id)).json();
      expect(detail.order.id).toBe(created.order.id);
      expect(detail.items).toHaveLength(2);

      const list = await (await routes.orders.list(apiRequest(app, '/api/v1/orders', { cookie: user.cookie, query: '?limit=100' }))).json();
      const entry = list.items.find((item: { id: string }) => item.id === created.order.id);
      expect(entry).toMatchObject({ etsyOrderId: '777000111', itemCount: 2, status: 'NEW' });
      expect(entry.profit.directProfitBeforeExpensesAndRefunds).toBe('100.00');
    });

    it('returns 404 for a missing or malformed order ID', async () => {
      const missing = await getOrder('00000000-0000-4000-8000-000000000000');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Order not found.' } });
      const malformed = await callRoute(routes.orders.get, apiRequest(app, '/api/v1/orders/not-a-uuid', { cookie: user.cookie }), { orderId: 'not-a-uuid' });
      expect(malformed.status).toBe(404);
    });

    it('writes an audit entry without the notes', async () => {
      const before = await auditCount(raw, user.tenant.accountId, 'order', 'CREATE');
      const created = await makeOrder(app, user, { notes: 'Some private note' });
      expect(await auditCount(raw, user.tenant.accountId, 'order', 'CREATE')).toBe(before + 1);
      const [row] = await raw`SELECT after_data FROM audit_logs WHERE entity_id = ${created.order.id} AND action = 'CREATE'`;
      expect(JSON.stringify(row?.after_data)).not.toContain('Some private note');
    });
  });

  describe('multiple products and quantities', () => {
    it('snapshots product name and SKU onto items, in entered order, unaffected by later product edits', async () => {
      const mug = await makeProduct(app, user, { name: 'Ceramic Mug', sku: `MUG-${uniqueEtsyId()}`, defaultUnitCost: '999.00' });
      const bowl = await makeProduct(app, user, { name: 'Bowl', sku: `BOWL-${uniqueEtsyId()}` });
      const order = await makeOrder(app, user, {
        items: [{ productId: mug.id, quantity: 1 }, { productId: bowl.id, quantity: 2 }, { productName: 'Custom engraving', quantity: 5 }],
      });
      expect(order.items.map((item) => [item.productName, item.sku, item.quantity, item.productId])).toEqual([
        ['Ceramic Mug', mug.sku, 1, mug.id], ['Bowl', bowl.sku, 2, bowl.id], ['Custom engraving', null, 5, null],
      ]);

      await raw`UPDATE products SET name = 'Renamed later', sku = 'CHANGED' WHERE id = ${mug.id}`;
      const reread = await (await getOrder(order.order.id)).json();
      expect(reread.items[0]).toMatchObject({ productName: 'Ceramic Mug', sku: mug.sku });
    });

    it('never treats a product default cost as an actual cost', async () => {
      const pricey = await makeProduct(app, user, { name: 'Expensive default', defaultUnitCost: '999.00' });
      const order = await makeOrder(app, user, { netPayableAmount: '50.00', items: [{ productId: pricey.id, quantity: 3 }] });
      expect(order.profit.confirmedSupplierCosts).toBe('0.00');
      expect(order.profit.directProfitBeforeExpensesAndRefunds).toBe('50.00');
      expect(await raw`SELECT 1 FROM journal_entries WHERE account_id = ${user.tenant.accountId} AND source_id IN (${order.order.id}, ${pricey.id})`).toHaveLength(0);
    });

    it('rejects an unknown product with the same answer as another tenant would get', async () => {
      const response = await post('/api/v1/orders', orderBody({ items: [{ productId: '00000000-0000-4000-8000-0000000000aa', quantity: 1 }] }));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toMatchObject({ code: 'PRODUCT_NOT_FOUND', fields: ['items.0.productId'] });
    });
  });

  describe('duplicate Etsy Order IDs', () => {
    it('answers 409 naming etsyOrderId within a tenant, trimming first, and creates nothing', async () => {
      const etsyOrderId = uniqueEtsyId();
      expect((await post('/api/v1/orders', orderBody({ etsyOrderId }))).status).toBe(201);
      const before = await raw`SELECT count(*)::int AS n FROM orders WHERE account_id = ${user.tenant.accountId}`;
      const duplicate = await post('/api/v1/orders', orderBody({ etsyOrderId: `  ${etsyOrderId}  ` }));
      expect(duplicate.status).toBe(409);
      expect((await duplicate.json()).error).toMatchObject({ code: 'DUPLICATE_ETSY_ORDER_ID', fields: ['etsyOrderId'] });
      const after = await raw`SELECT count(*)::int AS n FROM orders WHERE account_id = ${user.tenant.accountId}`;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it('allows the same Etsy Order ID in a different tenant', async () => {
      const other = await registerAndOnboard(app, 'Other Shop', 'orders-other');
      const etsyOrderId = uniqueEtsyId();
      expect((await post('/api/v1/orders', orderBody({ etsyOrderId }))).status).toBe(201);
      expect((await post('/api/v1/orders', orderBody({ etsyOrderId }), other)).status).toBe(201);
    });
  });

  describe('validation', () => {
    it.each([
      ['no items', { items: [] }, ['items']],
      ['too many items', { items: Array.from({ length: 51 }, () => ({ productName: 'X', quantity: 1 })) }, ['items']],
      ['zero quantity', { items: [{ productName: 'X', quantity: 0 }] }, ['items.0.quantity']],
      ['fractional quantity', { items: [{ productName: 'X', quantity: 1.5 }] }, ['items.0.quantity']],
      ['item with neither product nor name', { items: [{ quantity: 1 }] }, ['items.0']],
      ['item with both a product and a name', { items: [{ productId: '00000000-0000-4000-8000-000000000001', productName: 'X', quantity: 1 }] }, ['items.0']],
      ['three decimal places', { netPayableAmount: '10.999' }, ['netPayableAmount']],
      ['a negative amount', { netPayableAmount: '-5.00' }, ['netPayableAmount']],
      ['exponent notation', { netPayableAmount: '1e3' }, ['netPayableAmount']],
      ['a thousands separator', { netPayableAmount: '1,000.00' }, ['netPayableAmount']],
      ['a JSON number instead of a string', { netPayableAmount: 100 }, ['netPayableAmount']],
      ['a 13-digit amount', { netPayableAmount: '1000000000000.00' }, ['netPayableAmount']],
      ['an impossible date', { orderDate: '2026-02-30' }, ['orderDate']],
      ['a malformed date', { orderDate: '20/11/2026' }, ['orderDate']],
      ['an Etsy ID containing an email', { etsyOrderId: 'buyer@example.com' }, ['etsyOrderId']],
      ['an Etsy ID with spaces', { etsyOrderId: '123 456' }, ['etsyOrderId']],
      ['an email in notes', { notes: 'ship to jane@example.com' }, ['notes']],
      ['a phone number in notes', { notes: 'call +92 300 1234567' }, ['notes']],
      ['an unknown field', { buyerName: 'Jane' }, ['buyerName']],
      ['a forged tenant ID', { accountId: '00000000-0000-4000-8000-000000000001' }, ['accountId']],
    ])('rejects %s with 400 naming the field and never echoing the value', async (_label, overrides, fields) => {
      const response = await post('/api/v1/orders', orderBody(overrides));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.fields).toEqual(fields);
      for (const leaked of ['jane@example.com', '1234567', 'Jane', 'buyer@example.com']) expect(JSON.stringify(body)).not.toContain(leaked);
    });

    it('accepts a note with a date and clock time (not mistaken for a phone number)', async () => {
      expect((await post('/api/v1/orders', orderBody({ notes: 'Packed 2026-11-20 14:30, courier pickup Friday' }))).status).toBe(201);
    });

    it('stores an empty note as null', async () => {
      const response = await post('/api/v1/orders', orderBody({ notes: '   ' }));
      expect((await response.json()).order.notes).toBeNull();
    });

    it('accepts the business currency and rejects any other with a clear 422', async () => {
      expect((await post('/api/v1/orders', orderBody({ currency: 'USD' }))).status).toBe(201);
      const response = await post('/api/v1/orders', orderBody({ currency: 'PKR' }));
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: 'CURRENCY_NOT_SUPPORTED', fields: ['currency'] });
    });
  });

  describe('calendar dates in the business timezone', () => {
    it('stores local midnight, so the date shown never shifts (Asia/Karachi)', async () => {
      const order = await makeOrder(app, user, { orderDate: '2026-11-25' });
      const [row] = await raw`SELECT order_date FROM orders WHERE id = ${order.order.id}`;
      expect((row?.order_date as Date).toISOString()).toBe('2026-11-24T19:00:00.000Z');
      expect(order.order.orderDate).toBe('2026-11-25');
    });

    it('follows the business timezone, including DST', async () => {
      const zoned = await registerAndOnboard(app, 'New York Shop', 'orders-tz');
      await app.db.update(businessAccounts).set({ timezone: 'America/New_York' }).where(eq(businessAccounts.id, zoned.tenant.accountId));
      const winter = await makeOrder(app, zoned, { orderDate: '2026-11-25' });
      const summer = await makeOrder(app, zoned, { orderDate: '2026-07-04' });
      const rows = await raw`SELECT id, order_date FROM orders WHERE id IN (${winter.order.id}, ${summer.order.id})`;
      const instant = (id: string) => (rows.find((row) => row.id === id)?.order_date as Date).toISOString();
      expect(instant(winter.order.id)).toBe('2026-11-25T05:00:00.000Z');
      expect(instant(summer.order.id)).toBe('2026-07-04T04:00:00.000Z');
      expect([winter.order.orderDate, summer.order.orderDate]).toEqual(['2026-11-25', '2026-07-04']);
    });
  });

  describe('status lifecycle', () => {
    it('walks NEW -> SUPPLIER_ORDERED -> SHIPPED -> IN_TRANSIT -> DELIVERED, one step at a time', async () => {
      const { order } = await makeOrder(app, user, { orderDate: '2026-11-20' });
      for (const status of ['SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT']) {
        const response = await setStatus(order.id, { status });
        expect(response.status).toBe(200);
        expect((await response.json()).order.status).toBe(status);
      }
      const delivered = await setStatus(order.id, { status: 'DELIVERED', deliveredDate: '2026-11-28' });
      expect(delivered.status).toBe(200);
      const body = await delivered.json();
      expect(body.order).toMatchObject({ status: 'DELIVERED', deliveredDate: '2026-11-28' });
      expect(body.allowedNextStatuses).toEqual([]);
      expect(await auditCount(raw, user.tenant.accountId, 'order', 'STATUS_CHANGE', order.id)).toBe(4);
    });

    it.each([
      ['skipping a step', { status: 'SHIPPED' }, 409, 'INVALID_STATUS_TRANSITION'],
      ['jumping straight to DELIVERED', { status: 'DELIVERED', deliveredDate: '2026-11-25' }, 409, 'INVALID_STATUS_TRANSITION'],
      ['a payout status', { status: 'PAID' }, 400, 'INVALID_REQUEST'],
      ['a refund status', { status: 'REFUNDED' }, 400, 'INVALID_REQUEST'],
      ['moving back to NEW', { status: 'NEW' }, 400, 'INVALID_REQUEST'],
    ])('rejects %s', async (_label, body, status, code) => {
      const { order } = await makeOrder(app, user);
      const response = await setStatus(order.id, body);
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
      expect((await (await getOrder(order.id)).json()).order.status).toBe('NEW');
    });

    it('requires a delivery date for DELIVERED, not before the order date, and only for DELIVERED', async () => {
      const { order } = await makeOrder(app, user, { orderDate: '2026-11-20' });
      for (const status of ['SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT']) await setStatus(order.id, { status });
      const missing = await setStatus(order.id, { status: 'DELIVERED' });
      expect(missing.status).toBe(422);
      expect((await missing.json()).error.code).toBe('DELIVERED_DATE_REQUIRED');
      const early = await setStatus(order.id, { status: 'DELIVERED', deliveredDate: '2026-11-19' });
      expect((await early.json()).error.code).toBe('DELIVERED_BEFORE_ORDER');
      const stray = await setStatus(order.id, { status: 'CANCELLED', deliveredDate: '2026-11-25' });
      expect((await stray.json()).error.code).toBe('DELIVERED_DATE_NOT_ALLOWED');
      expect((await (await getOrder(order.id)).json()).order.status).toBe('IN_TRANSIT');
    });

    it('allows CANCELLED before delivery but not after, and cancelled orders are terminal', async () => {
      const early = await makeOrder(app, user);
      expect((await setStatus(early.order.id, { status: 'CANCELLED' })).status).toBe(200);
      expect((await (await setStatus(early.order.id, { status: 'SUPPLIER_ORDERED' })).json()).error.code).toBe('INVALID_STATUS_TRANSITION');

      const delivered = await makeOrder(app, user);
      for (const status of ['SUPPLIER_ORDERED', 'SHIPPED', 'IN_TRANSIT']) await setStatus(delivered.order.id, { status });
      await setStatus(delivered.order.id, { status: 'DELIVERED', deliveredDate: '2026-11-25' });
      expect((await setStatus(delivered.order.id, { status: 'CANCELLED' })).status).toBe(409);
    });

    it('treats a repeated request as a no-op without a second audit entry', async () => {
      const { order } = await makeOrder(app, user);
      await setStatus(order.id, { status: 'SUPPLIER_ORDERED' });
      expect((await setStatus(order.id, { status: 'SUPPLIER_ORDERED' })).status).toBe(200);
      expect(await auditCount(raw, user.tenant.accountId, 'order', 'STATUS_CHANGE', order.id)).toBe(1);
    });
  });

  describe('editing', () => {
    it('updates header fields and replaces items while unlocked', async () => {
      const { order } = await makeOrder(app, user);
      const response = await patchOrder(order.id, {
        netPayableAmount: '120.25', orderDate: '2026-11-21', notes: 'Updated', items: [{ productName: 'Only item', quantity: 4 }],
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.order).toMatchObject({ netPayableAmount: '120.25', orderDate: '2026-11-21', notes: 'Updated' });
      expect(body.items.map((item: { productName: string; quantity: number }) => [item.productName, item.quantity])).toEqual([['Only item', 4]]);
      expect(await auditCount(raw, user.tenant.accountId, 'order', 'UPDATE', order.id)).toBe(1);
    });

    it('rejects an empty patch, unknown fields, a duplicate Etsy ID and cancelled orders', async () => {
      const first = await makeOrder(app, user);
      const second = await makeOrder(app, user);
      expect((await patchOrder(first.order.id, {})).status).toBe(400);
      expect((await patchOrder(first.order.id, { status: 'DELIVERED' })).status).toBe(400);
      const dup = await patchOrder(second.order.id, { etsyOrderId: first.order.etsyOrderId });
      expect(dup.status).toBe(409);
      expect((await dup.json()).error.fields).toEqual(['etsyOrderId']);
      await setStatus(first.order.id, { status: 'CANCELLED' });
      const cancelled = await patchOrder(first.order.id, { notes: 'late edit' });
      expect(cancelled.status).toBe(409);
      expect((await cancelled.json()).error.code).toBe('ORDER_NOT_EDITABLE');
    });
  });

  describe('listing', () => {
    it('paginates newest first with a stable total and rejects bad parameters', async () => {
      const lister = await registerAndOnboard(app, 'Paging Shop', 'orders-paging');
      const dates = ['2026-10-01', '2026-10-03', '2026-10-02'];
      for (const orderDate of dates) await makeOrder(app, lister, { orderDate });
      const page = async (query: string) => (await routes.orders.list(apiRequest(app, '/api/v1/orders', { cookie: lister.cookie, query }))).json();

      const first = await page('?limit=2&offset=0');
      expect(first.items.map((item: { orderDate: string }) => item.orderDate)).toEqual(['2026-10-03', '2026-10-02']);
      expect(first.page).toEqual({ limit: 2, offset: 0, total: 3 });
      const second = await page('?limit=2&offset=2');
      expect(second.items.map((item: { orderDate: string }) => item.orderDate)).toEqual(['2026-10-01']);

      for (const bad of ['?limit=0', '?limit=101', '?offset=-1', '?limit=abc', '?cursor=1']) {
        const response = await routes.orders.list(apiRequest(app, '/api/v1/orders', { cookie: lister.cookie, query: bad }));
        expect(response.status, bad).toBe(400);
      }
    });
  });
});
