import 'server-only';
import type { AppConfig } from '@/server/config/env';
import { getContainer } from '@/server/container';
import { resolveSession, resolveTenant, type SessionDeps } from '@/server/auth/session';
import type { SessionContext, TenantContext } from '@/server/auth/tenant-context';
import { errorToResponse, HttpError, onboardingRequiredError, unauthenticatedError } from './errors';
import { assertSameOrigin } from './origin';
import { withNoStore } from './responses';

// Every app API route handler is built with sessionRoute() or tenantRoute()
// (enforced by tests/app/unit/static-guards.test.ts). They check the Origin of
// state-changing requests, derive identity from the session cookie only, and
// return generic, non-cacheable responses.

export interface ApiDeps extends SessionDeps {
  readonly config: AppConfig;
}

export type DepsProvider = () => ApiDeps;
export type RouteHandler = (request: Request) => Promise<Response>;

export interface SessionRouteContext {
  readonly deps: ApiDeps;
  readonly request: Request;
  readonly session: SessionContext;
}

export interface TenantRouteContext {
  readonly deps: ApiDeps;
  readonly request: Request;
  readonly tenant: TenantContext;
}

/** Set-Cookie values that expire Better Auth session cookies the request carried. */
async function clearStaleSessionCookies(deps: ApiDeps, request: Request): Promise<string[]> {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return [];
  const present = new Set(cookieHeader.split(';').map((part) => part.trim().split('=')[0]));
  const { authCookies } = await deps.auth.$context;
  return [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken]
    .filter((cookie) => present.has(cookie.name))
    .map(({ name, attributes }) => [
      `${name}=`,
      'Max-Age=0',
      `Path=${attributes.path ?? '/'}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(attributes.secure ? ['Secure'] : []),
    ].join('; '));
}

async function respondWithError(error: unknown, deps: ApiDeps | null, request: Request): Promise<Response> {
  const response = errorToResponse(error);
  if (deps && error instanceof HttpError && error.status === 401) {
    for (const cookie of await clearStaleSessionCookies(deps, request)) response.headers.append('Set-Cookie', cookie);
  }
  return response;
}

// Both wrappers read request.headers before anything else. With Cache
// Components that is what keeps a GET handler from being prerendered at build
// time (where it would cache a response without a session).

/** Signed-in user, onboarded or not (e.g. onboarding itself). */
export function sessionRoute(handler: (context: SessionRouteContext) => Promise<Response>, getDeps: DepsProvider = getContainer): RouteHandler {
  return async (request) => {
    const requestHeaders = request.headers;
    let deps: ApiDeps | null = null;
    try {
      deps = getDeps();
      assertSameOrigin(request, deps.config.auth.baseUrl);
      const session = await resolveSession(deps, requestHeaders);
      if (!session) throw unauthenticatedError();
      return withNoStore(await handler({ deps, request, session }));
    } catch (error) {
      return respondWithError(error, deps, request);
    }
  };
}

/** Signed-in user with a business; the tenant comes from the session only. */
export function tenantRoute(handler: (context: TenantRouteContext) => Promise<Response>, getDeps: DepsProvider = getContainer): RouteHandler {
  return async (request) => {
    const requestHeaders = request.headers;
    let deps: ApiDeps | null = null;
    try {
      deps = getDeps();
      assertSameOrigin(request, deps.config.auth.baseUrl);
      const resolution = await resolveTenant(deps, requestHeaders);
      if (resolution.status === 'unauthenticated') throw unauthenticatedError();
      if (resolution.status === 'not_onboarded') throw onboardingRequiredError();
      return withNoStore(await handler({ deps, request, tenant: resolution.tenant }));
    } catch (error) {
      return respondWithError(error, deps, request);
    }
  };
}
