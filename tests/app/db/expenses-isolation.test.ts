import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { expenseCategories, expenses } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { findExpenseCategoryById, listExpenseCategoriesByName } from '@/server/dal/expense-categories';
import { findExpenseDetailRow, findExpenseForUpdate, listExpenses, listExpensesForOrder } from '@/server/dal/expenses';
import { lockOrdersForUpdate } from '@/server/dal/orders';
import { expenseSummaryByOrder } from '@/server/dal/order-profit';
import { tenantScope, TenantScopeViolationError, type TenantTable, type TenantUpdate } from '@/server/dal/tenant-scope';
import { getPostgresErrorCode, PG_FOREIGN_KEY_VIOLATION } from '@/server/db/errors';
import { confirmExpense, type ExpenseDetail } from '@/server/expenses/service';
import type { OrderDetail } from '@/server/orders/service';
import { hasTestDatabase } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, registerAndSignIn, type ApiCallOptions, type OnboardedUser } from '../support/app';
import { EXPENSE_DATE, journalOfExpense, linesOfEntry, makeDirectExpense, makeSharedExpense } from '../support/expenses';
import { makeOrder, openRaw } from '../support/phase2';

const MISSING = '00000000-0000-4000-8000-0000000000fe';

describe.skipIf(!hasTestDatabase)('expenses tenant isolation', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let a: OnboardedUser;
  let b: OnboardedUser;
  let bOrder: OrderDetail;
  let bDraft: ExpenseDetail;
  let bConfirmed: ExpenseDetail;
  let bShared: ExpenseDetail;
  let bCategoryId: string;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    a = await registerAndOnboard(app, 'Expense Isolation A', 'expiso-a');
    b = await registerAndOnboard(app, 'Expense Isolation B', 'expiso-b');
    bOrder = await makeOrder(app, b);
    bDraft = await makeDirectExpense(app, b, bOrder, { amount: '1.11' });
    bConfirmed = await makeDirectExpense(app, b, bOrder, { amount: '2.22' });
    await confirmExpense(app.db, b.tenant, bConfirmed.expense.id);
    bShared = await makeSharedExpense(app, b, { amount: '3.33' });
    bCategoryId = (await raw`SELECT id FROM expense_categories WHERE account_id = ${b.tenant.accountId} AND category_type = 'SHIPPING'`)[0]?.id as string;
    // A has its own data, so "empty" is never the reason a request looks isolated.
    const aOrder = await makeOrder(app, a);
    await makeDirectExpense(app, a, aOrder, { amount: '9.99' });
    await makeSharedExpense(app, a, { amount: '8.88' });
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  type Handler = Parameters<typeof callRoute>[0];
  const call = (handler: Handler, who: OnboardedUser | null, path: string, options: ApiCallOptions = {}, params: Record<string, string> = {}) =>
    callRoute(handler, apiRequest(app, path, { cookie: who?.cookie, ...options }), params);
  async function snapshot(response: Response) {
    return { status: response.status, body: await response.json() };
  }

  const snapshotBState = async () => ({
    expenses: await raw`SELECT id, status, amount::text AS amount, description FROM expenses WHERE account_id = ${b.tenant.accountId} ORDER BY id`,
    categories: await raw`SELECT id, name, category_type, is_active FROM expense_categories WHERE account_id = ${b.tenant.accountId} ORDER BY id`,
    accounts: await raw`SELECT id, name, is_active FROM financial_accounts WHERE account_id = ${b.tenant.accountId} ORDER BY id`,
    journals: Number((await raw`SELECT count(*)::int AS n FROM journal_entries WHERE account_id = ${b.tenant.accountId}`)[0]?.n),
    audits: Number((await raw`SELECT count(*)::int AS n FROM audit_logs WHERE account_id = ${b.tenant.accountId}`)[0]?.n),
  });

  describe('API: another tenant looks exactly like a missing record', () => {
    it('reads', async () => {
      for (const id of [bDraft.expense.id, bConfirmed.expense.id, bShared.expense.id]) {
        const foreign = await snapshot(await call(routes.expenses.get, a, `/api/v1/expenses/${id}`, {}, { expenseId: id }));
        const missing = await snapshot(await call(routes.expenses.get, a, `/api/v1/expenses/${MISSING}`, {}, { expenseId: MISSING }));
        expect(foreign.status).toBe(404);
        expect(foreign).toEqual(missing);
      }
    });

    it.each([
      ['confirm', 'confirm', undefined],
      ['void', 'void', undefined],
      ['reverse', 'reverse', { reason: 'hijack' }],
    ] as const)('%s changes nothing and answers like a missing record', async (_label, name, body) => {
      const handler = routes.expenses[name] as Handler;
      for (const id of [bDraft.expense.id, bConfirmed.expense.id, bShared.expense.id]) {
        const before = await snapshotBState();
        const foreign = await snapshot(await call(handler, a, `/api/v1/expenses/${id}/${name}`, { method: 'POST', body }, { expenseId: id }));
        const missing = await snapshot(await call(handler, a, `/api/v1/expenses/${MISSING}/${name}`, { method: 'POST', body }, { expenseId: MISSING }));
        expect(foreign.status).toBe(404);
        expect(foreign).toEqual(missing);
        expect(await snapshotBState()).toEqual(before);
      }
    });

    it('lists show only the caller’s own rows, and the order detail never shows another tenant’s expenses', async () => {
      const ids = new Set([bDraft.expense.id, bConfirmed.expense.id, bShared.expense.id]);
      const aList = await (await call(routes.expenses.list, a, '/api/v1/expenses', { query: '?limit=100' })).json();
      expect(aList.items.some((item: { id: string }) => ids.has(item.id))).toBe(false);
      expect(aList.page.total).toBe(aList.items.length);
      expect(aList.items.length).toBeGreaterThan(0);
      const bList = await (await call(routes.expenses.list, b, '/api/v1/expenses', { query: '?limit=100' })).json();
      expect(bList.items.map((item: { id: string }) => item.id).sort()).toEqual([...ids].sort());
      // B's order is invisible to A (404 like a missing order), and B's own view lists its expenses.
      const foreignOrder = await snapshot(await call(routes.orders.get, a, `/api/v1/orders/${bOrder.order.id}`, {}, { orderId: bOrder.order.id }));
      const missingOrder = await snapshot(await call(routes.orders.get, a, `/api/v1/orders/${MISSING}`, {}, { orderId: MISSING }));
      expect(foreignOrder.status).toBe(404);
      expect(foreignOrder).toEqual(missingOrder);
      const own = await (await call(routes.orders.get, b, `/api/v1/orders/${bOrder.order.id}`, {}, { orderId: bOrder.order.id })).json();
      expect(own.expenses.map((expense: { expenseId: string }) => expense.expenseId).sort()).toEqual([bDraft.expense.id, bConfirmed.expense.id].sort());
      expect(own.profit).toMatchObject({ confirmedDirectExpenses: '2.22', draftDirectExpenses: '1.11' });
    });
  });

  describe('API: references to another tenant’s records are rejected like unknown IDs', () => {
    it('a DIRECT expense on another tenant’s order answers 422 exactly like an unknown order, and creates nothing', async () => {
      const before = await snapshotBState();
      const aExpenses = Number((await raw`SELECT count(*)::int AS n FROM expenses WHERE account_id = ${a.tenant.accountId}`)[0]?.n);
      const body = (orderId: string) => ({ expenseType: 'DIRECT', orderId, categoryType: 'SHIPPING', amount: '5.00', expenseDate: EXPENSE_DATE });
      const foreign = await snapshot(await call(routes.expenses.create, a, '/api/v1/expenses', { method: 'POST', body: body(bOrder.order.id) }));
      const missing = await snapshot(await call(routes.expenses.create, a, '/api/v1/expenses', { method: 'POST', body: body(MISSING) }));
      expect(foreign.status).toBe(422);
      expect(foreign.body.error).toMatchObject({ code: 'ORDER_NOT_FOUND', fields: ['orderId'] });
      expect(foreign).toEqual(missing);
      expect(Number((await raw`SELECT count(*)::int AS n FROM expenses WHERE account_id = ${a.tenant.accountId}`)[0]?.n)).toBe(aExpenses);
      expect(await snapshotBState()).toEqual(before);
    });

    it('rejects forged tenant fields on every write endpoint with 400, never echoing the other tenant', async () => {
      const aOrder = await makeOrder(app, a);
      const own = await makeDirectExpense(app, a, aOrder);
      const forged = { accountId: b.tenant.accountId };
      const cases: Array<[string, Handler, string, Record<string, unknown>, Record<string, string>]> = [
        ['create', routes.expenses.create, '/api/v1/expenses', { expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE, ...forged }, {}],
        ['create tenantId', routes.expenses.create, '/api/v1/expenses', { expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE, tenantId: b.tenant.accountId }, {}],
        ['create ownerUserId', routes.expenses.create, '/api/v1/expenses', { expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE, ownerUserId: b.session.userId }, {}],
        ['create categoryId', routes.expenses.create, '/api/v1/expenses', { expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE, categoryId: bCategoryId }, {}],
        ['reverse', routes.expenses.reverse, `/api/v1/expenses/${own.expense.id}/reverse`, { reason: 'x', account_id: b.tenant.accountId }, { expenseId: own.expense.id }],
      ];
      for (const [label, handler, path, body, params] of cases) {
        const response = await call(handler, a, path, { method: 'POST', body }, params);
        const json = await response.json();
        expect(response.status, label).toBe(400);
        expect(JSON.stringify(json.error.fields), label).toMatch(/accountId|tenantId|ownerUserId|account_id|categoryId/);
        expect(JSON.stringify(json), label).not.toContain(b.tenant.accountId);
      }
    });

    it('A’s confirmation posts only to A’s own accounts, never to B’s', async () => {
      const aOrder = await makeOrder(app, a);
      const mine = await makeDirectExpense(app, a, aOrder, { amount: '4.00' });
      await confirmExpense(app.db, a.tenant, mine.expense.id);
      const [entry] = await journalOfExpense(raw, a.tenant.accountId, mine.expense.id);
      expect(await linesOfEntry(raw, entry?.id as string)).toHaveLength(2);
      expect(await raw`SELECT 1 FROM journal_lines l JOIN financial_accounts fa ON fa.id = l.financial_account_id WHERE l.journal_entry_id = ${entry?.id} AND fa.account_id <> ${a.tenant.accountId}`).toHaveLength(0);
      const payables = await raw`SELECT account_id, id FROM financial_accounts WHERE name = 'Expenses Payable' AND account_id IN (${a.tenant.accountId}, ${b.tenant.accountId})`;
      expect(payables).toHaveLength(2);
      expect(new Set(payables.map((row) => row.id)).size).toBe(2);
    });
  });

  describe('API: authentication and Origin on every expense route', () => {
    const everyRoute = (): Array<[string, Handler, 'GET' | 'POST', string, Record<string, string>]> => [
      ['expenses list', routes.expenses.list, 'GET', '/api/v1/expenses', {}],
      ['expenses create', routes.expenses.create, 'POST', '/api/v1/expenses', {}],
      ['expense get', routes.expenses.get, 'GET', `/api/v1/expenses/${MISSING}`, { expenseId: MISSING }],
      ['expense confirm', routes.expenses.confirm, 'POST', `/api/v1/expenses/${MISSING}/confirm`, { expenseId: MISSING }],
      ['expense void', routes.expenses.void, 'POST', `/api/v1/expenses/${MISSING}/void`, { expenseId: MISSING }],
      ['expense reverse', routes.expenses.reverse, 'POST', `/api/v1/expenses/${MISSING}/reverse`, { expenseId: MISSING }],
    ];

    it('answers 401 without a session', async () => {
      for (const [label, handler, method, path, params] of everyRoute()) {
        const response = await call(handler, null, path, { method, body: method === 'GET' ? undefined : {} }, params);
        expect(response.status, label).toBe(401);
        expect(response.headers.get('cache-control'), label).toBe('private, no-store');
      }
    });

    it('answers 409 for a signed-in user who has not created a business', async () => {
      const fresh = await registerAndSignIn(app, 'expiso-fresh');
      for (const [label, handler, method, path, params] of everyRoute()) {
        const response = await callRoute(handler, apiRequest(app, path, { method, cookie: fresh.cookie, body: method === 'GET' ? undefined : {} }), params);
        expect(response.status, label).toBe(409);
      }
    });

    it('answers 403 to a state-changing request from another origin or without one, and changes nothing', async () => {
      const before = await snapshotBState();
      for (const [label, handler, method, path, params] of everyRoute().filter(([, , method]) => method !== 'GET')) {
        const response = await call(handler, b, path, { method, body: {}, origin: 'https://evil.example' }, params);
        expect(response.status, label).toBe(403);
      }
      const withoutOrigin = await call(routes.expenses.confirm, b, `/api/v1/expenses/${bDraft.expense.id}/confirm`, { method: 'POST', origin: null }, { expenseId: bDraft.expense.id });
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

    it('expenseCategories and expenses: select, update and delete answer like missing rows', async () => {
      await assertIsolated('expenseCategories', expenseCategories as never, bCategoryId, { isActive: false } as never);
      await assertIsolated('expenses', expenses as never, bDraft.expense.id, { description: 'hijack' } as never);
      await assertIsolated('expenses (confirmed)', expenses as never, bConfirmed.expense.id, { description: 'hijack' } as never);
      expect((await raw`SELECT is_active FROM expense_categories WHERE id = ${bCategoryId}`)[0]?.is_active).toBe(true);
      expect((await raw`SELECT description FROM expenses WHERE id = ${bDraft.expense.id}`)[0]?.description).toBeNull();
    });

    it('the expense data-access functions never see or lock another tenant’s rows', async () => {
      const scope = scopeA();
      expect(await findExpenseForUpdate(scope, bDraft.expense.id)).toBeNull();
      expect(await findExpenseDetailRow(scope, bConfirmed.expense.id)).toBeNull();
      expect(await findExpenseCategoryById(scope, bCategoryId)).toBeNull();
      expect(await listExpensesForOrder(scope, bOrder.order.id)).toEqual([]);
      expect((await listExpenses(scope, { limit: 100, offset: 0 })).some((row) => row.id === bDraft.expense.id)).toBe(false);
      expect(await lockOrdersForUpdate(scope, [bOrder.order.id])).toEqual([]);
      expect((await expenseSummaryByOrder(scope, [bOrder.order.id])).size).toBe(0);
      expect((await listExpenseCategoriesByName(scope, 'Shipping')).every((row) => row.accountId === a.tenant.accountId)).toBe(true);
      // The owner sees the same rows, so "nothing" above is isolation and not emptiness.
      const own = tenantScope(app.db, b.tenant);
      expect(await findExpenseDetailRow(own, bConfirmed.expense.id)).toMatchObject({ id: bConfirmed.expense.id, categoryName: 'Shipping' });
      expect((await expenseSummaryByOrder(own, [bOrder.order.id])).get(bOrder.order.id)).toEqual({ confirmedExpenses: '2.2200', draftExpenses: '1.1100' });
    });

    it('INSERT: caller-supplied tenant keys are refused', async () => {
      const forged = { categoryId: bCategoryId, expenseType: 'SHARED', amount: '1', currency: 'USD', expenseDate: new Date(), accountId: b.tenant.accountId };
      await expect(scopeA().insert(expenses, [forged as never])).rejects.toBeInstanceOf(TenantScopeViolationError);
      await expect(scopeA().insert(expenseCategories, [{ name: 'x', categoryType: 'SHIPPING', accountId: b.tenant.accountId } as never])).rejects.toBeInstanceOf(TenantScopeViolationError);
    });

    it('INSERT: the database refuses expenses that link to another tenant’s category or order (composite FKs)', async () => {
      const ownOrder = await makeOrder(app, a);
      const ownCategory = (await raw`SELECT id FROM expense_categories WHERE account_id = ${a.tenant.accountId} LIMIT 1`)[0]?.id as string;
      const fk = async (run: () => Promise<unknown>) => getPostgresErrorCode(await run().then(() => null, (error: unknown) => error));
      const base = { amount: '1', currency: 'USD', expenseDate: new Date(), status: 'DRAFT' as const };
      expect(await fk(() => scopeA().insert(expenses, [{ ...base, expenseType: 'SHARED', categoryId: bCategoryId, orderId: null }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      expect(await fk(() => scopeA().insert(expenses, [{ ...base, expenseType: 'DIRECT', categoryId: ownCategory, orderId: bOrder.order.id }]))).toBe(PG_FOREIGN_KEY_VIOLATION);
      // Control: the same insert with A's own parents succeeds, so the failures above are the tenant boundary.
      const [inserted] = await scopeA().insert(expenses, [{ ...base, expenseType: 'DIRECT', categoryId: ownCategory, orderId: ownOrder.order.id }]);
      expect(inserted?.accountId).toBe(a.tenant.accountId);
      await scopeA().delete(expenses, eq(expenses.id, inserted?.id ?? ''));
    });
  });
});
