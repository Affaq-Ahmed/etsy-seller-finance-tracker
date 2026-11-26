import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ProductForm } from '@/components/products/product-form';
import { Amount, EmptyState, PageHeader, Pager, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { loadBusinessContext } from '@/server/business/context';
import { getContainer } from '@/server/container';
import { pageFromSearchParams, type SearchParams } from '@/server/http/page-search';
import { listProducts } from '@/server/products/service';
import { listSuppliers } from '@/server/suppliers/service';

export const metadata: Metadata = { title: 'Products' };

const SUPPLIER_CHOICES = 100;

export default function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ProductsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProductsContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const { db } = getContainer();
  const request = await pageFromSearchParams(searchParams);
  const [page, suppliers, business] = await Promise.all([
    listProducts(db, tenant, request),
    listSuppliers(db, tenant, { limit: SUPPLIER_CHOICES, offset: 0 }),
    loadBusinessContext(db, tenant),
  ]);
  return (
    <>
      <PageHeader title="Products" description="A simple catalog you can pick from when entering orders. It is not inventory. Default costs are for your reference and never count as actual costs." />
      {page.items.length === 0 ? <EmptyState>No products yet. You can also type items directly when entering an order.</EmptyState> : (
        <table className={TABLE_CLASS}>
          <caption className="sr-only">Products</caption>
          <thead><tr>
            <th scope="col" className={TH_CLASS}>Name</th><th scope="col" className={TH_CLASS}>SKU</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Default cost (reference only)</th>
          </tr></thead>
          <tbody>
            {page.items.map((product) => (
              <tr key={product.id}>
                <td className={TD_CLASS}>{product.name}</td>
                <td className={TD_CLASS}>{product.sku ?? '—'}</td>
                <td className={`${TD_CLASS} text-right`}>{product.defaultUnitCost === null ? '—' : <Amount value={product.defaultUnitCost} currency={product.currency} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager basePath="/app/products" offset={page.page.offset} limit={page.page.limit} total={page.page.total} />
      <section className="mt-10" aria-labelledby="add-product">
        <h2 id="add-product" className="mb-4 text-lg font-semibold">Add a product</h2>
        <ProductForm suppliers={suppliers.items.map((supplier) => ({ id: supplier.id, name: supplier.name }))} currency={business.baseCurrency} />
      </section>
    </>
  );
}
