import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_HOME_PATH, ONBOARDING_PATH, SIGN_IN_PATH } from '@/lib/paths';
import { getContainer } from '@/server/container';
import { resolveTenant, type TenantResolution } from './session';
import type { SessionContext, TenantContext } from './tenant-context';

// Guards for Server Components. Each protected page calls one of these itself;
// layouts and proxy.ts are not a security boundary. With Cache Components the
// caller must sit inside <Suspense>, and nothing here may run in 'use cache'.

// Pure decision logic, exported for tests. `redirect()` throws, so these
// never return when they redirect.

export function decideTenantAccess(resolution: TenantResolution): TenantContext {
  if (resolution.status === 'unauthenticated') redirect(SIGN_IN_PATH);
  if (resolution.status === 'not_onboarded') redirect(ONBOARDING_PATH);
  return resolution.tenant;
}

export function decideSessionAccess(resolution: TenantResolution, options: { readonly redirectOnboarded: boolean }): SessionContext {
  if (resolution.status === 'unauthenticated') redirect(SIGN_IN_PATH);
  if (resolution.status === 'not_onboarded') return resolution.session;
  if (options.redirectOnboarded) redirect(APP_HOME_PATH);
  return { userId: resolution.tenant.userId, sessionId: resolution.tenant.sessionId };
}

// Memoized per request (React cache), never across requests. headers() is read
// first: it is what makes the page request-time instead of prerendered.
const resolveCurrentRequest = cache(async (): Promise<TenantResolution> => {
  const requestHeaders = await headers();
  return resolveTenant(getContainer(), requestHeaders);
});

/** Signed in (onboarded or not); otherwise redirect to sign-in. */
export async function requireSession(): Promise<SessionContext> {
  return decideSessionAccess(await resolveCurrentRequest(), { redirectOnboarded: false });
}

/** Signed in and onboarded; otherwise redirect to sign-in or onboarding. */
export async function requireTenant(): Promise<TenantContext> {
  return decideTenantAccess(await resolveCurrentRequest());
}

/** Signed in and not yet onboarded; onboarded users go to the app home. */
export async function requireOnboardingSession(): Promise<SessionContext> {
  return decideSessionAccess(await resolveCurrentRequest(), { redirectOnboarded: true });
}
