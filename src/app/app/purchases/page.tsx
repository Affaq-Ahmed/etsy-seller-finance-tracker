import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Amount, EmptyState, PageHeader, Pager, StatusBadge, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { getContainer } from '@/server/container';
import { pageFromSearchParams, type SearchParams } from '@/server/http/page-search';
import { listPurchases } from '@/server/purchases/service';

export const metadata: Metadata = { title: 'Purchases' };

export default function PurchasesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <PurchasesContent searchParams={searchParams} />
    </Suspense>
  );
}

async function PurchasesContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const request = await pageFromSearchParams(searchParams);
  const page = await listPurchases(getContainer().db, tenant, request);
  return (
    <>
      <PageHeader title="Supplier purchases" description="Only confirmed purchases count toward profit. Start a purchase from an order's page." />
      {page.items.length === 0 ? <EmptyState>No purchases yet. Open an order and choose “Record supplier purchase”.</EmptyState> : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Supplier purchases, newest first</caption>
            <thead><tr>
              <th scope="col" className={TH_CLASS}>Supplier</th><th scope="col" className={TH_CLASS}>Reference</th><th scope="col" className={TH_CLASS}>Purchase date</th>
              <th scope="col" className={TH_CLASS}>Status</th><th scope="col" className={`${TH_CLASS} text-right`}>Total</th>
            </tr></thead>
            <tbody>
              {page.items.map((purchase) => (
                <tr key={purchase.id}>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/purchases/${purchase.id}`}>{purchase.supplierName}</Link></td>
                  <td className={TD_CLASS}>{purchase.supplierOrderReference ?? '—'}</td>
                  <td className={TD_CLASS}>{purchase.purchaseDate ?? '—'}</td>
                  <td className={TD_CLASS}><StatusBadge status={purchase.effectiveStatus} /></td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={purchase.totalAmount} currency={purchase.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager basePath="/app/purchases" offset={page.page.offset} limit={page.page.limit} total={page.page.total} />
    </>
  );
}
