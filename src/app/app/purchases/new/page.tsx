import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { instantToZonedDate } from '@/lib/dates';
import { PurchaseForm } from '@/components/purchases/purchase-form';
import { EmptyState, Notice, PageHeader, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { loadBusinessContext } from '@/server/business/context';
import { getContainer } from '@/server/container';
import type { SearchParams } from '@/server/http/page-search';
import { assertUuidOrNotFound, orNotFound } from '@/server/http/pages';
import { getOrderDetail, listOrders } from '@/server/orders/service';
import { listSuppliers } from '@/server/suppliers/service';

export const metadata: Metadata = { title: 'New supplier purchase' };

const CHOICES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function NewPurchasePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <NewPurchaseContent searchParams={searchParams} />
    </Suspense>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function NewPurchaseContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const { db } = getContainer();
  const query = await searchParams;
  const orderId = single(query.orderId);

  if (orderId === undefined) {
    const orders = await listOrders(db, tenant, { limit: 25, offset: 0 });
    const openOrders = orders.items.filter((order) => order.status !== 'CANCELLED');
    return (
      <>
        <PageHeader title="New supplier purchase" description="Choose the Etsy order this purchase is for." />
        {openOrders.length === 0 ? <EmptyState>Record an order first. Cancelled orders cannot receive supplier purchases.</EmptyState> : (
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Recent orders</caption>
            <thead><tr><th scope="col" className={TH_CLASS}>Etsy order</th><th scope="col" className={TH_CLASS}>Date</th><th scope="col" className={TH_CLASS}>Status</th></tr></thead>
            <tbody>
              {openOrders.map((order) => (
                <tr key={order.id}>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/purchases/new?orderId=${order.id}`}>{order.etsyOrderId}</Link></td>
                  <td className={TD_CLASS}>{order.orderDate}</td><td className={TD_CLASS}>{order.status.replaceAll('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }

  const [detail, suppliers, business] = await Promise.all([
    orNotFound(getOrderDetail(db, tenant, assertUuidOrNotFound(orderId))),
    listSuppliers(db, tenant, { limit: CHOICES, offset: 0 }),
    loadBusinessContext(db, tenant),
  ]);
  if (detail.order.status === 'CANCELLED') {
    return (
      <>
        <PageHeader title="New supplier purchase" />
        <Notice tone="warning" title="This order is cancelled">
          Supplier purchases cannot be added to a cancelled order. <Link className="underline" href={`/app/orders/${detail.order.id}`}>Back to the order</Link>
        </Notice>
      </>
    );
  }
  const replaces = single(query.replaces);
  const today = instantToZonedDate(new Date(), business.timeZone);
  return (
    <>
      <PageHeader title="New supplier purchase" description="Record what you bought from a supplier for this order." />
      <PurchaseForm
        suppliers={suppliers.items.map((supplier) => ({ id: supplier.id, name: supplier.name, marketplace: supplier.marketplace }))}
        items={detail.items.map((item) => ({ id: item.id, productName: item.productName, quantity: item.quantity }))}
        etsyOrderId={detail.order.etsyOrderId}
        defaultDate={today}
        currency={business.baseCurrency}
        replacesPurchaseId={replaces && UUID.test(replaces) ? replaces : undefined}
      />
    </>
  );
}
