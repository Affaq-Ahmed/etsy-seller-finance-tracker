import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ExpenseActions } from '@/components/expenses/expense-actions';
import { Amount, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { requireTenant } from '@/server/auth/page-guards';
import { getContainer } from '@/server/container';
import { getExpenseDetail } from '@/server/expenses/service';
import { assertUuidOrNotFound, orNotFound } from '@/server/http/pages';

export const metadata: Metadata = { title: 'Expense' };

export default function ExpensePage({ params }: { params: Promise<{ expenseId: string }> }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ExpenseContent params={params} />
    </Suspense>
  );
}

async function ExpenseContent({ params }: { params: Promise<{ expenseId: string }> }) {
  const tenant = await requireTenant();
  const expenseId = assertUuidOrNotFound((await params).expenseId);
  const detail = await orNotFound(getExpenseDetail(getContainer().db, tenant, expenseId));
  const { expense } = detail;
  return (
    <>
      <PageHeader
        title={expense.categoryName}
        description={`${expense.expenseDate}${expense.sourceReference ? ` · reference ${expense.sourceReference}` : ''}`}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={expense.effectiveStatus} />
        <span className="text-sm">Amount <Amount value={expense.amount} currency={expense.currency} /></span>
        <span className="text-sm">
          {expense.orderId ? <>Order expense for <Link className="underline" href={`/app/orders/${expense.orderId}`}>{expense.etsyOrderId}</Link></> : 'Shared business expense'}
        </span>
      </div>

      {expense.effectiveStatus === 'DRAFT' ? <div className="mb-6"><Notice title="Draft">This expense is not counted in profit and nothing has been posted to the ledger. Confirm it when the expense is final.</Notice></div> : null}
      {expense.effectiveStatus === 'CONFIRMED' ? (
        <div className="mb-6">
          <Notice>
            Confirmed {expense.confirmedDate}: {expense.orderId ? 'this cost counts toward the order’s profit and ' : 'this is a shared business expense, not part of any order’s profit, and it '}is recorded in the ledger as owed until you settle it in a later phase.
          </Notice>
        </div>
      ) : null}
      {expense.effectiveStatus === 'REVERSED' ? <div className="mb-6"><Notice tone="warning" title="Reversed">This expense was reversed with an exact opposite entry and no longer counts toward profit. The original entry is kept for the record.</Notice></div> : null}
      {expense.effectiveStatus === 'VOIDED' ? <div className="mb-6"><Notice title="Voided">This draft was discarded. Nothing was posted and it never counted toward profit.</Notice></div> : null}

      {expense.description ? <div className="mb-6"><Notice title="Description"><span className="whitespace-pre-line">{expense.description}</span></Notice></div> : null}

      <ExpenseActions
        expenseId={expense.id}
        amountLabel={`${expense.amount} ${expense.currency}`}
        canConfirm={detail.canConfirm} canVoid={detail.canVoid} canReverse={detail.canReverse}
      />
    </>
  );
}
