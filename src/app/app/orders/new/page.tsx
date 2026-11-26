import { Suspense } from 'react';
import type { Metadata } from 'next';
import { instantToZonedDate } from '@/lib/dates';
import { OrderForm } from '@/components/orders/order-form';
import { PageHeader } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { loadBusinessContext } from '@/server/business/context';
import { getContainer } from '@/server/container';
import { listProducts } from '@/server/products/service';

export const metadata: Metadata = { title: 'New order' };

const PRODUCT_CHOICES = 100;

export default function NewOrderPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <NewOrderContent />
    </Suspense>
  );
}

async function NewOrderContent() {
  const tenant = await requireTenant();
  const { db } = getContainer();
  const [products, business] = await Promise.all([listProducts(db, tenant, { limit: PRODUCT_CHOICES, offset: 0 }), loadBusinessContext(db, tenant)]);
  // After the session read, so the current date is request-time data.
  const today = instantToZonedDate(new Date(), business.timeZone);
  return (
    <>
      <PageHeader title="New order" description="Enter an Etsy order by hand. One order can contain several products and quantities." />
      <OrderForm products={products.items.map((product) => ({ id: product.id, name: product.name, sku: product.sku }))} defaultDate={today} currency={business.baseCurrency} />
    </>
  );
}
