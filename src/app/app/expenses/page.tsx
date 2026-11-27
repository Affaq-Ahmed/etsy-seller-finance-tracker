import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Amount, EmptyState, PageHeader, Pager, PrimaryLink, StatusBadge, TABLE_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { getContainer } from '@/server/container';
import { listExpenses } from '@/server/expenses/service';
import { pageFromSearchParams, type SearchParams } from '@/server/http/page-search';

export const metadata: Metadata = { title: 'Expenses' };

export default function ExpensesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ExpensesContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ExpensesContent({ searchParams }: { searchParams: SearchParams }) {
  const tenant = await requireTenant();
  const request = await pageFromSearchParams(searchParams);
  const page = await listExpenses(getContainer().db, tenant, request);
  return (
    <>
      <PageHeader
        title="Expenses"
        description="Only confirmed expenses count. An order expense counts toward that order's profit; start one from the order's page. Shared business expenses are recorded here and are not part of any order's profit."
        actions={<PrimaryLink href="/app/expenses/new">New shared expense</PrimaryLink>}
      />
      {page.items.length === 0 ? <EmptyState>No expenses yet. Record a shared expense here, or open an order and choose “Record order expense”.</EmptyState> : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">Expenses, newest first</caption>
            <thead><tr>
              <th scope="col" className={TH_CLASS}>Category</th><th scope="col" className={TH_CLASS}>Applies to</th><th scope="col" className={TH_CLASS}>Date</th>
              <th scope="col" className={TH_CLASS}>Status</th><th scope="col" className={`${TH_CLASS} text-right`}>Amount</th>
            </tr></thead>
            <tbody>
              {page.items.map((expense) => (
                <tr key={expense.id}>
                  <td className={TD_CLASS}><Link className="underline" href={`/app/expenses/${expense.id}`}>{expense.categoryName}</Link></td>
                  <td className={TD_CLASS}>
                    {expense.orderId ? <Link className="underline" href={`/app/orders/${expense.orderId}`}>Order {expense.etsyOrderId}</Link> : 'Shared (business)'}
                  </td>
                  <td className={TD_CLASS}>{expense.expenseDate}</td>
                  <td className={TD_CLASS}><StatusBadge status={expense.effectiveStatus} /></td>
                  <td className={`${TD_CLASS} text-right`}><Amount value={expense.amount} currency={expense.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager basePath="/app/expenses" offset={page.page.offset} limit={page.page.limit} total={page.page.total} />
    </>
  );
}
