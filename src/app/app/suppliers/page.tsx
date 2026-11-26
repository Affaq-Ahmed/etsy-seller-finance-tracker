import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SupplierForm } from '@/components/suppliers/supplier-form';
import { EmptyState, PageHeader, Pager, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { getContainer } from '@/server/container';
import { pageFromSearchParams, type SearchParams } from '@/server/http/page-search';
import { listSuppliers } from '@/server/suppliers/service';

export const metadata: Metadata = { title: 'Suppliers' };

export default function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <SuppliersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function SuppliersContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const request = await pageFromSearchParams(searchParams);
  const page = await listSuppliers(getContainer().db, tenant, request);
  return (
    <>
      <PageHeader title="Suppliers" description="Where you buy the items you sell: eBay, Amazon, AliExpress or any other supplier." />
      {page.items.length === 0 ? <EmptyState>No suppliers yet. Add your first one below.</EmptyState> : (
        <table className={TABLE_CLASS}>
          <caption className="sr-only">Suppliers</caption>
          <thead><tr><th scope="col" className={TH_CLASS}>Name</th><th scope="col" className={TH_CLASS}>Marketplace</th><th scope="col" className={TH_CLASS}>Website</th></tr></thead>
          <tbody>
            {page.items.map((supplier) => (
              <tr key={supplier.id}>
                <td className={TD_CLASS}>{supplier.name}</td>
                <td className={TD_CLASS}>{supplier.marketplace}</td>
                <td className={TD_CLASS}>{supplier.websiteUrl ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager basePath="/app/suppliers" offset={page.page.offset} limit={page.page.limit} total={page.page.total} />
      <section className="mt-10" aria-labelledby="add-supplier">
        <h2 id="add-supplier" className="mb-4 text-lg font-semibold">Add a supplier</h2>
        <SupplierForm />
      </section>
    </>
  );
}
