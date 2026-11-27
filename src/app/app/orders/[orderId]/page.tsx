import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { instantToZonedDate } from '@/lib/dates';
import { formatDeduction } from '@/lib/money';
import { OrderStatusActions } from '@/components/orders/order-status-actions';
import { Amount, EmptyState, Notice, PageHeader, PrimaryLink, SecondaryLink, StatusBadge, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { loadBusinessContext } from '@/server/business/context';
import { getContainer } from '@/server/container';
import { assertUuidOrNotFound, orNotFound } from '@/server/http/pages';
import { getOrderDetail } from '@/server/orders/service';

export const metadata: Metadata = { title: 'Order' };

export default function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <OrderContent params={params} />
    </Suspense>
  );
}

async function OrderContent({ params }: { params: Promise<{ orderId: string }> }) {
  const tenant = await requireTenant();
  const orderId = assertUuidOrNotFound((await params).orderId);
  const { db } = getContainer();
  const [detail, business] = await Promise.all([orNotFound(getOrderDetail(db, tenant, orderId)), loadBusinessContext(db, tenant)]);
  const { order, items, profit, purchases, expenses } = detail;
  const today = instantToZonedDate(new Date(), business.timeZone);
  const anyLocked = items.some((item) => item.locked);
  return (
    <>
      <PageHeader
        title={`Etsy order ${order.etsyOrderId}`}
        description={`Ordered ${order.orderDate}${order.deliveredDate ? `, delivered ${order.deliveredDate}` : ''}.`}
        actions={(
          <>
            {order.status !== 'CANCELLED' ? <PrimaryLink href={`/app/purchases/new?orderId=${order.id}`}>Record supplier purchase</PrimaryLink> : null}
            <SecondaryLink href={`/app/expenses/new?orderId=${order.id}`}>Record order expense</SecondaryLink>
          </>
        )}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3"><StatusBadge status={order.status} /></div>

      <section aria-labelledby="profit" className="mb-8">
        <h2 id="profit" className="mb-2 text-lg font-semibold">Profit before refunds</h2>
        <dl className="grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          <dt>{profit.revenueExcluded ? `Etsy net payable (recorded ${profit.netPayable}, not counted: order cancelled)` : 'Etsy net payable'}</dt><dd className="text-right"><Amount value={profit.revenue} currency={order.currency} /></dd>
          <dt>Confirmed supplier costs</dt><dd className="text-right"><Amount value={formatDeduction(profit.confirmedSupplierCosts)} /></dd>
          <dt>Confirmed order expenses</dt><dd className="text-right"><Amount value={formatDeduction(profit.confirmedDirectExpenses)} /></dd>
          <dt className="border-t border-zinc-400 pt-1 font-semibold">Direct profit so far</dt>
          <dd className="border-t border-zinc-400 pt-1 text-right font-semibold"><Amount value={profit.directProfitBeforeRefunds} currency={order.currency} /></dd>
        </dl>
        <p className="mt-2 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          Refunds are not included yet. Draft and reversed purchases and expenses never count. Shared business expenses are not part of an order&apos;s profit.{profit.revenueExcluded ? ' A cancelled order counts no Etsy revenue; confirmed supplier costs and order expenses still count.' : ''}
          {profit.draftSupplierCosts !== '0.00' ? ` Draft purchases on this order total ${profit.draftSupplierCosts} ${order.currency} and are not counted.` : ''}
          {profit.draftDirectExpenses !== '0.00' ? ` Draft expenses on this order total ${profit.draftDirectExpenses} ${order.currency} and are not counted.` : ''}
        </p>
      </section>

      <section aria-labelledby="items" className="mb-8">
        <h2 id="items" className="mb-2 text-lg font-semibold">Items</h2>
        <table className={TABLE_CLASS}>
          <caption className="sr-only">Items on this order</caption>
          <thead><tr><th scope="col" className={TH_CLASS}>Item</th><th scope="col" className={TH_CLASS}>SKU</th><th scope="col" className={`${TH_CLASS} text-right`}>Quantity</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}><td className={TD_CLASS}>{item.productName}</td><td className={TD_CLASS}>{item.sku ?? '—'}</td><td className={`${TD_CLASS} text-right`}>{item.quantity}</td></tr>
            ))}
          </tbody>
        </table>
        {anyLocked ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Items are locked because a supplier purchase refers to them.</p> : null}
      </section>

      <section aria-labelledby="purchases" className="mb-8">
        <h2 id="purchases" className="mb-2 text-lg font-semibold">Supplier purchases</h2>
        {purchases.length === 0 ? <EmptyState>No supplier purchases recorded for this order.</EmptyState> : (
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Supplier purchases covering this order</caption>
            <thead><tr>
              <th scope="col" className={TH_CLASS}>Supplier</th><th scope="col" className={TH_CLASS}>Reference</th><th scope="col" className={TH_CLASS}>Date</th>
              <th scope="col" className={TH_CLASS}>Status</th><th scope="col" className={`${TH_CLASS} text-right`}>Share of this order</th>
            </tr></thead>
            <tbody>
              {purchases.map((purchase) => (
                <tr key={purchase.purchaseId}>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/purchases/${purchase.purchaseId}`}>{purchase.supplierName}</Link></td>
                  <td className={TD_CLASS}>{purchase.supplierOrderReference ?? '—'}</td>
                  <td className={TD_CLASS}>{purchase.purchaseDate ?? '—'}</td>
                  <td className={TD_CLASS}><StatusBadge status={purchase.effectiveStatus} /></td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={purchase.orderTotal} currency={order.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="expenses" className="mb-8">
        <h2 id="expenses" className="mb-2 text-lg font-semibold">Order expenses</h2>
        {order.status === 'CANCELLED' ? <div className="mb-3"><Notice title="This order is cancelled">An expense recorded now is still valid and counts toward this order&apos;s profit, which already counts no revenue.</Notice></div> : null}
        {expenses.length === 0 ? <EmptyState>No expenses recorded for this order.</EmptyState> : (
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Expenses recorded for this order</caption>
            <thead><tr>
              <th scope="col" className={TH_CLASS}>Category</th><th scope="col" className={TH_CLASS}>Date</th>
              <th scope="col" className={TH_CLASS}>Status</th><th scope="col" className={`${TH_CLASS} text-right`}>Amount</th>
            </tr></thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.expenseId}>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/expenses/${expense.expenseId}`}>{expense.categoryName}</Link></td>
                  <td className={TD_CLASS}>{expense.expenseDate}</td>
                  <td className={TD_CLASS}><StatusBadge status={expense.effectiveStatus} /></td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={expense.amount} currency={order.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="status">
        <h2 id="status" className="mb-2 text-lg font-semibold">Order status</h2>
        <OrderStatusActions orderId={order.id} allowedNext={detail.allowedNextStatuses} defaultDate={today} />
      </section>
      {order.notes ? <div className="mt-8"><Notice title="Notes">{order.notes}</Notice></div> : null}
    </>
  );
}
