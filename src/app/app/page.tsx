import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PageHeader, PrimaryLink, SecondaryLink } from '@/components/ui/primitives';
import { getBusinessSummary } from '@/server/business/summary';
import { getContainer } from '@/server/container';
import { requireTenant } from '@/server/auth/page-guards';

export const metadata: Metadata = { title: 'Your business' };

export default function AppHomePage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <BusinessHeader />
    </Suspense>
  );
}

async function BusinessHeader() {
  const tenant = await requireTenant();
  const business = await getBusinessSummary(getContainer().db, tenant);
  return (
    <>
      <PageHeader
        title={business?.shopName ?? 'Your business'}
        description="Record Etsy orders and the supplier purchases behind them. Payouts, expenses and reports arrive in later phases."
        actions={<><PrimaryLink href="/app/orders/new">New order</PrimaryLink><SecondaryLink href="/app/purchases">Purchases</SecondaryLink></>}
      />
    </>
  );
}
