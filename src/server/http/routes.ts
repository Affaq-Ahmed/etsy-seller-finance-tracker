import 'server-only';
import type { z } from 'zod';
import type { AppConfig } from '@/server/config/env';
import { getContainer } from '@/server/container';
import { resolveSession, resolveTenant, type SessionDeps } from '@/server/auth/session';
import type { SessionContext, TenantContext } from '@/server/auth/tenant-context';
import { errorToResponse, HttpError, notFoundError, onboardingRequiredError, unauthenticatedError } from './errors';
import { assertSameOrigin } from './origin';
import { withNoStore } from './responses';

// Every app API route handler is built with sessionRoute() or tenantRoute()
// (enforced by tests/app/unit/static-guards.test.ts). They check the Origin of
// state-changing requests, derive identity from the session cookie only, and
// return generic, non-cacheable responses. Route parameters are validated by a
// schema; a malformed ID is answered exactly like a missing record (404).

export interface ApiDeps extends SessionDeps {
  readonly config: AppConfig;
}

export type DepsProvider = () => ApiDeps;

/** The second argument Next.js passes to dynamic route handlers. */
export interface RouteContextArg {
  readonly params: Promise<Record<string, string | string[] | undefined>>;
}

export type RouteHandler = (request: Request, context?: RouteContextArg) => Promise<Response>;

export interface RouteOptions<P> {
  readonly getDeps?: DepsProvider;
  /** Validates the dynamic route segments; omit for routes without any. */
  readonly params?: z.ZodType<P>;
}

export interface SessionRouteContext<P = undefined> {
  readonly deps: ApiDeps;
  readonly request: Request;
  readonly session: SessionContext;
  readonly params: P;
}

export interface TenantRouteContext<P = undefined> {
  readonly deps: ApiDeps;
  readonly request: Request;
  readonly tenant: TenantContext;
  readonly params: P;
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

async function readParams<P>(schema: z.ZodType<P> | undefined, context: RouteContextArg | undefined): Promise<P> {
  if (!schema) return undefined as P;
  const parsed = schema.safeParse(context ? await context.params : {});
  if (!parsed.success) throw notFoundError();
  return parsed.data;
}

// Both wrappers read request.headers before anything else. With Cache
// Components that is what keeps a GET handler from being prerendered at build
// time (where it would cache a response without a session).

/** Signed-in user, onboarded or not (e.g. onboarding itself). */
export function sessionRoute<P = undefined>(handler: (context: SessionRouteContext<P>) => Promise<Response>, options: RouteOptions<P> = {}): RouteHandler {
  return async (request, context) => {
    const requestHeaders = request.headers;
    let deps: ApiDeps | null = null;
    try {
      deps = (options.getDeps ?? getContainer)();
      assertSameOrigin(request, deps.config.auth.baseUrl);
      const session = await resolveSession(deps, requestHeaders);
      if (!session) throw unauthenticatedError();
      const params = await readParams(options.params, context);
      return withNoStore(await handler({ deps, request, session, params }));
    } catch (error) {
      return respondWithError(error, deps, request);
    }
  };
}

/** Signed-in user with a business; the tenant comes from the session only. */
export function tenantRoute<P = undefined>(handler: (context: TenantRouteContext<P>) => Promise<Response>, options: RouteOptions<P> = {}): RouteHandler {
  return async (request, context) => {
    const requestHeaders = request.headers;
    let deps: ApiDeps | null = null;
    try {
      deps = (options.getDeps ?? getContainer)();
      assertSameOrigin(request, deps.config.auth.baseUrl);
      const resolution = await resolveTenant(deps, requestHeaders);
      if (resolution.status === 'unauthenticated') throw unauthenticatedError();
      if (resolution.status === 'not_onboarded') throw onboardingRequiredError();
      const params = await readParams(options.params, context);
      return withNoStore(await handler({ deps, request, tenant: resolution.tenant, params }));
    } catch (error) {
      return respondWithError(error, deps, request);
    }
  };
}
