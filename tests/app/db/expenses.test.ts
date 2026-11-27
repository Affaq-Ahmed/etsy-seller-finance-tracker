import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { instantToZonedDate } from '@/lib/dates';
import { parseDbMoney } from '@/lib/money';
import type { AppContainer } from '@/server/container';
import { confirmExpense, confirmExpenseInTransaction, createExpense, getExpenseDetail, reverseExpense, voidExpense } from '@/server/expenses/service';
import { NO_STORE } from '@/server/http/responses';
import { getOrderDetail, type OrderDetail } from '@/server/orders/service';
import { confirmPurchase } from '@/server/purchases/service';
import { hasTestDatabase, testDatabaseUrl } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import {
  confirmedDirectExpense, EXPENSE_DATE, journalOfExpense, linesOfEntry, makeDirectExpense, makeSharedExpense, netBalance,
} from '../support/expenses';
import { auditCount, journalEntryCount, makeDraftPurchase, makeOrder, makeSupplier, openRaw } from '../support/phase2';

const MISSING = '00000000-0000-4000-8000-0000000000aa';

describe.skipIf(!hasTestDatabase)('expenses', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let user: OnboardedUser;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    user = await registerAndOnboard(app, 'Expenses Shop', 'expenses');
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  const tenantId = () => user.tenant.accountId;
  const expenseRoute = (name: 'get' | 'confirm' | 'void' | 'reverse', id: string, options: { method?: 'GET' | 'POST'; body?: unknown; who?: OnboardedUser } = {}) =>
    callRoute(routes.expenses[name], apiRequest(app, `/api/v1/expenses/${id}`, { method: options.method ?? 'POST', cookie: (options.who ?? user).cookie, body: options.body }), { expenseId: id });
  const createViaApi = (body: unknown, who: OnboardedUser = user) =>
    routes.expenses.create(apiRequest(app, '/api/v1/expenses', { method: 'POST', cookie: who.cookie, body }));
  const orderDetail = (order: OrderDetail, who: OnboardedUser = user) => getOrderDetail(app.db, who.tenant, order.order.id);
  const errorOf = async (response: Response) => { const json = await response.json(); return [response.status, json.error.code, json.error.fields] as const; };
  const expenseCount = async (who: OnboardedUser = user) => Number((await raw`SELECT count(*)::int AS n FROM expenses WHERE account_id = ${who.tenant.accountId}`)[0]?.n);
  const categoryCount = async (who: OnboardedUser = user) => Number((await raw`SELECT count(*)::int AS n FROM expense_categories WHERE account_id = ${who.tenant.accountId}`)[0]?.n);
  const rowOf = async (id: string) => (await raw`SELECT status, amount::text AS amount, expense_type, order_id FROM expenses WHERE id = ${id}`)[0];

  describe('draft expenses post nothing', () => {
    it('creates a DIRECT draft through the API with an exact amount, a business-timezone date, an audit entry and no ledger effect', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const journals = await journalEntryCount(raw, tenantId());
      const response = await createViaApi({
        expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'SHIPPING', amount: '4.25', expenseDate: EXPENSE_DATE,
        description: 'Return postage', sourceReference: 'RCPT-1',
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      const body = await response.json();
      expect(body).toMatchObject({ canConfirm: true, canVoid: true, canReverse: false });
      expect(body.expense).toMatchObject({
        expenseType: 'DIRECT', orderId: order.order.id, etsyOrderId: order.order.etsyOrderId, categoryName: 'Shipping', categoryType: 'SHIPPING',
        amount: '4.25', currency: 'USD', expenseDate: EXPENSE_DATE, description: 'Return postage', sourceReference: 'RCPT-1',
        status: 'DRAFT', effectiveStatus: 'DRAFT', confirmedAt: null, confirmedDate: null,
      });
      expect(JSON.stringify(body)).not.toContain(tenantId());

      const [row] = await raw`SELECT amount::text AS amount, to_char(expense_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS utc FROM expenses WHERE id = ${body.expense.id}`;
      // Asia/Karachi (UTC+5) midnight of 2026-11-21 is 19:00 UTC the day before (ARCHITECTURE.md A29).
      expect(row).toMatchObject({ amount: '4.2500', utc: '2026-11-20T19:00' });
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await journalOfExpense(raw, tenantId(), body.expense.id)).toHaveLength(0);

      const [audit] = await raw`SELECT before_data, after_data FROM audit_logs WHERE account_id = ${tenantId()} AND entity_type = 'expense' AND action = 'CREATE' AND entity_id = ${body.expense.id}`;
      expect(audit?.before_data).toBeNull();
      expect(audit?.after_data).toMatchObject({ status: 'DRAFT', expenseType: 'DIRECT', orderId: order.order.id, amount: '4.2500', currency: 'USD' });
      // Free text is never copied into audit data.
      expect(JSON.stringify(audit)).not.toContain('Return postage');
      expect(JSON.stringify(audit)).not.toContain('RCPT-1');

      // A draft is shown on the order but never counted.
      expect((await orderDetail(order)).profit).toMatchObject({
        confirmedDirectExpenses: '0.00', draftDirectExpenses: '4.25', directProfitBeforeRefunds: '100.00', includesExpenses: true, includesRefunds: false,
      });
    });

    it('creates a SHARED draft with no order, and stores a blank description as null', async () => {
      const response = await createViaApi({ expenseType: 'SHARED', categoryType: 'SOFTWARE_SUBSCRIPTION', amount: '19.99', expenseDate: EXPENSE_DATE, description: '   ' });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.expense).toMatchObject({ expenseType: 'SHARED', orderId: null, etsyOrderId: null, categoryName: 'Software subscriptions', description: null, sourceReference: null });
      expect((await rowOf(body.expense.id))?.order_id).toBeNull();
    });

    it('creates the fixed category row lazily, once, with an audit entry, and reuses it', async () => {
      const fresh = await registerAndOnboard(app, 'Lazy Category Shop', 'expenses-lazycat');
      expect(await categoryCount(fresh)).toBe(0);
      await makeSharedExpense(app, fresh, { categoryType: 'ADVERTISING' });
      await makeSharedExpense(app, fresh, { categoryType: 'ADVERTISING' });
      const rows = await raw`SELECT id, name, category_type, is_active FROM expense_categories WHERE account_id = ${fresh.tenant.accountId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Etsy advertisements', category_type: 'ADVERTISING', is_active: true });
      const audits = await raw`SELECT after_data FROM audit_logs WHERE account_id = ${fresh.tenant.accountId} AND entity_type = 'expense_category' AND action = 'CREATE'`;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.after_data).toMatchObject({ name: 'Etsy advertisements', categoryType: 'ADVERTISING', reason: 'expense_category_first_use' });
      await makeSharedExpense(app, fresh, { categoryType: 'MISCELLANEOUS' });
      expect(await categoryCount(fresh)).toBe(2);
    });

    it('two parallel first uses of a category create one row and one audit entry', async () => {
      const fresh = await registerAndOnboard(app, 'Parallel Category Shop', 'expenses-parcat');
      await Promise.all(Array.from({ length: 4 }, () => makeSharedExpense(app, fresh, { categoryType: 'SHIPPING' })));
      expect(await categoryCount(fresh)).toBe(1);
      expect(await auditCount(raw, fresh.tenant.accountId, 'expense_category', 'CREATE')).toBe(1);
      expect(await expenseCount(fresh)).toBe(4);
    });

    it('rejects invalid input with 400 naming fields only, and creates nothing', async () => {
      const order = await makeOrder(app, user);
      const base = { expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '5.00', expenseDate: EXPENSE_DATE };
      const direct = { ...base, expenseType: 'DIRECT', orderId: order.order.id };
      const before = [await expenseCount(), await categoryCount()];
      const cases: Array<[string, unknown, string[]]> = [
        ['DIRECT without an order', { ...base, expenseType: 'DIRECT' }, ['orderId']],
        ['SHARED with an order', { ...base, orderId: order.order.id }, ['orderId']],
        ['a malformed order ID', { ...direct, orderId: 'not-a-uuid' }, ['orderId']],
        ['a JSON number amount', { ...base, amount: 5 }, ['amount']],
        ['three decimals', { ...base, amount: '1.005' }, ['amount']],
        ['a negative amount', { ...base, amount: '-1.00' }, ['amount']],
        ['above the maximum', { ...base, amount: '1000000000000.00' }, ['amount']],
        ['an exponent', { ...base, amount: '1e2' }, ['amount']],
        ['an impossible date', { ...base, expenseDate: '2026-02-30' }, ['expenseDate']],
        ['an unknown category type', { ...base, categoryType: 'CUSTOM' }, ['categoryType']],
        ['a lowercase category type', { ...base, categoryType: 'shipping' }, ['categoryType']],
        ['an email in the description', { ...base, description: 'paid by jane@example.com' }, ['description']],
        ['a phone number in the description', { ...base, description: 'call +1 202 555 0143' }, ['description']],
        ['a reference with spaces', { ...base, sourceReference: 'has spaces' }, ['sourceReference']],
        ['an over-long description', { ...base, description: 'x'.repeat(2001) }, ['description']],
        ['an unknown key', { ...base, status: 'CONFIRMED' }, ['status']],
        ['a lowercase currency', { ...base, currency: 'usd' }, ['currency']],
        ['a missing category type', { expenseType: 'SHARED', amount: '5.00', expenseDate: EXPENSE_DATE }, ['categoryType']],
      ];
      for (const [label, body, fields] of cases) {
        const response = await createViaApi(body);
        const text = JSON.stringify(await response.json());
        expect(response.status, label).toBe(400);
        expect(text, label).toContain('INVALID_REQUEST');
        for (const field of fields) expect(text, label).toContain(field);
        expect(text, label).not.toContain('jane@example.com');
        expect(text, label).not.toContain('555 0143');
      }
      expect([await expenseCount(), await categoryCount()]).toEqual(before);
    });

    it('answers 422 for a zero amount, an unknown order, a foreign currency and a mismatched order currency, creating nothing', async () => {
      const order = await makeOrder(app, user);
      const before = [await expenseCount(), await categoryCount()];
      const shared = { expenseType: 'SHARED', categoryType: 'SHIPPING', expenseDate: EXPENSE_DATE };
      expect(await errorOf(await createViaApi({ ...shared, amount: '0' }))).toEqual([422, 'EXPENSE_AMOUNT_REQUIRED', ['amount']]);
      expect(await errorOf(await createViaApi({ ...shared, amount: '0.00' }))).toEqual([422, 'EXPENSE_AMOUNT_REQUIRED', ['amount']]);
      expect(await errorOf(await createViaApi({ ...shared, amount: '1.00', currency: 'PKR' }))).toEqual([422, 'CURRENCY_NOT_SUPPORTED', ['currency']]);
      expect(await errorOf(await createViaApi({ ...shared, expenseType: 'DIRECT', orderId: MISSING, amount: '1.00' }))).toEqual([422, 'ORDER_NOT_FOUND', ['orderId']]);
      await raw`UPDATE orders SET currency = 'PKR' WHERE id = ${order.order.id}`;
      expect(await errorOf(await createViaApi({ ...shared, expenseType: 'DIRECT', orderId: order.order.id, amount: '1.00' }))).toEqual([422, 'CURRENCY_MISMATCH', ['currency']]);
      await raw`UPDATE orders SET currency = 'USD' WHERE id = ${order.order.id}`;
      expect([await expenseCount(), await categoryCount()]).toEqual(before);
    });

    it('voids a draft: nothing is posted, a repeat is a no-op, and the voided expense never counts', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '50.00' });
      const draft = await makeDirectExpense(app, user, order);
      const journals = await journalEntryCount(raw, tenantId());
      const voided = await expenseRoute('void', draft.expense.id);
      expect(voided.status).toBe(200);
      expect(await voided.json()).toMatchObject({ expense: { status: 'VOIDED', effectiveStatus: 'VOIDED' }, canConfirm: false, canVoid: false, canReverse: false });
      const repeat = await expenseRoute('void', draft.expense.id);
      expect(repeat.status).toBe(200);
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await auditCount(raw, tenantId(), 'expense', 'VOID', draft.expense.id)).toBe(1);
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '0.00', draftDirectExpenses: '0.00', directProfitBeforeRefunds: '50.00' });
      expect(await errorOf(await expenseRoute('confirm', draft.expense.id))).toEqual([409, 'EXPENSE_NOT_CONFIRMABLE', undefined]);
      expect(await errorOf(await expenseRoute('reverse', draft.expense.id, { body: { reason: 'x' } }))).toEqual([409, 'EXPENSE_NOT_CONFIRMED', undefined]);
      expect((await rowOf(draft.expense.id))?.status).toBe('VOIDED');
    });
  });

  describe('confirmation posts exactly once', () => {
    it('posts DEBIT the role-correct expense account and CREDIT Expenses Payable, dated at the expense date, touching nothing else', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDirectExpense(app, user, order, { description: 'Return postage' });
      const response = await expenseRoute('confirm', draft.expense.id);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.alreadyConfirmed).toBe(false);
      expect(body).toMatchObject({ canConfirm: false, canVoid: false, canReverse: true, expense: { status: 'CONFIRMED', effectiveStatus: 'CONFIRMED' } });

      const entries = await journalOfExpense(raw, tenantId(), draft.expense.id);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry).toMatchObject({
        status: 'FINALIZED', source_type: 'expense', source_event: 'INITIAL', currency: 'USD', description: 'Expense confirmed',
        idempotency_key: `expense:${draft.expense.id}:INITIAL`,
      });
      expect(new Date(entry?.transaction_date as string).toISOString()).toBe('2026-11-20T19:00:00.000Z');
      const lines = await linesOfEntry(raw, entry?.id as string);
      expect(lines).toEqual([
        { name: 'Direct Expenses', account_role: 'DIRECT_EXPENSE', account_type: 'EXPENSE', debit: '4.2500', credit: '0.0000' },
        { name: 'Expenses Payable', account_role: 'UNCLASSIFIED', account_type: 'LIABILITY', debit: '0.0000', credit: '4.2500' },
      ]);
      expect(JSON.stringify(entry)).not.toContain('Return postage');

      // The view derives the confirmation instant from the finalized entry, in the business timezone.
      const [stamp] = await raw`SELECT to_json(finalized_at) #>> '{}' AS at FROM journal_entries WHERE id = ${entry?.id}`;
      expect(body.expense.confirmedAt).toBe(new Date(stamp?.at as string).toISOString());
      expect(body.expense.confirmedDate).toBe(instantToZonedDate(new Date(stamp?.at as string), 'Asia/Karachi'));

      const [audit] = await raw`SELECT before_data, after_data FROM audit_logs WHERE account_id = ${tenantId()} AND entity_type = 'expense' AND action = 'CONFIRM' AND entity_id = ${draft.expense.id}`;
      expect(audit?.before_data).toEqual({ status: 'DRAFT' });
      expect(audit?.after_data).toMatchObject({ status: 'CONFIRMED', journalEntryId: entry?.id, amount: '4.2500', currency: 'USD' });
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '4.25', draftDirectExpenses: '0.00', directProfitBeforeRefunds: '95.75' });
    });

    it('posts a SHARED expense to the shared expense account, never into any order profit, and never to PAYONEER, Supplier Payable or supplier costs', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const payoneerBefore = await netBalance(raw, tenantId(), 'account_role', 'PAYONEER');
      const supplierPayableBefore = await netBalance(raw, tenantId(), 'name', 'Supplier Payable');
      const supplierCostBefore = await netBalance(raw, tenantId(), 'account_role', 'SUPPLIER_COST');
      const draft = await makeSharedExpense(app, user, { amount: '19.99' });
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      const [entry] = await journalOfExpense(raw, tenantId(), draft.expense.id);
      expect(await linesOfEntry(raw, entry?.id as string)).toEqual([
        { name: 'Shared Expenses', account_role: 'SHARED_EXPENSE', account_type: 'EXPENSE', debit: '19.9900', credit: '0.0000' },
        { name: 'Expenses Payable', account_role: 'UNCLASSIFIED', account_type: 'LIABILITY', debit: '0.0000', credit: '19.9900' },
      ]);
      expect(await netBalance(raw, tenantId(), 'account_role', 'PAYONEER')).toBe(payoneerBefore);
      expect(await netBalance(raw, tenantId(), 'name', 'Supplier Payable')).toBe(supplierPayableBefore);
      expect(await netBalance(raw, tenantId(), 'account_role', 'SUPPLIER_COST')).toBe(supplierCostBefore);
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '0.00', draftDirectExpenses: '0.00', directProfitBeforeRefunds: '100.00' });
      const detail = await getExpenseDetail(app.db, user.tenant, draft.expense.id);
      expect(detail.expense).toMatchObject({ effectiveStatus: 'CONFIRMED', orderId: null, etsyOrderId: null });
    });

    it('creates Expenses Payable lazily (it is not in the starter chart), once, audited, even under parallel first confirmations', async () => {
      const fresh = await registerAndOnboard(app, 'Lazy Payable Shop', 'expenses-lazypay');
      const payable = () => raw`SELECT account_type, account_role, currency, is_active FROM financial_accounts WHERE account_id = ${fresh.tenant.accountId} AND name = 'Expenses Payable'`;
      expect(await payable()).toHaveLength(0);
      const [first, second] = await Promise.all([makeSharedExpense(app, fresh), makeSharedExpense(app, fresh, { amount: '3.00' })]);
      expect(await payable()).toHaveLength(0);
      const results = await Promise.all([confirmExpense(app.db, fresh.tenant, first.expense.id), confirmExpense(app.db, fresh.tenant, second.expense.id)]);
      expect(results.map((result) => result.alreadyConfirmed)).toEqual([false, false]);
      const accounts = await payable();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ account_type: 'LIABILITY', account_role: 'UNCLASSIFIED', currency: 'USD', is_active: true });
      // 11 starter accounts audited at onboarding plus exactly one lazy creation.
      expect(await auditCount(raw, fresh.tenant.accountId, 'financial_account', 'CREATE')).toBe(12);
      const reasons = await raw`SELECT after_data FROM audit_logs WHERE account_id = ${fresh.tenant.accountId} AND entity_type = 'financial_account' AND after_data->>'reason' = 'expenses_payable_backfill'`;
      expect(reasons).toHaveLength(1);
      expect(await netBalance(raw, fresh.tenant.accountId, 'name', 'Expenses Payable')).toBe(parseDbMoney('-22.99'));
    });

    it('a repeated confirmation writes nothing and returns the same posting', async () => {
      const draft = await makeSharedExpense(app, user);
      const first = await confirmExpense(app.db, user.tenant, draft.expense.id);
      const audits = await auditCount(raw, tenantId(), 'expense', 'CONFIRM', draft.expense.id);
      const journals = await journalEntryCount(raw, tenantId());
      const second = await confirmExpense(app.db, user.tenant, draft.expense.id);
      const viaApi = await (await expenseRoute('confirm', draft.expense.id)).json();
      expect([first.alreadyConfirmed, second.alreadyConfirmed, viaApi.alreadyConfirmed]).toEqual([false, true, true]);
      expect(second.journalEntryId).toBe(first.journalEntryId);
      expect(second.detail.expense.confirmedAt).toBe(first.detail.expense.confirmedAt);
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await auditCount(raw, tenantId(), 'expense', 'CONFIRM', draft.expense.id)).toBe(audits);
    });

    it('parallel confirmations create exactly one posting and every caller succeeds', async () => {
      const draft = await makeSharedExpense(app, user, { amount: '2.50' });
      const results = await Promise.all(Array.from({ length: 8 }, () => confirmExpense(app.db, user.tenant, draft.expense.id)));
      expect(results.filter((result) => !result.alreadyConfirmed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.journalEntryId)).size).toBe(1);
      expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(1);
      expect(await auditCount(raw, tenantId(), 'expense', 'CONFIRM', draft.expense.id)).toBe(1);
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
      const draft = await makeSharedExpense(app, user, { amount: '1.10' });
      const firstWriter = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await firstWriter`BEGIN`;
        const first = await confirmExpenseInTransaction(drizzle(firstWriter, { schema }), user.tenant, draft.expense.id);
        expect(first.alreadyConfirmed).toBe(false);
        const second = confirmExpense(app.db, user.tenant, draft.expense.id);
        await waitForLockWait();
        await (outcome === 'COMMIT' ? firstWriter`COMMIT` : firstWriter`ROLLBACK`);
        const result = await second;
        expect(result.alreadyConfirmed).toBe(secondIsAlreadyConfirmed);
        expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(1);
        expect(await auditCount(raw, tenantId(), 'expense', 'CONFIRM', draft.expense.id)).toBe(1);
      } finally {
        await firstWriter.end();
      }
    });

    it('confirm racing void over 20 rounds ends in exactly one consistent outcome and never a half state', async () => {
      const outcomes = { confirmed: 0, voided: 0 };
      for (let round = 0; round < 20; round++) {
        const draft = await makeSharedExpense(app, user, { amount: '0.50' });
        const [confirmResult, voidResult] = await Promise.allSettled([
          confirmExpense(app.db, user.tenant, draft.expense.id),
          voidExpense(app.db, user.tenant, draft.expense.id),
        ]);
        const journals = (await journalOfExpense(raw, tenantId(), draft.expense.id)).length;
        const status = (await rowOf(draft.expense.id))?.status;
        if (confirmResult.status === 'fulfilled') {
          outcomes.confirmed++;
          expect(voidResult, `round ${round}`).toMatchObject({ status: 'rejected', reason: { code: 'EXPENSE_NOT_VOIDABLE' } });
          expect([status, journals], `round ${round}`).toEqual(['CONFIRMED', 1]);
        } else {
          outcomes.voided++;
          expect(voidResult.status, `round ${round}`).toBe('fulfilled');
          expect(confirmResult.reason, `round ${round}`).toMatchObject({ code: 'EXPENSE_NOT_CONFIRMABLE' });
          expect([status, journals], `round ${round}`).toEqual(['VOIDED', 0]);
        }
      }
      expect(outcomes.confirmed + outcomes.voided).toBe(20);
    });
  });

  describe('atomic rollback and fail-closed account resolution', () => {
    it('a posting failure leaves the expense a draft with no journal or audit, creates no account, and a retry works', async () => {
      const fresh = await registerAndOnboard(app, 'Rollback Shop', 'expenses-rollback');
      const accountId = fresh.tenant.accountId;
      const draft = await makeSharedExpense(app, fresh);
      const blockerId = crypto.randomUUID();
      // Occupy the idempotency key so the posting insert fails after the status update and the lazy account creation.
      await raw`INSERT INTO journal_entries(id, account_id, source_type, source_id, source_event, currency, transaction_date, idempotency_key)
        VALUES (${blockerId}, ${accountId}, 'adjustment', ${crypto.randomUUID()}, 'MANUAL', 'USD', now(), ${`expense:${draft.expense.id}:INITIAL`})`;

      const failed = await expenseRoute('confirm', draft.expense.id, { who: fresh });
      expect([failed.status, (await failed.json()).error.code]).toEqual([409, 'CONFLICT']);
      expect((await rowOf(draft.expense.id))?.status).toBe('DRAFT');
      expect(await journalOfExpense(raw, accountId, draft.expense.id)).toHaveLength(0);
      expect(await auditCount(raw, accountId, 'expense', 'CONFIRM', draft.expense.id)).toBe(0);
      expect(await raw`SELECT 1 FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`).toHaveLength(0);
      expect(await auditCount(raw, accountId, 'financial_account', 'CREATE')).toBe(11);

      await raw`DELETE FROM journal_entries WHERE id = ${blockerId}`;
      const retry = await expenseRoute('confirm', draft.expense.id, { who: fresh });
      expect(retry.status).toBe(200);
      expect((await retry.json()).alreadyConfirmed).toBe(false);
      expect(await journalOfExpense(raw, accountId, draft.expense.id)).toHaveLength(1);
      expect(await raw`SELECT 1 FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`).toHaveLength(1);
    });

    it.each([
      ['DIRECT', 'DIRECT_EXPENSE'],
      ['SHARED', 'SHARED_EXPENSE'],
    ] as const)('fails closed when the %s expense account is inactive or ambiguous, changing nothing', async (type, role) => {
      const fresh = await registerAndOnboard(app, `Account ${type} Shop`, `expenses-acct-${type.toLowerCase()}`);
      const accountId = fresh.tenant.accountId;
      const order = await makeOrder(app, fresh);
      const draft = type === 'DIRECT' ? await makeDirectExpense(app, fresh, order) : await makeSharedExpense(app, fresh);
      const expectUnavailable = async () => {
        const response = await expenseRoute('confirm', draft.expense.id, { who: fresh });
        expect(await errorOf(response)).toEqual([422, 'LEDGER_ACCOUNT_UNAVAILABLE', undefined]);
        expect((await rowOf(draft.expense.id))?.status).toBe('DRAFT');
        expect(await journalOfExpense(raw, accountId, draft.expense.id)).toHaveLength(0);
        expect(await auditCount(raw, accountId, 'expense', 'CONFIRM', draft.expense.id)).toBe(0);
        expect(await raw`SELECT 1 FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`).toHaveLength(0);
      };
      await raw`UPDATE financial_accounts SET is_active = false WHERE account_id = ${accountId} AND account_role = ${role}`;
      await expectUnavailable();
      await raw`UPDATE financial_accounts SET is_active = true WHERE account_id = ${accountId} AND account_role = ${role}`;
      await raw`INSERT INTO financial_accounts(account_id, name, account_type, account_role, currency) VALUES (${accountId}, 'Second expense account', 'EXPENSE', ${role}, 'USD')`;
      await expectUnavailable();
      await raw`DELETE FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Second expense account'`;
      expect((await expenseRoute('confirm', draft.expense.id, { who: fresh })).status).toBe(200);
    });

    it('fails closed when Expenses Payable is inactive, a same-named account has another type, or two exist', async () => {
      const fresh = await registerAndOnboard(app, 'Payable Conflict Shop', 'expenses-payconf');
      const accountId = fresh.tenant.accountId;
      const draft = await makeSharedExpense(app, fresh);
      const expectUnavailable = async () => {
        expect(await errorOf(await expenseRoute('confirm', draft.expense.id, { who: fresh }))).toEqual([422, 'LEDGER_ACCOUNT_UNAVAILABLE', undefined]);
        expect((await rowOf(draft.expense.id))?.status).toBe('DRAFT');
        expect(await journalOfExpense(raw, accountId, draft.expense.id)).toHaveLength(0);
      };
      // A same-named ASSET account (never credited, never retyped) blocks creation of the liability.
      await raw`INSERT INTO financial_accounts(account_id, name, account_type, account_role, currency) VALUES (${accountId}, 'Expenses Payable', 'ASSET', 'UNCLASSIFIED', 'USD')`;
      await expectUnavailable();
      await raw`DELETE FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`;
      // An inactive liability of that name also blocks it.
      await raw`INSERT INTO financial_accounts(account_id, name, account_type, account_role, currency, is_active) VALUES (${accountId}, 'Expenses Payable', 'LIABILITY', 'UNCLASSIFIED', 'USD', false)`;
      await expectUnavailable();
      await raw`DELETE FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`;
      expect((await expenseRoute('confirm', draft.expense.id, { who: fresh })).status).toBe(200);
      // Credits never went to Supplier Payable or PAYONEER.
      expect(await netBalance(raw, accountId, 'name', 'Supplier Payable')).toBe(BigInt(0));
      expect(await netBalance(raw, accountId, 'account_role', 'PAYONEER')).toBe(BigInt(0));
    });
  });

  describe('the Payoneer-fee block and category safety', () => {
    it('rejects the reserved PAYONEER_FEE type at create with 422, creating no expense and no category', async () => {
      const fresh = await registerAndOnboard(app, 'Payoneer Block Shop', 'expenses-pblock');
      const response = await createViaApi({ expenseType: 'SHARED', categoryType: 'PAYONEER_FEE', amount: '2.00', expenseDate: EXPENSE_DATE }, fresh);
      expect(await errorOf(response)).toEqual([422, 'PAYONEER_FEE_NOT_ALLOWED', ['categoryType']]);
      await expect(makeSharedExpense(app, fresh, { categoryType: 'PAYONEER_FEE' })).rejects.toMatchObject({ code: 'PAYONEER_FEE_NOT_ALLOWED' });
      expect(await expenseCount(fresh)).toBe(0);
      expect(await categoryCount(fresh)).toBe(0);
    });

    it('re-reads the stored category type at confirmation and fails closed for PAYONEER_FEE, unknown types and inactive rows', async () => {
      const fresh = await registerAndOnboard(app, 'Retype Shop', 'expenses-retype');
      const accountId = fresh.tenant.accountId;
      const draft = await makeSharedExpense(app, fresh, { categoryType: 'ADVERTISING' });
      const [category] = await raw`SELECT id FROM expense_categories WHERE account_id = ${accountId}`;
      const expectBlocked = async () => {
        expect(await errorOf(await expenseRoute('confirm', draft.expense.id, { who: fresh }))).toEqual([422, 'CATEGORY_NOT_USABLE', undefined]);
        expect((await rowOf(draft.expense.id))?.status).toBe('DRAFT');
        expect(await journalOfExpense(raw, accountId, draft.expense.id)).toHaveLength(0);
        expect(await auditCount(raw, accountId, 'expense', 'CONFIRM', draft.expense.id)).toBe(0);
      };
      await raw`UPDATE expense_categories SET category_type = 'PAYONEER_FEE' WHERE id = ${category?.id}`;
      await expectBlocked();
      await raw`UPDATE expense_categories SET category_type = 'SOMETHING_ELSE' WHERE id = ${category?.id}`;
      await expectBlocked();
      await raw`UPDATE expense_categories SET category_type = 'ADVERTISING', is_active = false WHERE id = ${category?.id}`;
      await expectBlocked();
      await raw`UPDATE expense_categories SET is_active = true WHERE id = ${category?.id}`;
      expect((await expenseRoute('confirm', draft.expense.id, { who: fresh })).status).toBe(200);
    });

    it('decides from the stored type only, never from names or descriptions', async () => {
      const fresh = await registerAndOnboard(app, 'Names Shop', 'expenses-names');
      // A description or reference that mentions Payoneer is just text: the type is what counts.
      const described = await makeSharedExpense(app, fresh, { categoryType: 'MISCELLANEOUS', description: 'Payoneer fee for last week', sourceReference: 'PAYONEER-FEE-1' });
      expect(await confirmExpense(app.db, fresh.tenant, described.expense.id)).toMatchObject({ alreadyConfirmed: false });
      // Renaming a valid category to look like a Payoneer fee does not block it; retyping a category named innocently does.
      const draft = await makeSharedExpense(app, fresh, { categoryType: 'ADVERTISING' });
      await raw`UPDATE expense_categories SET name = 'Payoneer fees' WHERE account_id = ${fresh.tenant.accountId} AND category_type = 'ADVERTISING'`;
      expect(await confirmExpense(app.db, fresh.tenant, draft.expense.id)).toMatchObject({ alreadyConfirmed: false });
    });

    it('fails closed when creating with a same-named category row of another type or an inactive one, creating nothing', async () => {
      const fresh = await registerAndOnboard(app, 'Category Conflict Shop', 'expenses-catconf');
      const accountId = fresh.tenant.accountId;
      await raw`INSERT INTO expense_categories(account_id, name, category_type) VALUES (${accountId}, 'Shipping', 'PAYONEER_FEE')`;
      expect(await errorOf(await createViaApi({ expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '2.00', expenseDate: EXPENSE_DATE }, fresh))).toEqual([422, 'CATEGORY_NOT_USABLE', ['categoryType']]);
      await raw`UPDATE expense_categories SET category_type = 'SHIPPING', is_active = false WHERE account_id = ${accountId}`;
      expect(await errorOf(await createViaApi({ expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '2.00', expenseDate: EXPENSE_DATE }, fresh))).toEqual([422, 'CATEGORY_NOT_USABLE', ['categoryType']]);
      expect(await expenseCount(fresh)).toBe(0);
      expect(await auditCount(raw, accountId, 'expense_category', 'CREATE')).toBe(0);
      await raw`UPDATE expense_categories SET is_active = true WHERE account_id = ${accountId}`;
      expect((await createViaApi({ expenseType: 'SHARED', categoryType: 'SHIPPING', amount: '2.00', expenseDate: EXPENSE_DATE }, fresh)).status).toBe(201);
    });

    it('refuses to confirm a zero-amount draft inserted outside the application, and a foreign-currency one', async () => {
      const fresh = await registerAndOnboard(app, 'Raw Draft Shop', 'expenses-rawdraft');
      const accountId = fresh.tenant.accountId;
      const seeded = await makeSharedExpense(app, fresh);
      await raw`UPDATE expenses SET amount = 0 WHERE id = ${seeded.expense.id}`;
      expect(await errorOf(await expenseRoute('confirm', seeded.expense.id, { who: fresh }))).toEqual([422, 'EXPENSE_AMOUNT_REQUIRED', ['amount']]);
      await raw`UPDATE expenses SET amount = 5, currency = 'PKR' WHERE id = ${seeded.expense.id}`;
      expect(await errorOf(await expenseRoute('confirm', seeded.expense.id, { who: fresh }))).toEqual([422, 'CURRENCY_NOT_SUPPORTED', ['currency']]);
      expect(await journalOfExpense(raw, accountId, seeded.expense.id)).toHaveLength(0);
    });
  });

  describe('confirmed expenses are immutable', () => {
    it('refuses raw edits and deletion of a posted expense, its journal and its lines', async () => {
      const draft = await makeSharedExpense(app, user, { amount: '6.00' });
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      const [entry] = await journalOfExpense(raw, tenantId(), draft.expense.id);
      await expect(raw`UPDATE expenses SET amount = 1 WHERE id = ${draft.expense.id}`).rejects.toThrow(/Posted financial sources are immutable/);
      await expect(raw`UPDATE expenses SET status = 'VOIDED' WHERE id = ${draft.expense.id}`).rejects.toThrow(/Posted financial sources are immutable/);
      await expect(raw`DELETE FROM expenses WHERE id = ${draft.expense.id}`).rejects.toThrow(/Posted financial sources are immutable/);
      await expect(raw`UPDATE journal_entries SET description = 'edited' WHERE id = ${entry?.id}`).rejects.toThrow(/immutable/);
      await expect(raw`DELETE FROM journal_entries WHERE id = ${entry?.id}`).rejects.toThrow(/immutable/);
      await expect(raw`UPDATE journal_lines SET debit_amount = 1 WHERE journal_entry_id = ${entry?.id} AND debit_amount > 0`).rejects.toThrow(/immutable/);
      expect(await rowOf(draft.expense.id)).toMatchObject({ status: 'CONFIRMED', amount: '6.0000' });
    });

    it('refuses to void or re-confirm a confirmed expense through the API', async () => {
      const draft = await makeSharedExpense(app, user);
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      expect(await errorOf(await expenseRoute('void', draft.expense.id))).toEqual([409, 'EXPENSE_NOT_VOIDABLE', undefined]);
      expect((await rowOf(draft.expense.id))?.status).toBe('CONFIRMED');
      expect(await auditCount(raw, tenantId(), 'expense', 'VOID', draft.expense.id)).toBe(0);
    });
  });

  describe('reversal', () => {
    it('posts the exact opposite entry, keeps the stored status, derives REVERSED, and removes the cost from profit', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await confirmedDirectExpense(app, user, order, { amount: '4.25' });
      expect((await orderDetail(order)).profit.confirmedDirectExpenses).toBe('4.25');

      const response = await expenseRoute('reverse', draft.expense.id, { body: { reason: '  Entered by mistake  ' } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.alreadyReversed).toBe(false);
      expect(body).toMatchObject({ canConfirm: false, canVoid: false, canReverse: false, expense: { status: 'CONFIRMED', effectiveStatus: 'REVERSED' } });

      const entries = await journalOfExpense(raw, tenantId(), draft.expense.id);
      expect(entries).toHaveLength(2);
      const original = entries.find((entry) => entry.source_event === 'INITIAL');
      const reversal = entries.find((entry) => entry.source_event === 'REVERSAL');
      expect(original).toMatchObject({ status: 'FINALIZED' });
      expect(reversal).toMatchObject({ status: 'FINALIZED', reversal_of_entry_id: original?.id, idempotency_key: `expense:${draft.expense.id}:REVERSAL` });
      expect(await linesOfEntry(raw, reversal?.id as string)).toEqual([
        { name: 'Expenses Payable', account_role: 'UNCLASSIFIED', account_type: 'LIABILITY', debit: '4.2500', credit: '0.0000' },
        { name: 'Direct Expenses', account_role: 'DIRECT_EXPENSE', account_type: 'EXPENSE', debit: '0.0000', credit: '4.2500' },
      ]);
      expect(await rowOf(draft.expense.id)).toMatchObject({ status: 'CONFIRMED' });
      const [audit] = await raw`SELECT before_data, after_data FROM audit_logs WHERE account_id = ${tenantId()} AND entity_type = 'expense' AND action = 'REVERSE' AND entity_id = ${draft.expense.id}`;
      expect(audit?.before_data).toEqual({ journalEntryId: original?.id });
      expect(audit?.after_data).toEqual({ reversalEntryId: reversal?.id, reason: 'Entered by mistake' });
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '0.00', directProfitBeforeRefunds: '100.00' });
      expect((await orderDetail(order)).expenses).toEqual([expect.objectContaining({ expenseId: draft.expense.id, effectiveStatus: 'REVERSED' })]);
    });

    it('is idempotent: a repeat, a confirm and a void afterwards change nothing', async () => {
      const draft = await makeSharedExpense(app, user, { amount: '7.00' });
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      const first = await reverseExpense(app.db, user.tenant, draft.expense.id, { reason: 'First reason' });
      const journals = await journalEntryCount(raw, tenantId());
      const second = await reverseExpense(app.db, user.tenant, draft.expense.id, { reason: 'Second reason' });
      expect([first.alreadyReversed, second.alreadyReversed]).toEqual([false, true]);
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await auditCount(raw, tenantId(), 'expense', 'REVERSE', draft.expense.id)).toBe(1);
      const confirmAgain = await confirmExpense(app.db, user.tenant, draft.expense.id);
      expect(confirmAgain.alreadyConfirmed).toBe(true);
      expect(confirmAgain.detail.expense.effectiveStatus).toBe('REVERSED');
      expect(await errorOf(await expenseRoute('void', draft.expense.id))).toEqual([409, 'EXPENSE_NOT_VOIDABLE', undefined]);
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
    });

    it('five concurrent reversals produce exactly one reversal and one audit entry', async () => {
      const draft = await makeSharedExpense(app, user, { amount: '8.00' });
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      const results = await Promise.all(Array.from({ length: 5 }, () => reverseExpense(app.db, user.tenant, draft.expense.id, { reason: 'Concurrent' })));
      expect(results.filter((result) => !result.alreadyReversed)).toHaveLength(1);
      expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(2);
      expect(await auditCount(raw, tenantId(), 'expense', 'REVERSE', draft.expense.id)).toBe(1);
    });

    it('requires a reason that is trimmed, at most 500 characters and free of email and phone numbers', async () => {
      const draft = await makeSharedExpense(app, user, { amount: '9.00' });
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      const bad: unknown[] = [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 7 }, { reason: 'mail me at jane@example.com' }, { reason: 'ok', extra: 1 }];
      for (const body of bad) {
        const response = await expenseRoute('reverse', draft.expense.id, { body });
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(JSON.stringify(await response.json())).not.toContain('jane@example.com');
      }
      expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(1);
      expect((await expenseRoute('reverse', draft.expense.id, { body: { reason: 'x'.repeat(500) } })).status).toBe(200);
    });

    it('refuses to reverse a draft or an unknown expense, and a corrected expense is simply a new one that counts', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '40.00' });
      const draft = await makeDirectExpense(app, user, order, { amount: '3.00' });
      expect(await errorOf(await expenseRoute('reverse', draft.expense.id, { body: { reason: 'nope' } }))).toEqual([409, 'EXPENSE_NOT_CONFIRMED', undefined]);
      expect((await expenseRoute('reverse', MISSING, { body: { reason: 'nope' } })).status).toBe(404);
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      await reverseExpense(app.db, user.tenant, draft.expense.id, { reason: 'Wrong amount' });
      await confirmedDirectExpense(app, user, order, { amount: '3.50' });
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '3.50', directProfitBeforeRefunds: '36.50' });
    });
  });

  describe('profit', () => {
    it('counts only confirmed, unreversed DIRECT expenses; drafts are shown apart; voided and reversed are excluded; shared never counts', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const keep = await makeDirectExpense(app, user, order, { amount: '10.00' });
      await confirmExpense(app.db, user.tenant, keep.expense.id);
      const reversed = await makeDirectExpense(app, user, order, { amount: '20.00' });
      await confirmExpense(app.db, user.tenant, reversed.expense.id);
      await reverseExpense(app.db, user.tenant, reversed.expense.id, { reason: 'Duplicate' });
      const voided = await makeDirectExpense(app, user, order, { amount: '30.00' });
      await voidExpense(app.db, user.tenant, voided.expense.id);
      await makeDirectExpense(app, user, order, { amount: '40.00' });
      const shared = await makeSharedExpense(app, user, { amount: '50.00' });
      await confirmExpense(app.db, user.tenant, shared.expense.id);

      const detail = await orderDetail(order);
      expect(detail.profit).toEqual({
        netPayable: '100.00', revenue: '100.00', revenueExcluded: false, confirmedSupplierCosts: '0.00', draftSupplierCosts: '0.00',
        confirmedDirectExpenses: '10.00', draftDirectExpenses: '40.00', directProfitBeforeRefunds: '90.00', includesExpenses: true, includesRefunds: false,
      });
      expect(detail.expenses.map((expense) => [expense.amount, expense.effectiveStatus]).sort()).toEqual([
        ['10.00', 'CONFIRMED'], ['20.00', 'REVERSED'], ['30.00', 'VOIDED'], ['40.00', 'DRAFT'],
      ]);
      const listed = await (await routes.orders.list(apiRequest(app, '/api/v1/orders', { cookie: user.cookie, query: '?limit=100' }))).json();
      expect(listed.items.find((item: { id: string }) => item.id === order.order.id).profit).toMatchObject({ confirmedDirectExpenses: '10.00', directProfitBeforeRefunds: '90.00' });
    });

    it('is exact with fractional cents: 0.10 + 0.20 on a 0.30 order leaves exactly 0.00', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '0.30' });
      await confirmedDirectExpense(app, user, order, { amount: '0.10' });
      await confirmedDirectExpense(app, user, order, { amount: '0.20' });
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '0.30', directProfitBeforeRefunds: '0.00' });
      await confirmedDirectExpense(app, user, order, { amount: '0.01' });
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '0.31', directProfitBeforeRefunds: '-0.01' });
    });

    it('does not fan out: an order with 2 items, 2 purchase lines and 2 expenses has exact totals', async () => {
      const supplierId = (await makeSupplier(app, user)).id;
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const purchase = await makeDraftPurchase(app, user, supplierId, order); // 2 lines, 25.25
      await confirmPurchase(app.db, user.tenant, purchase.purchase.id);
      await confirmedDirectExpense(app, user, order, { amount: '4.25' });
      await confirmedDirectExpense(app, user, order, { amount: '1.00' });
      await makeDirectExpense(app, user, order, { amount: '2.00' });
      await makeDraftPurchase(app, user, supplierId, order);
      const { profit } = await orderDetail(order);
      expect(profit).toMatchObject({
        confirmedSupplierCosts: '25.25', draftSupplierCosts: '25.25', confirmedDirectExpenses: '5.25', draftDirectExpenses: '2.00', directProfitBeforeRefunds: '69.50',
      });
    });

    it('counts a CONFIRMED row only when it has a finalized INITIAL posting (a status set outside the application is not trusted)', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDirectExpense(app, user, order, { amount: '9.00' });
      await raw`UPDATE expenses SET status = 'CONFIRMED' WHERE id = ${draft.expense.id}`;
      expect((await orderDetail(order)).profit).toMatchObject({ confirmedDirectExpenses: '0.00', directProfitBeforeRefunds: '100.00' });
      await raw`DELETE FROM expenses WHERE id = ${draft.expense.id}`;
    });

    it('keeps the ledger balanced, and Expenses Payable mirrors the expense accounts exactly', async () => {
      const [totals] = await raw`
        SELECT coalesce(sum(l.debit_amount), 0)::text AS debits, coalesce(sum(l.credit_amount), 0)::text AS credits
        FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.account_id = ${tenantId()} AND e.status = 'FINALIZED'`;
      expect(parseDbMoney(String(totals?.debits))).toBe(parseDbMoney(String(totals?.credits)));
      // Only expenses (and their reversals) touch the two expense roles and Expenses Payable in this suite.
      const expenseSide = (await netBalance(raw, tenantId(), 'account_role', 'DIRECT_EXPENSE')) + (await netBalance(raw, tenantId(), 'account_role', 'SHARED_EXPENSE'));
      expect(expenseSide).toBeGreaterThan(BigInt(0));
      expect(-(await netBalance(raw, tenantId(), 'name', 'Expenses Payable'))).toBe(expenseSide);
    });
  });

  describe('API surface', () => {
    it('lists newest first with a page, returns the detail, and answers 404 for unknown and malformed IDs', async () => {
      const fresh = await registerAndOnboard(app, 'List Shop', 'expenses-list');
      const first = await makeSharedExpense(app, fresh, { amount: '1.00' });
      const second = await makeSharedExpense(app, fresh, { amount: '2.00', categoryType: 'ADVERTISING' });
      const list = await (await routes.expenses.list(apiRequest(app, '/api/v1/expenses', { cookie: fresh.cookie, query: '?limit=1' }))).json();
      expect(list.page).toEqual({ limit: 1, offset: 0, total: 2 });
      expect(list.items.map((item: { id: string }) => item.id)).toEqual([second.expense.id]);
      const next = await (await routes.expenses.list(apiRequest(app, '/api/v1/expenses', { cookie: fresh.cookie, query: '?limit=1&offset=1' }))).json();
      expect(next.items.map((item: { id: string }) => item.id)).toEqual([first.expense.id]);
      expect(next.items[0]).toMatchObject({ categoryName: 'Software subscriptions', effectiveStatus: 'DRAFT' });
      expect((await routes.expenses.list(apiRequest(app, '/api/v1/expenses', { cookie: fresh.cookie, query: '?bogus=1' }))).status).toBe(400);
      const detail = await expenseRoute('get', first.expense.id, { method: 'GET', who: fresh });
      expect(detail.status).toBe(200);
      expect(detail.headers.get('cache-control')).toBe(NO_STORE);
      expect((await expenseRoute('get', MISSING, { method: 'GET', who: fresh })).status).toBe(404);
      const malformed = await callRoute(routes.expenses.get, apiRequest(app, '/api/v1/expenses/not-a-uuid', { cookie: fresh.cookie }), { expenseId: 'not-a-uuid' });
      expect(malformed.status).toBe(404);
    });

    it('lists the order’s expenses in the order detail with their effective status', async () => {
      const order = await makeOrder(app, user);
      expect((await orderDetail(order)).expenses).toEqual([]);
      const draft = await makeDirectExpense(app, user, order, { amount: '1.25', categoryType: 'ADVERTISING' });
      const api = await (await callRoute(routes.orders.get, apiRequest(app, `/api/v1/orders/${order.order.id}`, { cookie: user.cookie }), { orderId: order.order.id })).json();
      expect(api.expenses).toEqual([{ expenseId: draft.expense.id, categoryName: 'Etsy advertisements', expenseDate: EXPENSE_DATE, amount: '1.25', effectiveStatus: 'DRAFT' }]);
    });

    it('the service rejects a SHARED expense that carries an order, and a DIRECT one without it (defence in depth), creating nothing', async () => {
      const order = await makeOrder(app, user);
      const before = await expenseCount();
      await expect(createExpense(app.db, user.tenant, { expenseType: 'DIRECT', categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE }))
        .rejects.toMatchObject({ kind: 'unprocessable', code: 'ORDER_NOT_FOUND', fields: ['orderId'] });
      await expect(createExpense(app.db, user.tenant, { expenseType: 'SHARED', orderId: order.order.id, categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE }))
        .rejects.toMatchObject({ kind: 'unprocessable', code: 'ORDER_NOT_ALLOWED', fields: ['orderId'] });
      expect(await expenseCount()).toBe(before);
    });
  });
});
