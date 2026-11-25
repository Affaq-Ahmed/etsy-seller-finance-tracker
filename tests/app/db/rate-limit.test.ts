import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { rateLimits } from '@/db/schema';
import type { AppContainer } from '@/server/container';
import { hasTestDatabase } from '../support/database';
import { authCall, createTestApp, newCredentials, uniqueIp } from '../support/app';

// Better Auth 1.7.25 defaults, kept unchanged: /sign-in* and /sign-up* allow
// 3 requests per 10 s per client IP and path.
const SPECIAL_RULE_MAX = 3;
const SPECIAL_RULE_WINDOW_MS = 10_000;

describe.skipIf(!hasTestDatabase)('T19 database-backed rate limiting (migration 0009)', () => {
  let app: AppContainer;
  beforeAll(() => {
    app = createTestApp();
  });
  afterAll(() => app?.close());

  const attempt = (ip: string, path = '/sign-in/email') =>
    authCall(app, path, { ip, body: path === '/sign-in/email' ? { email: newCredentials('rl').email, password: 'wrong-password-value' } : newCredentials('rl') });

  it('migration 0009 created rate_limit with a unique key', async () => {
    const indexes = await app.db.execute<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rate_limit'`);
    const definitions = [...indexes].map((row) => row.indexdef);
    expect(definitions.some((def) => /UNIQUE INDEX rate_limit_key_uq .*\(key\)/.test(def))).toBe(true);
    expect(definitions.some((def) => /rate_limit_pkey/.test(def))).toBe(true);
  });

  it('allows the limit, then answers 429, and records the bucket in the database', async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < SPECIAL_RULE_MAX + 1; i++) statuses.push((await attempt(ip)).status);
    expect(statuses).toEqual([401, 401, 401, 429]);

    const [bucket] = await app.db.select().from(rateLimits).where(eq(rateLimits.key, `${ip}|/sign-in/email`));
    expect(bucket?.count).toBe(SPECIAL_RULE_MAX);
    expect(typeof bucket?.lastRequest).toBe('number');
  });

  it('keeps buckets separate per client IP and per path', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < SPECIAL_RULE_MAX; i++) await attempt(ip);
    expect((await attempt(ip)).status).toBe(429);
    expect((await attempt(uniqueIp())).status).toBe(401);
    expect((await attempt(ip, '/sign-up/email')).status).toBe(200);
  });

  it('cannot be exceeded by concurrent requests (atomic increments)', async () => {
    const ip = uniqueIp();
    const statuses = (await Promise.all(Array.from({ length: 12 }, () => attempt(ip)))).map((response) => response.status);
    expect(statuses.filter((status) => status !== 429)).toHaveLength(SPECIAL_RULE_MAX);
    const [bucket] = await app.db.select().from(rateLimits).where(eq(rateLimits.key, `${ip}|/sign-in/email`));
    expect(bucket?.count).toBe(SPECIAL_RULE_MAX);
  });

  it('opens a new window once the previous one has passed', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < SPECIAL_RULE_MAX; i++) await attempt(ip);
    expect((await attempt(ip)).status).toBe(429);
    await app.db.update(rateLimits).set({ lastRequest: Date.now() - SPECIAL_RULE_WINDOW_MS - 1_000 }).where(eq(rateLimits.key, `${ip}|/sign-in/email`));
    expect((await attempt(ip)).status).toBe(401);
  });

  it('applies to sign-up as well', async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < SPECIAL_RULE_MAX + 1; i++) statuses.push((await attempt(ip, '/sign-up/email')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
