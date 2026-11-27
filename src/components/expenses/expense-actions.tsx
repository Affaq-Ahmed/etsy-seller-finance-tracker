'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, describeFailure } from '@/lib/api-client';
import { EXPENSE_REVERSAL_REASON_MAX_LENGTH } from '@/lib/expenses';
import { SIGN_IN_PATH } from '@/lib/paths';
import { SMALL_BUTTON, TextAreaField } from '@/components/forms/fields';
import { FormError } from '@/components/forms/form-shell';

type Step = null | 'confirm' | 'void' | 'reverse';

export function ExpenseActions({ expenseId, amountLabel, canConfirm, canVoid, canReverse }: {
  readonly expenseId: string; readonly amountLabel: string;
  readonly canConfirm: boolean; readonly canVoid: boolean; readonly canReverse: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canConfirm && !canVoid && !canReverse) return null;

  async function run(action: 'confirm' | 'void' | 'reverse', body?: unknown) {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/v1/expenses/${expenseId}/${action}`, 'POST', body);
    setPending(false);
    if (!result.ok) {
      if (result.failure.status === 401) {
        router.push(SIGN_IN_PATH);
      } else {
        setError(describeFailure(result.failure, { reason: 'Reason' }));
        // 409: the expense changed elsewhere (for example it was confirmed in another tab). Close the open confirmation
        // panel, which belongs to the old state, and re-render with the real state so stale buttons disappear. The
        // message stays visible while any action is still offered; when none is left, the page's own state notice
        // (Confirmed, Reversed, Voided) replaces this panel.
        if (result.failure.status === 409) {
          setStep(null);
          router.refresh();
        }
      }
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
        {canConfirm ? <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => setStep('confirm')}>Confirm expense</button> : null}
        {canVoid ? <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => setStep('void')}>Void draft</button> : null}
        {canReverse ? <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => setStep('reverse')}>Reverse expense</button> : null}
      </div>
      {canReverse ? <p className="text-sm text-zinc-600 dark:text-zinc-400">A confirmed expense cannot be edited. To correct it, reverse it, then record a new expense.</p> : null}

      {step === 'confirm' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Confirming records {amountLabel} as a real expense, once, and counts it toward profit. The expense can no longer be edited. You can correct a mistake later by reversing it.</p>
          <div className="flex gap-2">
            <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => void run('confirm')}>{pending ? 'Confirming…' : 'Yes, confirm'}</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setStep(null)}>Not yet</button>
          </div>
        </div>
      ) : null}
      {step === 'void' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Voiding discards this draft. Nothing was posted, so profit is unaffected. To correct it, record a new expense.</p>
          <div className="flex gap-2">
            <button type="button" className={SMALL_BUTTON} disabled={pending} onClick={() => void run('void')}>Yes, void the draft</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setStep(null)}>Keep draft</button>
          </div>
        </div>
      ) : null}
      {step === 'reverse' ? (
        <form onSubmit={onReverse} className="flex flex-col gap-2 rounded-md border border-amber-700 p-3 text-sm dark:border-amber-400">
          <p>Reversing posts the exact opposite entry and removes this expense from profit. The original entry is kept. Record a corrected expense afterwards if needed.</p>
          <TextAreaField id="reverse-reason" name="reason" label="Reason (required)" required maxLength={EXPENSE_REVERSAL_REASON_MAX_LENGTH} />
          <div className="flex gap-2">
            <button type="submit" className={SMALL_BUTTON} disabled={pending}>{pending ? 'Reversing…' : 'Reverse expense'}</button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setStep(null)}>Back</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
