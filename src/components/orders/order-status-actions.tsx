'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { SIGN_IN_PATH } from '@/lib/paths';
import { DateField, SMALL_BUTTON } from '@/components/forms/fields';
import { FormError } from '@/components/forms/form-shell';

const STATUS_LABELS: Readonly<Record<string, string>> = {
  SUPPLIER_ORDERED: 'Mark supplier ordered', SHIPPED: 'Mark shipped', IN_TRANSIT: 'Mark in transit', DELIVERED: 'Mark delivered', CANCELLED: 'Cancel order',
};

export function OrderStatusActions({ orderId, allowedNext, defaultDate }: { readonly orderId: string; readonly allowedNext: readonly string[]; readonly defaultDate: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'DELIVERED' | 'CANCELLED' | null>(null);

  if (allowedNext.length === 0) return <p className="text-sm text-zinc-600 dark:text-zinc-400">No further status changes.</p>;

  async function change(status: string, deliveredDate?: string) {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/v1/orders/${orderId}/status`, 'POST', { status, ...(deliveredDate ? { deliveredDate } : {}) });
    setPending(false);
    if (!result.ok) {
      if (result.failure.status === 401) router.push(SIGN_IN_PATH);
      else setError(describeFailure(result.failure, { deliveredDate: 'Delivery date' }));
      return;
    }
    setAsking(null);
    router.refresh();
  }

  function onDeliver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change('DELIVERED', String(new FormData(event.currentTarget).get('deliveredDate') ?? ''));
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {allowedNext.map((status) => (
          <button key={status} type="button" className={SMALL_BUTTON} disabled={pending}
            onClick={() => (status === 'DELIVERED' || status === 'CANCELLED' ? setAsking(status) : void change(status))}>
            {STATUS_LABELS[status] ?? status}
          </button>
        ))}
      </div>
      {asking === 'DELIVERED' ? (
        <form onSubmit={onDeliver} className="flex flex-wrap items-end gap-3">
          <DateField id="deliveredDate" name="deliveredDate" label="Delivery date" required defaultValue={defaultDate} />
          <button type="submit" className={SMALL_BUTTON} disabled={pending}>Confirm delivered</button>
          <button type="button" className={SMALL_BUTTON} onClick={() => setAsking(null)}>Back</button>
        </form>
      ) : null}
      {asking === 'CANCELLED' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Cancelling an order is final. A cancelled order counts no Etsy revenue in profit. Supplier purchases you have already confirmed stay recorded and keep counting as costs, and nothing is reversed for you. New supplier purchases cannot be added to a cancelled order, and a draft purchase on it can no longer be confirmed, so confirm any purchase you have already made first.</p>
          <div className="flex gap-2">
            <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => void change('CANCELLED')}>Yes, cancel this order</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setAsking(null)}>Keep order</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
