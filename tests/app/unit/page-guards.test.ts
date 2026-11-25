import { describe, expect, it, vi } from 'vitest';
import type { TenantResolution } from '@/server/auth/session';
import type { TenantId } from '@/server/auth/tenant-context';

class RedirectSignal extends Error {
  constructor(readonly path: string) {
    super(`redirect:${path}`);
  }
}

// next/navigation's redirect() throws to interrupt rendering; mirror that.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new RedirectSignal(path);
  },
}));

const { decideSessionAccess, decideTenantAccess } = await import('@/server/auth/page-guards');

const session = { userId: 'user-1', sessionId: 'session-1' };
const tenant = { ...session, accountId: '00000000-0000-4000-8000-000000000001' as TenantId };
const unauthenticated: TenantResolution = { status: 'unauthenticated' };
const notOnboarded: TenantResolution = { status: 'not_onboarded', session };
const onboarded: TenantResolution = { status: 'ok', tenant };

function redirectOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.path;
    throw error;
  }
  throw new Error('expected a redirect');
}

describe('page access decisions (T7, T13)', () => {
  it('sends unauthenticated visitors to sign-in from every guard', () => {
    expect(redirectOf(() => decideTenantAccess(unauthenticated))).toBe('/sign-in');
    expect(redirectOf(() => decideSessionAccess(unauthenticated, { redirectOnboarded: false }))).toBe('/sign-in');
    expect(redirectOf(() => decideSessionAccess(unauthenticated, { redirectOnboarded: true }))).toBe('/sign-in');
  });

  it('sends signed-in users without a business to onboarding', () => {
    expect(redirectOf(() => decideTenantAccess(notOnboarded))).toBe('/onboarding');
    expect(decideSessionAccess(notOnboarded, { redirectOnboarded: true })).toEqual(session);
  });

  it('returns the session-derived tenant for onboarded users', () => {
    expect(decideTenantAccess(onboarded)).toEqual(tenant);
    expect(decideSessionAccess(onboarded, { redirectOnboarded: false })).toEqual(session);
  });

  it('sends onboarded users away from onboarding', () => {
    expect(redirectOf(() => decideSessionAccess(onboarded, { redirectOnboarded: true }))).toBe('/app');
  });
});
