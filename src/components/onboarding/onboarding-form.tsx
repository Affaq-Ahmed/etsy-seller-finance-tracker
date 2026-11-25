'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { APP_HOME_PATH, ONBOARDING_API_PATH, SIGN_IN_PATH } from '@/lib/paths';
import { SHOP_NAME_MAX_LENGTH } from '@/lib/policy';
import { TextField } from '@/components/forms/text-field';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { messageForStatus } from '@/components/auth/messages';

export function OnboardingForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    let status: number | undefined;
    try {
      // The tenant is derived from the session cookie on the server; only the shop name is sent.
      const response = await fetch(ONBOARDING_API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopName: String(form.get('shopName') ?? '') }),
      });
      status = response.status;
    } catch {
      status = undefined;
    }
    if (status === 200 || status === 201) {
      router.push(APP_HOME_PATH);
      router.refresh();
      return;
    }
    if (status === 401) {
      router.push(SIGN_IN_PATH);
      return;
    }
    setPending(false);
    setError(messageForStatus(status, status === 400 ? `Enter a shop name of up to ${SHOP_NAME_MAX_LENGTH} characters.` : undefined));
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
      <FormError message={error} />
      <TextField
        id="shopName"
        name="shopName"
        label="Etsy shop name"
        type="text"
        autoComplete="organization"
        required
        maxLength={SHOP_NAME_MAX_LENGTH}
        hint="One business per account. You can't switch to another business later."
        disabled={pending}
      />
      <SubmitButton pending={pending}>{pending ? 'Creating…' : 'Create business'}</SubmitButton>
    </form>
  );
}
