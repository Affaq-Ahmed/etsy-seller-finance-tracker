import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { getBusinessSummary } from '@/server/business/summary';
import { getContainer } from '@/server/container';
import { requireTenant } from '@/server/auth/page-guards';

export const metadata: Metadata = { title: 'Your business' };

// Placeholder home for signed-in, onboarded users. Dashboard features are out
// of scope for the authentication milestone.
export default function AppHomePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p>Loading…</p>}>
        <BusinessHeader />
      </Suspense>
    </main>
  );
}

async function BusinessHeader() {
  const tenant = await requireTenant();
  const business = await getBusinessSummary(getContainer().db, tenant);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{business?.shopName ?? 'Your business'}</h1>
      <p className="text-zinc-600 dark:text-zinc-400">You are signed in. Financial features arrive in later milestones.</p>
      <SignOutButton />
    </>
  );
}
