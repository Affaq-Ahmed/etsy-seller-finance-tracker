'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { EXPENSE_CATEGORY_OPTIONS, EXPENSE_REFERENCE_INPUT_PATTERN, EXPENSE_REFERENCE_MAX_LENGTH } from '@/lib/expenses';
import { SIGN_IN_PATH } from '@/lib/paths';
import { NOTES_MAX_LENGTH, PII_WARNING } from '@/lib/validation';
import { DateField, MoneyField, SelectField, TextAreaField } from '@/components/forms/fields';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { TextField } from '@/components/forms/text-field';
import { Notice } from '@/components/ui/primitives';

const LABELS = {
  categoryType: 'Category', amount: 'Amount', expenseDate: 'Expense date', description: 'Description', sourceReference: 'Reference', orderId: 'Order', currency: 'Currency',
};

/** An expense for one order (DIRECT) or for the business (SHARED). A DIRECT expense needs the order. */
export type ExpenseFormTarget =
  | { readonly kind: 'SHARED' }
  | { readonly kind: 'DIRECT'; readonly orderId: string; readonly etsyOrderId: string; readonly orderCancelled: boolean };

export function ExpenseForm({ target, defaultDate, currency }: {
  readonly target: ExpenseFormTarget; readonly defaultDate: string; readonly currency: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    setPending(true);
    setError(null);
    const result = await callApi<{ expense: { id: string } }>('/api/v1/expenses', 'POST', {
      expenseType: target.kind,
      ...(target.kind === 'DIRECT' ? { orderId: target.orderId } : {}),
      categoryType: text('categoryType'),
      amount: text('amount'),
      expenseDate: text('expenseDate'),
      description: text('description'),
      sourceReference: text('sourceReference') || null,
    });
    if (!result.ok) {
      setPending(false);
      if (result.failure.status === 401) router.push(SIGN_IN_PATH);
      else setError(describeFailure(result.failure, LABELS));
      return;
    }
    router.push(`/app/expenses/${result.data.expense.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5" aria-busy={pending}>
      <FormError message={error} />
      <Notice title={target.kind === 'DIRECT' ? `Draft expense for Etsy order ${target.etsyOrderId}` : 'Draft shared business expense'}>
        Saving creates a draft. Nothing counts toward profit until you confirm the expense. {PII_WARNING}
      </Notice>
      {target.kind === 'DIRECT' && target.orderCancelled ? (
        <Notice tone="warning" title="This order is cancelled">
          An expense on a cancelled order is still valid and counts toward its profit, which shows the loss. Confirm it only if it is a real cost.
        </Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField id="categoryType" name="categoryType" label="Category" required defaultValue="" disabled={pending}>
          <option value="" disabled>Choose a category</option>
          {EXPENSE_CATEGORY_OPTIONS.map((option) => <option key={option.type} value={option.type}>{option.label}</option>)}
        </SelectField>
        <MoneyField id="amount" name="amount" label={`Amount (${currency})`} required disabled={pending} hint="Above zero, at most 2 decimals." />
        <DateField id="expenseDate" name="expenseDate" label="Expense date" required defaultValue={defaultDate} disabled={pending} />
        <TextField id="sourceReference" name="sourceReference" label="Reference (optional)" maxLength={EXPENSE_REFERENCE_MAX_LENGTH} pattern={EXPENSE_REFERENCE_INPUT_PATTERN} hint="An invoice or receipt number." disabled={pending} />
      </div>
      <TextAreaField id="expense-description" name="description" label="Description (optional)" maxLength={NOTES_MAX_LENGTH} disabled={pending} />
      <ul className="list-disc pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        <li>Payoneer fees come from Payoneer transactions (a later phase), so they cannot be entered here.</li>
        <li>Supplier costs belong in supplier purchases.</li>
        <li>Etsy fees are already deducted from the net payable, so do not enter them again.</li>
        <li>Refund-related means costs caused by a refund (for example return postage), not the refund amount.</li>
      </ul>
      <SubmitButton pending={pending}>{pending ? 'Saving…' : 'Save draft expense'}</SubmitButton>
    </form>
  );
}
