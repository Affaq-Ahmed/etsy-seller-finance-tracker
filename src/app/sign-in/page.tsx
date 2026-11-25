// public: sign-in form; Better Auth enforces validation, CSRF and rate limits.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { FormShell } from '@/components/forms/form-shell';
import { SignInForm } from '@/components/auth/sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <FormShell title="Sign in">
      {/* The form reads the query string, which is request-time data. */}
      <Suspense fallback={<p>Loading…</p>}>
        <SignInForm />
      </Suspense>
    </FormShell>
  );
}
