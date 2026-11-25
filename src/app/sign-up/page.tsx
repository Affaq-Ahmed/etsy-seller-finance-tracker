// public: registration form; Better Auth enforces validation, CSRF and rate limits.
import type { Metadata } from 'next';
import { FormShell } from '@/components/forms/form-shell';
import { SignUpForm } from '@/components/auth/sign-up-form';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpPage() {
  return (
    <FormShell title="Create your account">
      <SignUpForm />
    </FormShell>
  );
}
