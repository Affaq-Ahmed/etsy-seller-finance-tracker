'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { REGISTERED_QUERY_PARAM, SIGN_IN_PATH } from '@/lib/paths';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/policy';
import { TextField } from '@/components/forms/text-field';
import { FormError, SubmitButton } from '@/components/forms/form-shell';
import { messageForStatus } from './messages';

const CHECK_DETAILS = `Check your details. Passwords need ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`;

export function SignUpForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signUp.email({
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    if (failure) {
      setPending(false);
      setError(messageForStatus(failure.status, failure.status === 400 ? CHECK_DETAILS : undefined));
      return;
    }
    // No session is created at sign-up; the same response is returned whether
    // or not the email was already registered.
    router.push(`${SIGN_IN_PATH}?${REGISTERED_QUERY_PARAM}=1`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
      <FormError message={error} />
      <TextField id="name" name="name" label="Your name" type="text" autoComplete="name" required maxLength={200} disabled={pending} />
      <TextField id="email" name="email" label="Email" type="email" autoComplete="email" required disabled={pending} />
      <TextField
        id="password"
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        hint={`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`}
        disabled={pending}
      />
      <SubmitButton pending={pending}>{pending ? 'Creating account…' : 'Create account'}</SubmitButton>
      <p className="text-sm">
        Already registered?{' '}
        <Link href={SIGN_IN_PATH} className="underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
