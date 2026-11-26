import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { parseConfig, type AppConfig } from '@/server/config/env';
import { createContainer, type AppContainer } from '@/server/container';
import { resolveSession, resolveTenant } from '@/server/auth/session';
import type { SessionContext, TenantContext } from '@/server/auth/tenant-context';
import { onboardBusiness } from '@/server/onboarding/service';
import { sessionRoute, tenantRoute } from '@/server/http/routes';
import { postOnboarding } from '@/server/api/onboarding';
import { getBusiness } from '@/server/api/business';
import { getOrder, getOrders, patchOrder, postOrder, postOrderStatus } from '@/server/api/orders';
import { orderParamsSchema, purchaseParamsSchema } from '@/server/api/params';
import { getProducts, postProduct } from '@/server/api/products';
import {
  getPurchase, getPurchases, patchPurchase, postCancelPurchase, postConfirmPurchase, postPurchase, postReversePurchase,
} from '@/server/api/purchases';
import { getSuppliers, postSupplier } from '@/server/api/suppliers';
import { testDatabaseUrl } from './database';

export const TEST_ORIGIN = 'http://localhost:3000';
/** Satisfies the 12–128 character policy. Synthetic test value, not a secret. */
export const TEST_PASSWORD = 'synthetic-test-password-123';

export function testEnv(baseUrl: string = TEST_ORIGIN): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: baseUrl,
  };
}

export function testConfig(baseUrl?: string): AppConfig {
  return parseConfig(testEnv(baseUrl));
}

export function createTestApp(baseUrl?: string): AppContainer {
  return createContainer(testConfig(baseUrl));
}

export function uniqueEmail(label = 'user'): string {
  return `${label}-${randomUUID()}@example.test`;
}

/** A fresh documentation-range IPv4 address, so tests never share a rate-limit bucket. */
export function uniqueIp(): string {
  return `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

export interface AuthCallOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly cookie?: string;
  /** Defaults to the app origin; pass null to omit the header. */
  readonly origin?: string | null;
  readonly ip?: string;
  readonly headers?: Record<string, string>;
}

/** Calls Better Auth through its HTTP handler, as the browser client does. */
export function authCall(app: AppContainer, path: string, options: AuthCallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? app.config.auth.baseUrl : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.cookie) headers.set('cookie', options.cookie);
  headers.set('x-forwarded-for', options.ip ?? uniqueIp());
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return app.auth.handler(new Request(`${app.config.auth.baseUrl}/api/auth${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** `name=value` of the Better Auth session cookie set by a response, if any. */
export function sessionCookieFrom(response: Response): string | null {
  const cookie = setCookies(response).find((value) => /(^|\.)session_token=/.test(value.split(';')[0] ?? ''));
  if (!cookie) return null;
  const pair = cookie.split(';')[0] ?? '';
  return pair.endsWith('=') ? null : pair;
}

export function cookieHeaders(cookie: string): Headers {
  return new Headers({ cookie });
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export function newCredentials(label?: string): Credentials {
  return { email: uniqueEmail(label), password: TEST_PASSWORD, name: 'Test Seller' };
}

export async function signUp(app: AppContainer, credentials: Credentials, ip?: string): Promise<Response> {
  return authCall(app, '/sign-up/email', { body: credentials, ip });
}

export async function signIn(app: AppContainer, credentials: Pick<Credentials, 'email' | 'password'>, ip?: string): Promise<{ response: Response; cookie: string | null }> {
  const response = await authCall(app, '/sign-in/email', { body: { email: credentials.email, password: credentials.password }, ip });
  return { response, cookie: sessionCookieFrom(response) };
}

export interface SignedInUser {
  readonly credentials: Credentials;
  readonly cookie: string;
  readonly session: SessionContext;
}

export async function registerAndSignIn(app: AppContainer, label?: string): Promise<SignedInUser> {
  const credentials = newCredentials(label);
  const signUpResponse = await signUp(app, credentials);
  if (signUpResponse.status !== 200) throw new Error(`sign-up failed with ${signUpResponse.status}`);
  const { response, cookie } = await signIn(app, credentials);
  if (response.status !== 200 || !cookie) throw new Error(`sign-in failed with ${response.status}`);
  const session = await resolveSession(app, cookieHeaders(cookie));
  if (!session) throw new Error('session did not resolve');
  return { credentials, cookie, session };
}

export interface OnboardedUser extends SignedInUser {
  readonly tenant: TenantContext;
}

export async function registerAndOnboard(app: AppContainer, shopName: string, label?: string): Promise<OnboardedUser> {
  const user = await registerAndSignIn(app, label);
  await onboardBusiness(app.db, user.session, { shopName });
  const resolution = await resolveTenant(app, cookieHeaders(user.cookie));
  if (resolution.status !== 'ok') throw new Error(`tenant did not resolve: ${resolution.status}`);
  return { ...user, tenant: resolution.tenant };
}

/** The app's API routes wired to a test container instead of the process one. */
export function apiRoutes(app: AppContainer) {
  const getDeps = () => app;
  const order = { getDeps, params: orderParamsSchema };
  const purchase = { getDeps, params: purchaseParamsSchema };
  return {
    onboarding: sessionRoute(postOnboarding, { getDeps }),
    business: tenantRoute(getBusiness, { getDeps }),
    suppliers: { list: tenantRoute(getSuppliers, { getDeps }), create: tenantRoute(postSupplier, { getDeps }) },
    products: { list: tenantRoute(getProducts, { getDeps }), create: tenantRoute(postProduct, { getDeps }) },
    orders: {
      list: tenantRoute(getOrders, { getDeps }),
      create: tenantRoute(postOrder, { getDeps }),
      get: tenantRoute(getOrder, order),
      patch: tenantRoute(patchOrder, order),
      status: tenantRoute(postOrderStatus, order),
    },
    purchases: {
      list: tenantRoute(getPurchases, { getDeps }),
      create: tenantRoute(postPurchase, { getDeps }),
      get: tenantRoute(getPurchase, purchase),
      patch: tenantRoute(patchPurchase, purchase),
      confirm: tenantRoute(postConfirmPurchase, purchase),
      cancel: tenantRoute(postCancelPurchase, purchase),
      reverse: tenantRoute(postReversePurchase, purchase),
    },
  };
}

/** Calls a route handler the way Next.js does, including dynamic segments. */
export function callRoute(handler: (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>, request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handler(request, { params: Promise.resolve(params) });
}

export interface ApiCallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly cookie?: string;
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
  readonly query?: string;
}

export function apiRequest(app: AppContainer, path: string, options: ApiCallOptions = {}): Request {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? (method === 'GET' ? null : app.config.auth.baseUrl) : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.cookie) headers.set('cookie', options.cookie);
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`${app.config.auth.baseUrl}${path}${options.query ?? ''}`, { method, headers, body });
}
