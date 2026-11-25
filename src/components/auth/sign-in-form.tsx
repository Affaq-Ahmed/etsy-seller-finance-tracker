'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { APP_HOME_PATH, REGISTERED_QUERY_PARAM, SIGN_UP_PATH } from '@/lib/paths';
import { PASSWORD_MAX_LENGTH } from '@/lib/policy';
import { TextField } from '@/components/forms/text-field';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { INVALID_CREDENTIALS, messageForStatus, REGISTERED_NOTICE } from './messages';

export function SignInForm() {
  const router = useRouter();
  const registered = useSearchParams().get(REGISTERED_QUERY_PARAM) === '1';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signIn.email({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    if (failure) {
      setPending(false);
      setError(messageForStatus(failure.status, failure.status === 401 ? INVALID_CREDENTIALS : undefined));
      return;
    }
    // The app home sends users without a business to onboarding.
    router.push(APP_HOME_PATH);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
      <div aria-live="polite">
        {registered ? <p className="rounded-md border border-zinc-400 px-3 py-2 text-sm">{REGISTERED_NOTICE}</p> : null}
      </div>
      <FormError message={error} />
      <TextField id="email" name="email" label="Email" type="email" autoComplete="email" required disabled={pending} />
      <TextField
        id="password"
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        disabled={pending}
      />
      <SubmitButton pending={pending}>{pending ? 'Signing in…' : 'Sign in'}</SubmitButton>
      <p className="text-sm">
        New here?{' '}
        <Link href={SIGN_UP_PATH} className="underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
