import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { eq } from 'drizzle-orm';
import {
  journalEntries, journalLines, orderItems, orders, products, supplierPurchaseItems, supplierPurchases, suppliers,
} from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { tenantScope, TenantScopeViolationError, type TenantTable, type TenantUpdate } from '@/server/dal/tenant-scope';
import { getPostgresErrorCode, PG_FOREIGN_KEY_VIOLATION } from '@/server/db/errors';
import type { OrderDetail } from '@/server/orders/service';
import { confirmPurchase, type PurchaseDetail } from '@/server/purchases/service';
import { hasTestDatabase } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, registerAndSignIn, type ApiCallOptions, type OnboardedUser } from '../support/app';
import { makeDraftPurchase, makeOrder, makeProduct, makeSupplier, openRaw, PURCHASE_DATE } from '../support/phase2';

const MISSING = '00000000-0000-4000-8000-0000000000ee';

describe.skipIf(!hasTestDatabase)('Phase 2a tenant isolation', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let a: OnboardedUser;
  let b: OnboardedUser;
  let bSupplierId: string;
  let bProductId: string;
  let bOrder: OrderDetail;
  let bDraft: PurchaseDetail;
  let bConfirmed: PurchaseDetail;
  let bJournalId: string;
  let bJournalLineId: string;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    a = await registerAndOnboard(app, 'Isolation A', 'iso2-a');
    b = await registerAndOnboard(app, 'Isolation B', 'iso2-b');
    bSupplierId = (await makeSupplier(app, b)).id;
    bProductId = (await makeProduct(app, b, { name: 'B product' })).id;
    bOrder = await makeOrder(app, b);
    bDraft = await makeDraftPurchase(app, b, bSupplierId, bOrder);
    bConfirmed = await makeDraftPurchase(app, b, bSupplierId, bOrder);
    await confirmPurchase(app.db, b.tenant, bConfirmed.purchase.id);
    const [entry] = await raw`SELECT id FROM journal_entries WHERE account_id = ${b.tenant.accountId} AND source_id = ${bConfirmed.purchase.id}`;
    bJournalId = entry?.id as string;
    const [line] = await raw`SELECT id FROM journal_lines WHERE journal_entry_id = ${bJournalId} LIMIT 1`;
    bJournalLineId = line?.id as string;
    // A has its own data, so "empty" is never the reason a request looks isolated.
    await makeOrder(app, a);
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  type Handler = Parameters<typeof callRoute>[0];
  const call = (handler: Handler, who: OnboardedUser | null, path: string, options: ApiCallOptions = {}, params: Record<string, string> = {}) =>
    callRoute(handler, apiRequest(app, path, { cookie: who?.cookie, ...options }), params);

  /** A response with every identifier the same, so cross-tenant and missing IDs are indistinguishable. */
  async function snapshot(response: Response) {
    return { status: response.status, body: await response.json() };
  }

  const snapshotBState = async () => ({
    order: (await raw`SELECT status, net_payable_amount::text AS net, notes, updated_at FROM orders WHERE id = ${bOrder.order.id}`)[0],
    purchases: await raw`SELECT id, status, confirmed_at, total_amount::text AS total, notes, updated_at FROM supplier_purchases WHERE account_id = ${b.tenant.accountId} ORDER BY id`,
    journals: Number((await raw`SELECT count(*)::int AS n FROM journal_entries WHERE account_id = ${b.tenant.accountId}`)[0]?.n),
    audits: Number((await raw`SELECT count(*)::int AS n FROM audit_logs WHERE account_id = ${b.tenant.accountId}`)[0]?.n),
  });

  describe('API: another tenant looks exactly like a missing record', () => {
    it('reads', async () => {
      const cases: Array<[string, Handler, string, Record<string, string>, string]> = [
        ['order', routes.orders.get, '/api/v1/orders/', { orderId: bOrder.order.id }, 'orderId'],
        ['purchase', routes.purchases.get, '/api/v1/purchases/', { purchaseId: bConfirmed.purchase.id }, 'purchaseId'],
      ];
      for (const [, handler, base, params, key] of cases) {
        const foreign = await snapshot(await call(handler, a, `${base}${params[key]}`, {}, params));
        const missing = await snapshot(await call(handler, a, `${base}${MISSING}`, {}, { [key]: MISSING }));
        expect(foreign.status).toBe(404);
        expect(foreign).toEqual(missing);
      }
    });

    it.each([
      ['PATCH order', 'orders', 'patch', 'orderId', 'PATCH', { notes: 'hijack' }],
      ['change order status', 'orders', 'status', 'orderId', 'POST', { status: 'CANCELLED' }],
      ['PATCH purchase', 'purchases', 'patch', 'purchaseId', 'PATCH', { notes: 'hijack' }],
      ['confirm purchase', 'purchases', 'confirm', 'purchaseId', 'POST', undefined],
      ['cancel purchase', 'purchases', 'cancel', 'purchaseId', 'POST', undefined],
      ['reverse purchase', 'purchases', 'reverse', 'purchaseId', 'POST', { reason: 'hijack' }],
    ] as const)('%s changes nothing and answers like a missing record', async (_label, group, name, key, method, body) => {
      const handler = (routes[group] as Record<string, Handler>)[name] as Handler;
      const targets = key === 'orderId' ? [bOrder.order.id] : [bDraft.purchase.id, bConfirmed.purchase.id];
      for (const id of targets) {
        const before = await snapshotBState();
        const foreign = await snapshot(await call(handler, a, `/api/v1/${group}/${id}`, { method, body }, { [key]: id }));
        const missing = await snapshot(await call(handler, a, `/api/v1/${group}/${MISSING}`, { method, body }, { [key]: MISSING }));
        expect(foreign.status).toBe(404);
        expect(foreign).toEqual(missing);
        expect(await snapshotBState()).toEqual(before);
      }
    });

    it('lists show only the caller’s own rows', async () => {
      const ids = new Set([bOrder.order.id, bSupplierId, bProductId, bDraft.purchase.id, bConfirmed.purchase.id]);
      const lists: Array<[Handler, string]> = [
        [routes.orders.list, '/api/v1/orders'], [routes.purchases.list, '/api/v1/purchases'],
        [routes.suppliers.list, '/api/v1/suppliers'], [routes.products.list, '/api/v1/products'],
      ];
      for (const [handler, path] of lists) {
        const body = await (await call(handler, a, path, { query: '?limit=100' })).json();
        expect(body.items.some((item: { id: string }) => ids.has(item.id)), path).toBe(false);
        expect(body.page.total, path).toBe(body.items.length);
      }
      const bOrders = await (await call(routes.orders.list, b, '/api/v1/orders', { query: '?limit=100' })).json();
      expect(bOrders.items.some((item: { id: string }) => item.id === bOrder.order.id)).toBe(true);
    });
  });

  describe('API: references to another tenant’s records are rejected like unknown IDs', () => {
    const create = (who: OnboardedUser, handler: Handler, path: string, body: unknown) => call(handler, who, path, { method: 'POST', body });

    it('product, supplier, order item and replaced purchase', async () => {
      const ownOrder = await makeOrder(app, a);
      const ownSupplier = (await makeSupplier(app, a)).id;
      const ownItem = ownOrder.items[0]?.id ?? '';
      const orderBody = (productId: string) => ({ etsyOrderId: `iso-${productId.slice(-4)}-${Date.now()}`, orderDate: '2026-11-20', netPayableAmount: '5.00', items: [{ productId, quantity: 1 }] });
      const purchaseBody = (overrides: Record<string, unknown>) => ({
        supplierId: ownSupplier, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: ownItem, quantity: 1, unitCost: '1.00' }], ...overrides,
      });
      const pairs: Array<[string, () => Promise<Response>, () => Promise<Response>]> = [
        ['product', () => create(a, routes.orders.create, '/api/v1/orders', orderBody(bProductId)), () => create(a, routes.orders.create, '/api/v1/orders', orderBody(MISSING))],
        ['supplier', () => create(a, routes.purchases.create, '/api/v1/purchases', purchaseBody({ supplierId: bSupplierId })), () => create(a, routes.purchases.create, '/api/v1/purchases', purchaseBody({ supplierId: MISSING }))],
        ['order item', () => create(a, routes.purchases.create, '/api/v1/purchases', purchaseBody({ lines: [{ orderItemId: bOrder.items[0]?.id, quantity: 1, unitCost: '1.00' }] })), () => create(a, routes.purchases.create, '/api/v1/purchases', purchaseBody({ lines: [{ orderItemId: MISSING, quantity: 1, unitCost: '1.00' }] }))],
        ['replaced purchase', () => create(a, routes.purchases.create, '/api/v1/purchases', purchaseBody({ replacesPurchaseId: bConfirmed.purchase.id })), () => create(a, routes.purchases.create, '/api/v1/purchases', purchaseBody({ replacesPurchaseId: MISSING }))],
        ['product on a supplier default', () => create(a, routes.products.create, '/api/v1/products', { name: 'X', defaultSupplierId: bSupplierId }), () => create(a, routes.products.create, '/api/v1/products', { name: 'X', defaultSupplierId: MISSING })],
      ];
      for (const [label, foreign, missing] of pairs) {
        const [f, m] = [await snapshot(await foreign()), await snapshot(await missing())];
        expect(f.status, label).toBe(422);
        expect(f, label).toEqual(m);
      }
      // Nothing of tenant B's leaked into A, and B's purchases are untouched.
      expect(await raw`SELECT 1 FROM supplier_purchase_items WHERE account_id = ${a.tenant.accountId} AND order_item_id = ${bOrder.items[0]?.id}`).toHaveLength(0);
    });

    it('rejects forged tenant fields on every write endpoint', async () => {
      const order = await makeOrder(app, a);
      const supplier = (await makeSupplier(app, a)).id;
      const purchase = await makeDraftPurchase(app, a, supplier, order);
      const forged = { accountId: b.tenant.accountId };
      const cases: Array<[string, Handler, string, 'POST' | 'PATCH', Record<string, unknown>, Record<string, string>]> = [
        ['supplier', routes.suppliers.create, '/api/v1/suppliers', 'POST', { name: 'S', marketplace: 'EBAY', ...forged }, {}],
        ['product', routes.products.create, '/api/v1/products', 'POST', { name: 'P', tenantId: b.tenant.accountId }, {}],
        ['order', routes.orders.create, '/api/v1/orders', 'POST', { etsyOrderId: 'f1', orderDate: '2026-11-20', netPayableAmount: '1.00', items: [{ productName: 'X', quantity: 1 }], ownerUserId: b.session.userId }, {}],
        ['order patch', routes.orders.patch, `/api/v1/orders/${order.order.id}`, 'PATCH', { notes: 'x', account_id: b.tenant.accountId }, { orderId: order.order.id }],
        ['order status', routes.orders.status, `/api/v1/orders/${order.order.id}/status`, 'POST', { status: 'CANCELLED', ...forged }, { orderId: order.order.id }],
        ['purchase', routes.purchases.create, '/api/v1/purchases', 'POST', { supplierId: supplier, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id, quantity: 1, unitCost: '1.00' }], ...forged }, {}],
        ['purchase patch', routes.purchases.patch, `/api/v1/purchases/${purchase.purchase.id}`, 'PATCH', { notes: 'x', ...forged }, { purchaseId: purchase.purchase.id }],
        ['purchase reverse', routes.purchases.reverse, `/api/v1/purchases/${purchase.purchase.id}/reverse`, 'POST', { reason: 'x', ...forged }, { purchaseId: purchase.purchase.id }],
        ['line', routes.purchases.create, '/api/v1/purchases', 'POST', { supplierId: supplier, purchaseDate: PURCHASE_DATE, lines: [{ orderItemId: order.items[0]?.id, quantity: 1, unitCost: '1.00', accountId: b.tenant.accountId }] }, {}],
      ];
      for (const [label, handler, path, method, body, params] of cases) {
        const response = await call(handler, a, path, { method, body }, params);
        const json = await response.json();
        expect(response.status, label).toBe(400);
        expect(JSON.stringify(json.error.fields), label).toMatch(/accountId|tenantId|ownerUserId|account_id/);
        expect(JSON.stringify(json), label).not.toContain(b.tenant.accountId);
      }
    });
  });

  describe('API: authentication and Origin on every new route', () => {
    const everyRoute = (): Array<[string, Handler, 'GET' | 'POST' | 'PATCH', string, Record<string, string>]> => [
      ['suppliers list', routes.suppliers.list, 'GET', '/api/v1/suppliers', {}],
      ['suppliers create', routes.suppliers.create, 'POST', '/api/v1/suppliers', {}],
      ['products list', routes.products.list, 'GET', '/api/v1/products', {}],
      ['products create', routes.products.create, 'POST', '/api/v1/products', {}],
      ['orders list', routes.orders.list, 'GET', '/api/v1/orders', {}],
      ['orders create', routes.orders.create, 'POST', '/api/v1/orders', {}],
      ['order get', routes.orders.get, 'GET', `/api/v1/orders/${MISSING}`, { orderId: MISSING }],
      ['order patch', routes.orders.patch, 'PATCH', `/api/v1/orders/${MISSING}`, { orderId: MISSING }],
      ['order status', routes.orders.status, 'POST', `/api/v1/orders/${MISSING}/status`, { orderId: MISSING }],
      ['purchases list', routes.purchases.list, 'GET', '/api/v1/purchases', {}],
      ['purchases create', routes.purchases.create, 'POST', '/api/v1/purchases', {}],
      ['purchase get', routes.purchases.get, 'GET', `/api/v1/purchases/${MISSING}`, { purchaseId: MISSING }],
      ['purchase patch', routes.purchases.patch, 'PATCH', `/api/v1/purchases/${MISSING}`, { purchaseId: MISSING }],
      ['purchase confirm', routes.purchases.confirm, 'POST', `/api/v1/purchases/${MISSING}/confirm`, { purchaseId: MISSING }],
      ['purchase cancel', routes.purchases.cancel, 'POST', `/api/v1/purchases/${MISSING}/cancel`, { purchaseId: MISSING }],
      ['purchase reverse', routes.purchases.reverse, 'POST', `/api/v1/purchases/${MISSING}/reverse`, { purchaseId: MISSING }],
    ];

    it('answers 401 without a session', async () => {
      for (const [label, handler, method, path, params] of everyRoute()) {
        const response = await call(handler, null, path, { method, body: method === 'GET' ? undefined : {} }, params);
        expect(response.status, label).toBe(401);
        expect(response.headers.get('cache-control'), label).toBe('private, no-store');
      }
    });

    it('answers 409 for a signed-in user who has not created a business', async () => {
      const fresh = await registerAndSignIn(app, 'iso2-fresh');
      for (const [label, handler, method, path, params] of everyRoute()) {
        const response = await callRoute(handler, apiRequest(app, path, { method, cookie: fresh.cookie, body: method === 'GET' ? undefined : {} }), params);
        expect(response.status, label).toBe(409);
      }
    });

    it('answers 403 to a state-changing request from another origin, and changes nothing', async () => {
      const before = await snapshotBState();
      for (const [label, handler, method, path, params] of everyRoute().filter(([, , method]) => method !== 'GET')) {
        const response = await call(handler, b, path, { method, body: {}, origin: 'https://evil.example' }, params);
        expect(response.status, label).toBe(403);
      }
      const withoutOrigin = await call(routes.purchases.confirm, b, `/api/v1/purchases/${bDraft.purchase.id}/confirm`, { method: 'POST', origin: null }, { purchaseId: bDraft.purchase.id });
      expect(withoutOrigin.status).toBe(403);
      expect(await snapshotBState()).toEqual(before);
    });
  });

  describe('data layer: SELECT, UPDATE, DELETE and INSERT across tenants', () => {
    const scopeA = () => tenantScope(app.db, a.tenant);

    async function assertIsolated<T extends TenantTable & { id: never }>(label: string, table: T, id: string, values: TenantUpdate<T>) {
      const idColumn = (table as unknown as { id: Parameters<typeof eq>[0] }).id;
      const target = eq(idColumn, id);
      expect(await scopeA().select(table, target), `${label} select`).toEqual([]);
      expect(await scopeA().update(table, values, target), `${label} update`).toEqual([]);
      expect(await scopeA().delete(table, target), `${label} delete`).toEqual([]);
      expect(await tenantScope(app.db, b.tenant).select(table, target), `${label} still present for its owner`).toHaveLength(1);
    }

    it('suppliers, products, orders, order items, purchases, purchase items, journal entries and lines', async () => {
      const purchaseItemId = (await raw`SELECT id FROM supplier_purchase_items WHERE supplier_purchase_id = ${bDraft.purchase.id} LIMIT 1`)[0]?.id as string;
      const touch = { createdAt: new Date() };
      await assertIsolated('suppliers', suppliers as never, bSupplierId, touch as never);
      await assertIsolated('products', products as never, bProductId, touch as never);
      await assertIsolated('orders', orders as never, bOrder.order.id, touch as never);
      await assertIsolated('orderItems', orderItems as never, bOrder.items[0]?.id ?? '', touch as never);
      await assertIsolated('supplierPurchases', supplierPurchases as never, bDraft.purchase.id, touch as never);
      await assertIsolated('supplierPurchaseItems', supplierPurchaseItems as never, purchaseItemId, touch as never);
      await assertIsolated('journalEntries', journalEntries as never, bJournalId, touch as never);
      await assertIsolated('journalLines', journalLines as never, bJournalLineId, touch as never);
    });

    it('INSERT: caller-supplied tenant keys are refused', async () => {
      const forged = { etsyOrderId: 'x', orderDate: new Date(), netPayableAmount: '1', currency: 'USD', accountId: b.tenant.accountId };
      await expect(scopeA().insert(orders, [forged as never])).rejects.toBeInstanceOf(TenantScopeViolationError);
    });

    it('INSERT: the database refuses rows that link to another tenant’s parents (composite FKs)', async () => {
      const ownOrder = await makeOrder(app, a);
      const ownSupplier = (await makeSupplier(app, a)).id;
      const ownDraft = await makeDraftPurchase(app, a, ownSupplier, ownOrder);
      const fk = async (run: () => Promise<unknown>) => getPostgresErrorCode(await run().then(() => null, (error: unknown) => error));

      expect(await fk(() => scopeA().insert(supplierPurchaseItems, [{
        supplierPurchaseId: ownDraft.purchase.id, orderItemId: bOrder.items[0]?.id ?? '', quantity: 1, unitCost: '1', totalCost: '1', currency: 'USD',
      }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      expect(await fk(() => scopeA().insert(supplierPurchases, [{ supplierId: bSupplierId, totalAmount: '1', currency: 'USD' }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      expect(await fk(() => scopeA().insert(orderItems, [{ orderId: ownOrder.order.id, productId: bProductId, productNameSnapshot: 'x', quantity: 1 }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      expect(await fk(() => scopeA().insert(orderItems, [{ orderId: bOrder.order.id, productNameSnapshot: 'x', quantity: 1 }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      const bAccount = (await raw`SELECT id FROM financial_accounts WHERE account_id = ${b.tenant.accountId} AND account_role = 'SUPPLIER_COST'`)[0]?.id as string;
      const ownEntry = (await scopeA().insert(journalEntries, [{
        sourceType: 'adjustment', sourceId: crypto.randomUUID(), sourceEvent: 'MANUAL', currency: 'USD', transactionDate: new Date(), idempotencyKey: `iso-${crypto.randomUUID()}`, status: 'DRAFT',
      }]))[0];
      expect(await fk(() => scopeA().insert(journalLines, [{ journalEntryId: ownEntry?.id ?? '', financialAccountId: bAccount, debitAmount: '1', creditAmount: '0', currency: 'USD' }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      await scopeA().delete(journalEntries, eq(journalEntries.id, ownEntry?.id ?? ''));
    });
  });
});
