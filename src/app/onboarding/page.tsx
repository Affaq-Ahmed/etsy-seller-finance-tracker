import { Suspense } from 'react';
import type { Metadata } from 'next';
import { FormShell } from '@/components/forms/form-shell';
import { OnboardingForm } from '@/components/onboarding/onboarding-form';
import { requireOnboardingSession } from '@/server/auth/page-guards';

export const metadata: Metadata = { title: 'Set up your business' };

export default function OnboardingPage() {
  return (
    <FormShell title="Set up your business">
      <Suspense fallback={<p>Loading…</p>}>
        <OnboardingGate />
      </Suspense>
    </FormShell>
  );
}

async function OnboardingGate() {
  // Signed out → /sign-in; already onboarded → /app.
  await requireOnboardingSession();
  return <OnboardingForm />;
}
