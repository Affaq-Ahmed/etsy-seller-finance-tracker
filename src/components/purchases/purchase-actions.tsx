'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { SIGN_IN_PATH } from '@/lib/paths';
import { SMALL_BUTTON, TextAreaField } from '@/components/forms/fields';
import { FormError } from '@/components/forms/form-shell';

type Step = null | 'confirm' | 'cancel' | 'reverse';

export function PurchaseActions({ purchaseId, totalLabel, canConfirm, canCancel, canReverse, canEdit }: {
  readonly purchaseId: string; readonly totalLabel: string;
  readonly canConfirm: boolean; readonly canCancel: boolean; readonly canReverse: boolean; readonly canEdit: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canConfirm && !canCancel && !canReverse) return null;

  async function run(action: 'confirm' | 'cancel' | 'reverse', body?: unknown) {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/v1/purchases/${purchaseId}/${action}`, 'POST', body);
    setPending(false);
    if (!result.ok) {
      if (result.failure.status === 401) router.push(SIGN_IN_PATH);
      else setError(describeFailure(result.failure, { reason: 'Reason' }));
      return;
    }
    setStep(null);
    router.refresh();
  }

  function onReverse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run('reverse', { reason: String(new FormData(event.currentTarget).get('reason') ?? '').trim() });
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {canConfirm ? <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => setStep('confirm')}>Confirm purchase</button> : null}
        {canCancel ? <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => setStep('cancel')}>Cancel draft</button> : null}
        {canReverse ? <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => setStep('reverse')}>Reverse purchase</button> : null}
      </div>
      {!canEdit && canReverse ? <p className="text-sm text-zinc-600 dark:text-zinc-400">A confirmed purchase cannot be edited. To correct it, reverse it, then record a new purchase.</p> : null}

      {step === 'confirm' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Confirming records {totalLabel} as a real supplier cost, once, and counts it toward profit. The purchase and its lines can no longer be edited. You can correct a mistake later by reversing it.</p>
          <div className="flex gap-2">
            <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => void run('confirm')}>{pending ? 'Confirming…' : 'Yes, confirm'}</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setStep(null)}>Not yet</button>
          </div>
        </div>
      ) : null}
      {step === 'cancel' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Cancelling discards this draft. Nothing was posted, so profit is unaffected.</p>
          <div className="flex gap-2">
            <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => void run('cancel')}>Yes, cancel the draft</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setStep(null)}>Keep draft</button>
          </div>
        </div>
      ) : null}
      {step === 'reverse' ? (
        <form onSubmit={onReverse} className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Reversing posts the exact opposite entry and removes this cost from profit. The original entry is kept. Record a corrected purchase afterwards if needed.</p>
          <TextAreaField id="reverse-reason" name="reason" label="Reason (required)" required maxLength={500} />
          <div className="flex gap-2">
            <button type="submit" className={SMALL_BUTTON} disabled={pending}>{pending ? 'Reversing…' : 'Reverse purchase'}</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setStep(null)}>Back</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
