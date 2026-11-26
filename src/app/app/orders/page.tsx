import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Amount, EmptyState, PageHeader, Pager, PrimaryLink, StatusBadge, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { getContainer } from '@/server/container';
import { pageFromSearchParams, type SearchParams } from '@/server/http/page-search';
import { listOrders } from '@/server/orders/service';

export const metadata: Metadata = { title: 'Orders' };

export default function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <OrdersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function OrdersContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const request = await pageFromSearchParams(searchParams);
  const page = await listOrders(getContainer().db, tenant, request);
  return (
    <>
      <PageHeader
        title="Orders"
        description="Profit shown is Etsy net payable minus confirmed supplier costs. Order expenses and refunds are not included yet."
        actions={<PrimaryLink href="/app/orders/new">New order</PrimaryLink>}
      />
      {page.items.length === 0 ? <EmptyState>No orders yet. Record your first Etsy order.</EmptyState> : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Orders, newest first</caption>
            <thead><tr>
              <th scope="col" className={TH_CLASS}>Etsy order</th><th scope="col" className={TH_CLASS}>Date</th><th scope="col" className={TH_CLASS}>Status</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>Items</th><th scope="col" className={`${TH_CLASS} text-right`}>Net payable</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>Confirmed costs</th><th scope="col" className={`${TH_CLASS} text-right`}>Profit before expenses and refunds</th>
            </tr></thead>
            <tbody>
              {page.items.map((order) => (
                <tr key={order.id}>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/orders/${order.id}`}>{order.etsyOrderId}</Link></td>
                  <td className={TD_CLASS}>{order.orderDate}</td>
                  <td className={TD_CLASS}><StatusBadge status={order.status} /></td>
                  <td className={`${TD_CLASS} text-right`}>{order.itemCount}</td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={order.profit.netPayable} currency={order.currency} />{order.profit.revenueExcluded ? <span className="block text-xs text-zinc-600 dark:text-zinc-400">not counted (cancelled)</span> : null}</td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={order.profit.confirmedSupplierCosts} /></td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={order.profit.directProfitBeforeExpensesAndRefunds} currency={order.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager basePath="/app/orders" offset={page.page.offset} limit={page.page.limit} total={page.page.total} />
    </>
  );
}
