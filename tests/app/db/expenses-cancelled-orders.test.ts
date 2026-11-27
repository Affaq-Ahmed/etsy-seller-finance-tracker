import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { getPostgresErrorCode } from '@/server/db/errors';
import { confirmExpense, confirmExpenseInTransaction, createExpense, reverseExpense } from '@/server/expenses/service';
import { changeOrderStatus, getOrderDetail, type OrderDetail } from '@/server/orders/service';
import { confirmPurchase } from '@/server/purchases/service';
import { hasTestDatabase, testDatabaseUrl } from '../support/database';
import { apiRequest, apiRoutes, callRoute, createTestApp, registerAndOnboard, type OnboardedUser } from '../support/app';
import { EXPENSE_DATE, journalOfExpense, makeDirectExpense } from '../support/expenses';
import { auditCount, journalEntryCount, makeDraftPurchase, makeOrder, makeSupplier, openRaw } from '../support/phase2';

// ARCHITECTURE.md A38: a DIRECT expense on a CANCELLED order stays valid and
// counts toward profit (unlike supplier purchases, A35). Nothing is reversed
// automatically. The order is still locked BEFORE the first write (A35), so a
// concurrent cancellation can never deadlock with an expense operation.

const PG_LOCK_NOT_AVAILABLE = '55P03';

