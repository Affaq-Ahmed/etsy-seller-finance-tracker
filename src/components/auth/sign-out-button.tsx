'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { SIGN_IN_PATH } from '@/lib/paths';
import { FormError } from '@/components/forms/form-shell';
import { GENERIC_ERROR } from './messages';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signOut();
    if (failure) {
      setPending(false);
      setError(GENERIC_ERROR);
      return;
    }
    router.push(SIGN_IN_PATH);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <FormError message={error} />
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        aria-busy={pending}
        className="self-start rounded-md border border-zinc-400 px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60 dark:border-zinc-600"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
