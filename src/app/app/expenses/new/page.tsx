import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { instantToZonedDate } from '@/lib/dates';
import { ExpenseForm } from '@/components/expenses/expense-form';
import { PageHeader } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { loadBusinessContext } from '@/server/business/context';
import { getContainer } from '@/server/container';
import type { SearchParams } from '@/server/http/page-search';
import { assertUuidOrNotFound, orNotFound } from '@/server/http/pages';
import { getOrderDetail } from '@/server/orders/service';

export const metadata: Metadata = { title: 'New expense' };

export default function NewExpensePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <NewExpenseContent searchParams={searchParams} />
    </Suspense>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function NewExpenseContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const { db } = getContainer();
  const orderId = single((await searchParams).orderId);
  const business = await loadBusinessContext(db, tenant);
  const today = instantToZonedDate(new Date(), business.timeZone);

  if (orderId === undefined) {
    return (
      <>
        <PageHeader
          title="New shared expense"
          description="A shared expense belongs to the business, not to one order, for example a subscription. To record an expense for one order, open the order and choose “Record order expense”."
        />
        <ExpenseForm target={{ kind: 'SHARED' }} defaultDate={today} currency={business.baseCurrency} />
        <p className="mt-6 text-sm"><Link className="underline" href="/app/orders">Choose an order instead</Link></p>
      </>
    );
  }

  const detail = await orNotFound(getOrderDetail(db, tenant, assertUuidOrNotFound(orderId)));
  return (
    <>
      <PageHeader title="New order expense" description="Record a cost that belongs to this one order." />
      <ExpenseForm
        target={{ kind: 'DIRECT', orderId: detail.order.id, etsyOrderId: detail.order.etsyOrderId, orderCancelled: detail.order.status === 'CANCELLED' }}
        defaultDate={today}
        currency={business.baseCurrency}
      />
    </>
  );
}