describe.skipIf(!hasTestDatabase)('expenses on cancelled orders', () => {
  let app: AppContainer;
  let raw: postgres.Sql;
  let routes: ReturnType<typeof apiRoutes>;
  let user: OnboardedUser;

  beforeAll(async () => {
    app = createTestApp();
    raw = openRaw();
    routes = apiRoutes(app);
    user = await registerAndOnboard(app, 'Cancelled Expenses Shop', 'expcancel');
  });
  afterAll(async () => {
    await raw?.end();
    await app?.close();
  });

  const tenantId = () => user.tenant.accountId;
  const cancel = (order: OrderDetail) => changeOrderStatus(app.db, user.tenant, order.order.id, { status: 'CANCELLED' });
  const detail = (order: OrderDetail) => getOrderDetail(app.db, user.tenant, order.order.id);

  describe('valid and counted', () => {
    it('accepts a new DIRECT expense on a cancelled order through the API and counts it once confirmed', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      await cancel(order);
      const response = await routes.expenses.create(apiRequest(app, '/api/v1/expenses', {
        method: 'POST', cookie: user.cookie, body: { expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'SHIPPING', amount: '4.25', expenseDate: EXPENSE_DATE },
      }));
      expect(response.status).toBe(201);
      const created = await response.json();
      expect((await detail(order)).profit).toMatchObject({ revenue: '0.00', revenueExcluded: true, draftDirectExpenses: '4.25', confirmedDirectExpenses: '0.00', directProfitBeforeRefunds: '0.00' });

      const confirmed = await callRoute(routes.expenses.confirm, apiRequest(app, `/api/v1/expenses/${created.expense.id}/confirm`, { method: 'POST', cookie: user.cookie }), { expenseId: created.expense.id });
      expect(confirmed.status).toBe(200);
      expect((await confirmed.json()).alreadyConfirmed).toBe(false);
      expect(await journalOfExpense(raw, tenantId(), created.expense.id)).toHaveLength(1);
      expect((await detail(order)).profit).toEqual({
        netPayable: '100.00', revenue: '0.00', revenueExcluded: true, confirmedSupplierCosts: '0.00', draftSupplierCosts: '0.00',
        confirmedDirectExpenses: '4.25', draftDirectExpenses: '0.00', directProfitBeforeRefunds: '-4.25', includesExpenses: true, includesRefunds: false,
      });
    });

    it('confirms a draft created before the cancellation', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDirectExpense(app, user, order, { amount: '6.00' });
      await cancel(order);
      const result = await confirmExpense(app.db, user.tenant, draft.expense.id);
      expect(result.alreadyConfirmed).toBe(false);
      expect((await detail(order)).profit).toMatchObject({ confirmedDirectExpenses: '6.00', directProfitBeforeRefunds: '-6.00' });
    });

    it('cancelling after the expense was confirmed keeps the posting and the cost, and reverses nothing', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDirectExpense(app, user, order, { amount: '4.25' });
      await confirmExpense(app.db, user.tenant, draft.expense.id);
      expect((await detail(order)).profit.directProfitBeforeRefunds).toBe('95.75');
      const journals = await journalEntryCount(raw, tenantId());

      await cancel(order);

      expect((await detail(order)).profit).toMatchObject({ revenue: '0.00', revenueExcluded: true, confirmedDirectExpenses: '4.25', directProfitBeforeRefunds: '-4.25' });
      expect(await journalEntryCount(raw, tenantId())).toBe(journals);
      expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(1);
      expect(await auditCount(raw, tenantId(), 'expense', 'REVERSE', draft.expense.id)).toBe(0);
      // Confirming again is the usual harmless no-op, not an error.
      expect((await confirmExpense(app.db, user.tenant, draft.expense.id)).alreadyConfirmed).toBe(true);
    });

    it('adds to supplier costs on a cancelled order, and a manual reversal brings the loss back', async () => {
      const supplierId = (await makeSupplier(app, user)).id;
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const purchase = await makeDraftPurchase(app, user, supplierId, order);
      await confirmPurchase(app.db, user.tenant, purchase.purchase.id);
      const expense = await makeDirectExpense(app, user, order, { amount: '4.25' });
      await confirmExpense(app.db, user.tenant, expense.expense.id);
      await cancel(order);
      expect((await detail(order)).profit).toMatchObject({ confirmedSupplierCosts: '25.25', confirmedDirectExpenses: '4.25', directProfitBeforeRefunds: '-29.50' });
      await reverseExpense(app.db, user.tenant, expense.expense.id, { reason: 'Carrier refunded the postage' });
      expect((await detail(order)).profit).toMatchObject({ confirmedSupplierCosts: '25.25', confirmedDirectExpenses: '0.00', directProfitBeforeRefunds: '-25.25' });
    });
  });

  describe('locking: the order is locked before the first write (ARCHITECTURE.md A35, A38)', () => {
    /**
     * Waits until some backend is blocked BY THE HOLDER (pg_blocking_pids contains the holder's backend pid), so the
     * wait is proven to be on the lock the test holds and not on any other lock in the database. Returns the waiter's pid.
     */
    async function waitForLockWait(holder: postgres.Sql): Promise<number> {
      const [holderRow] = await holder`SELECT pg_backend_pid() AS pid`;
      const holderPid = Number(holderRow?.pid);
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await raw`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        if (row) return Number(row.pid);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the operation never waited on the lock held by the test');
    }

    /**
     * The tables the backend has already WRITTEN in its open transaction. INSERT, UPDATE and DELETE take a RowExclusiveLock
     * on the table, and a read or a row lock (SELECT ... FOR UPDATE) does not, so an empty result proves that the waiting
     * backend has not reached its first write. Rows it has written are invisible to other connections, so counting rows
     * from a second connection could never prove this.
     */
    async function tablesWrittenBy(pid: number): Promise<string[]> {
      const rows = await raw`
        SELECT DISTINCT c.relname AS name FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = ${pid} AND l.granted AND l.mode = 'RowExclusiveLock'
          AND c.relname IN ('expenses', 'expense_categories', 'financial_accounts', 'journal_entries', 'journal_lines', 'audit_logs', 'orders', 'business_accounts')
        ORDER BY 1`;
      return rows.map((row) => String(row.name));
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

    async function expenseRowIsLocked(expenseId: string): Promise<boolean> {
      try {
        await raw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE NOWAIT`;
        return false;
      } catch (error) {
        if (getPostgresErrorCode(error) === PG_LOCK_NOT_AVAILABLE) return true;
        throw error;
      }
    }

    // Hold the order row as a concurrent status change would, start the operation, and check that the waiting
    // operation holds no tenant lock. If the order lock came after the first write (which takes the tenant lock),
    // this would fail and the operation could deadlock against an order status change.
    it('confirmExpense waits for the order lock holding the expense row but not the tenant lock', async () => {
      const order = await makeOrder(app, user);
      const draft = await makeDirectExpense(app, user, order);
      const holder = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM orders WHERE id = ${order.order.id} FOR UPDATE`;
        const pending = confirmExpense(app.db, user.tenant, draft.expense.id);
        const waiter = await waitForLockWait(holder);
        expect(await tenantLockIsFree(), 'no tenant lock while waiting for the order').toBe(true);
        expect(await expenseRowIsLocked(draft.expense.id), 'the expense row is locked first (expense, then order, then first write)').toBe(true);
        expect(await tablesWrittenBy(waiter), 'the waiting confirmation has not written anything yet').toEqual([]);
        await holder`ROLLBACK`;
        await expect(pending).resolves.toMatchObject({ alreadyConfirmed: false });
      } finally {
        await holder.end();
      }
    });

    it('createExpense (DIRECT) waits for the order lock without holding the tenant lock and before its first write', async () => {
      const order = await makeOrder(app, user);
      const holder = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM orders WHERE id = ${order.order.id} FOR UPDATE`;
        const pending = createExpense(app.db, user.tenant, { expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'SHIPPING', amount: '1.00', expenseDate: EXPENSE_DATE });
        const waiter = await waitForLockWait(holder);
        expect(await tenantLockIsFree()).toBe(true);
        expect(await tablesWrittenBy(waiter), 'the waiting creation has not written anything yet').toEqual([]);
        await holder`ROLLBACK`;
        await expect(pending).resolves.toBeDefined();
      } finally {
        await holder.end();
      }
    });

    // The tests above run on a tenant that has already confirmed an expense, so the Expenses Payable account and the
    // category rows exist and are only READ. The lazy paths WRITE (the account insert takes the tenant lock through
    // a_lock_financial_accounts), so a misplaced order lock would deadlock only a tenant's FIRST confirmation.
    // These tests use freshly onboarded tenants (no Expenses Payable account, no category row yet).
    const countRows = async (query: Promise<postgres.RowList<postgres.Row[]>>) => Number((await query)[0]?.n);

    it('FRESH tenant: the first confirmExpense waits for the order lock before creating Expenses Payable (no tenant lock, no write yet)', async () => {
      const fresh = await registerAndOnboard(app, 'Fresh Confirm Shop', 'expfresh-confirm');
      const accountId = fresh.tenant.accountId;
      const order = await makeOrder(app, fresh);
      const draft = await makeDirectExpense(app, fresh, order);
      const payables = () => countRows(raw`SELECT count(*)::int AS n FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`);
      const lazyAudits = () => countRows(raw`SELECT count(*)::int AS n FROM audit_logs WHERE account_id = ${accountId} AND entity_type = 'financial_account' AND after_data->>'reason' = 'expenses_payable_backfill'`);
      const tenantFree = async () => {
        try {
          await raw`SELECT id FROM business_accounts WHERE id = ${accountId} FOR UPDATE NOWAIT`;
          return true;
        } catch (error) {
          if (getPostgresErrorCode(error) === PG_LOCK_NOT_AVAILABLE) return false;
          throw error;
        }
      };
      expect(await payables()).toBe(0);
      const holder = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM orders WHERE id = ${order.order.id} FOR UPDATE`;
        const pending = confirmExpense(app.db, fresh.tenant, draft.expense.id);
        const waiter = await waitForLockWait(holder);
        expect(await tenantFree(), 'the waiting confirmation must not hold the tenant lock').toBe(true);
        expect(await tablesWrittenBy(waiter), 'the waiting confirmation must not have inserted Expenses Payable (or written anything) before the order is locked').toEqual([]);
        await holder`ROLLBACK`;
        await expect(pending).resolves.toMatchObject({ alreadyConfirmed: false });
      } finally {
        await holder.end();
      }
      expect(await payables()).toBe(1);
      expect(await lazyAudits()).toBe(1);
      expect(await journalOfExpense(raw, accountId, draft.expense.id)).toHaveLength(1);
    });

    it('FRESH tenant: the first createExpense waits for the order lock before creating its category (no tenant lock, no write yet)', async () => {
      const fresh = await registerAndOnboard(app, 'Fresh Create Shop', 'expfresh-create');
      const accountId = fresh.tenant.accountId;
      const order = await makeOrder(app, fresh);
      const categories = () => countRows(raw`SELECT count(*)::int AS n FROM expense_categories WHERE account_id = ${accountId}`);
      const expensesCount = () => countRows(raw`SELECT count(*)::int AS n FROM expenses WHERE account_id = ${accountId}`);
      expect(await categories()).toBe(0);
      const holder = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM orders WHERE id = ${order.order.id} FOR UPDATE`;
        const pending = createExpense(app.db, fresh.tenant, { expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'ADVERTISING', amount: '1.00', expenseDate: EXPENSE_DATE });
        const waiter = await waitForLockWait(holder);
        // Same lock-order rule as every write: the order first, even though the category insert takes no tenant lock.
        expect(await tablesWrittenBy(waiter), 'the category must not be inserted (or anything written) before the order is locked').toEqual([]);
        try {
          await raw`SELECT id FROM business_accounts WHERE id = ${accountId} FOR UPDATE NOWAIT`;
        } catch (error) {
          throw new Error(`the waiting creation holds the tenant lock (${getPostgresErrorCode(error)})`);
        }
        await holder`ROLLBACK`;
        await expect(pending).resolves.toBeDefined();
      } finally {
        await holder.end();
      }
      expect(await categories()).toBe(1);
      expect(await expensesCount()).toBe(1);
      expect(await auditCount(raw, accountId, 'expense_category', 'CREATE')).toBe(1);
    });

    it('confirm commits first, then the cancellation: both succeed and the expense counts (deterministic)', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDirectExpense(app, user, order, { amount: '4.25' });
      const firstWriter = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await firstWriter`BEGIN`;
        const first = await confirmExpenseInTransaction(drizzle(firstWriter, { schema }), user.tenant, draft.expense.id);
        expect(first.alreadyConfirmed).toBe(false);
        const cancelling = cancel(order);
        await waitForLockWait(firstWriter);
        await firstWriter`COMMIT`;
        await expect(cancelling).resolves.toBeDefined();
      } finally {
        await firstWriter.end();
      }
      expect((await detail(order)).order.status).toBe('CANCELLED');
      expect((await detail(order)).profit).toMatchObject({ revenue: '0.00', confirmedDirectExpenses: '4.25', directProfitBeforeRefunds: '-4.25' });
      expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(1);
    });

    it('the cancellation commits first, then the confirmation: it still succeeds and counts (deterministic)', async () => {
      const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
      const draft = await makeDirectExpense(app, user, order, { amount: '4.25' });
      const holder = postgres(testDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await holder`BEGIN`;
        await holder`UPDATE orders SET status = 'CANCELLED' WHERE id = ${order.order.id}`;
        const confirming = confirmExpense(app.db, user.tenant, draft.expense.id);
        await waitForLockWait(holder);
        await holder`COMMIT`;
        await expect(confirming).resolves.toMatchObject({ alreadyConfirmed: false });
      } finally {
        await holder.end();
      }
      expect((await detail(order)).profit).toMatchObject({ revenue: '0.00', revenueExcluded: true, confirmedDirectExpenses: '4.25', directProfitBeforeRefunds: '-4.25' });
      expect(await journalOfExpense(raw, tenantId(), draft.expense.id)).toHaveLength(1);
    });

    it('confirming and creating while the same order is cancelled never deadlocks (40 rounds, deadlock counter unchanged)', async () => {
      const deadlocks = async () => Number((await raw`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)[0]?.deadlocks);
      const before = await deadlocks();
      for (let round = 0; round < 40; round++) {
        const order = await makeOrder(app, user, { netPayableAmount: '100.00' });
        const draft = await makeDirectExpense(app, user, order, { amount: '4.25' });
        const [confirmResult, createResult, cancelResult] = await Promise.allSettled([
          confirmExpense(app.db, user.tenant, draft.expense.id),
          createExpense(app.db, user.tenant, { expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'ADVERTISING', amount: '1.00', expenseDate: EXPENSE_DATE }),
          cancel(order),
        ]);
        // Expenses stay valid whichever commits first, so every operation succeeds.
        expect(confirmResult.status, `round ${round}: confirm`).toBe('fulfilled');
        expect(createResult.status, `round ${round}: create`).toBe('fulfilled');
        expect(cancelResult.status, `round ${round}: cancel`).toBe('fulfilled');
        expect(await journalOfExpense(raw, tenantId(), draft.expense.id), `round ${round}`).toHaveLength(1);
        expect((await detail(order)).profit, `round ${round}`).toMatchObject({ revenue: '0.00', confirmedDirectExpenses: '4.25', draftDirectExpenses: '1.00', directProfitBeforeRefunds: '-4.25' });
      }
      expect(await deadlocks() - before).toBe(0);
    });

    it('the FIRST confirmation and first category of a fresh tenant racing an order cancellation never deadlock (15 fresh tenants, deadlock counter unchanged)', async () => {
      const deadlocks = async () => Number((await raw`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)[0]?.deadlocks);
      const before = await deadlocks();
      for (let round = 0; round < 15; round++) {
        const fresh = await registerAndOnboard(app, `Fresh Race Shop ${round}`, `expfresh-race-${round}`);
        const order = await makeOrder(app, fresh, { netPayableAmount: '100.00' });
        const draft = await makeDirectExpense(app, fresh, order, { amount: '4.25' });
        const [confirmResult, createResult, cancelResult] = await Promise.allSettled([
          confirmExpense(app.db, fresh.tenant, draft.expense.id),
          // A different category type: its row is created lazily inside the race.
          createExpense(app.db, fresh.tenant, { expenseType: 'DIRECT', orderId: order.order.id, categoryType: 'ADVERTISING', amount: '1.00', expenseDate: EXPENSE_DATE }),
          changeOrderStatus(app.db, fresh.tenant, order.order.id, { status: 'CANCELLED' }),
        ]);
        expect(confirmResult.status, `round ${round}: confirm`).toBe('fulfilled');
        expect(createResult.status, `round ${round}: create`).toBe('fulfilled');
        expect(cancelResult.status, `round ${round}: cancel`).toBe('fulfilled');
        const accountId = fresh.tenant.accountId;
        expect(await journalOfExpense(raw, accountId, draft.expense.id), `round ${round}`).toHaveLength(1);
        expect(Number((await raw`SELECT count(*)::int AS n FROM financial_accounts WHERE account_id = ${accountId} AND name = 'Expenses Payable'`)[0]?.n), `round ${round}: one Expenses Payable`).toBe(1);
        expect(Number((await raw`SELECT count(*)::int AS n FROM expense_categories WHERE account_id = ${accountId}`)[0]?.n), `round ${round}: two categories`).toBe(2);
        expect((await getOrderDetail(app.db, fresh.tenant, order.order.id)).profit, `round ${round}`).toMatchObject({ revenue: '0.00', confirmedDirectExpenses: '4.25', draftDirectExpenses: '1.00' });
      }
      expect(await deadlocks() - before).toBe(0);
    });
  });
});
