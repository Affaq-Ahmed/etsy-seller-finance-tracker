import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertSameOrigin } from '@/server/http/origin';
import { errorToResponse, HttpError, notFoundError } from '@/server/http/errors';
import { MAX_JSON_BODY_BYTES, readJsonBody } from '@/server/http/body';
import { NO_STORE, withNoStore } from '@/server/http/responses';
import { getPostgresErrorCode } from '@/server/db/errors';

const ORIGIN = 'https://app.example.test';

function request(method: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request(`${ORIGIN}/api/v1/test`, { method, headers, body });
}

function expectForbidden(fn: () => void) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).code).toBe('FORBIDDEN_ORIGIN');
    return;
  }
  throw new Error('expected a 403');
}

describe('same-origin check (T14)', () => {
  it('allows safe methods without an Origin', () => {
    expect(() => assertSameOrigin(request('GET'), ORIGIN)).not.toThrow();
    expect(() => assertSameOrigin(request('HEAD'), ORIGIN)).not.toThrow();
  });

  it('allows a same-origin POST', () => {
    expect(() => assertSameOrigin(request('POST', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }), ORIGIN)).not.toThrow();
  });

  it.each([
    [{}],
    [{ origin: 'null' }],
    [{ origin: 'https://evil.example' }],
    [{ origin: 'http://app.example.test' }],
    [{ origin: 'https://app.example.test.evil.example' }],
    [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
    [{ origin: ORIGIN, 'sec-fetch-site': 'same-site' }],
    [{ origin: 'not a url' }],
  ])('rejects state-changing requests with headers %j', (headers) => {
    expectForbidden(() => assertSameOrigin(request('POST', headers), ORIGIN));
  });
});

describe('error mapping', () => {
  const sqlWithParams = 'Failed query: insert into "session" ("token") values ($1)\nparams: secret-session-token';
  const wrapped = (code: string) => Object.assign(new Error(sqlWithParams), { name: 'DrizzleQueryError', cause: Object.assign(new Error('driver detail'), { code }) });

  it('maps HttpError to its public shape with no-store', async () => {
    const response = errorToResponse(notFoundError());
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe(NO_STORE);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it.each([
    ['23505', 409, 'CONFLICT'],
    ['23503', 422, 'UNPROCESSABLE'],
    ['23514', 422, 'UNPROCESSABLE'],
    ['P0001', 422, 'UNPROCESSABLE'],
  ])('maps wrapped Postgres %s to a generic %i without SQL or parameters', async (code, status, publicCode) => {
    const response = errorToResponse(wrapped(code));
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe(publicCode);
    expect(text).not.toContain('secret-session-token');
    expect(text).not.toContain('insert into');
  });

  it('maps unknown errors to a generic 500 and logs only name and code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = errorToResponse(wrapped('XX000'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-session-token');
    expect(log).toHaveBeenCalledWith('[api] unexpected error', { name: 'DrizzleQueryError', code: 'XX000' });
  });

  it('finds SQLSTATE codes through cause chains only', () => {
    expect(getPostgresErrorCode(wrapped('40001'))).toBe('40001');
    expect(getPostgresErrorCode({ code: 'ECONNREFUSED' })).toBeUndefined();
    expect(getPostgresErrorCode(null)).toBeUndefined();
    expect(getPostgresErrorCode('23505')).toBeUndefined();
  });
});

describe('JSON body parsing', () => {
  const schema = z.strictObject({ shopName: z.string().min(1) });

  async function failure(req: Request): Promise<HttpError> {
    try {
      await readJsonBody(req, schema);
    } catch (error) {
      if (error instanceof HttpError) return error;
      throw error;
    }
    throw new Error('expected failure');
  }

  it('parses a valid body', async () => {
    await expect(readJsonBody(request('POST', { 'content-type': 'application/json; charset=utf-8' }, '{"shopName":"A"}'), schema)).resolves.toEqual({ shopName: 'A' });
  });

  it('rejects a non-JSON content type with 415', async () => {
    expect((await failure(request('POST', { 'content-type': 'text/plain' }, '{"shopName":"A"}'))).status).toBe(415);
  });

  it('rejects malformed JSON with 400', async () => {
    expect((await failure(request('POST', { 'content-type': 'application/json' }, '{'))).code).toBe('INVALID_JSON');
  });

  it('rejects oversized bodies with 413', async () => {
    const big = JSON.stringify({ shopName: 'x'.repeat(MAX_JSON_BODY_BYTES) });
    expect((await failure(request('POST', { 'content-type': 'application/json' }, big))).status).toBe(413);
  });

  it('names unknown and invalid fields without echoing values', async () => {
    const error = await failure(request('POST', { 'content-type': 'application/json' }, '{"shopName":"","accountId":"forged-value"}'));
    expect(error.status).toBe(400);
    expect(error.fields).toEqual(['accountId', 'shopName']);
    expect(JSON.stringify(error)).not.toContain('forged-value');
  });
});

describe('no-store responses', () => {
  it('preserves every Set-Cookie header', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const response = withNoStore(new Response('ok', { status: 201, headers }));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe(NO_STORE);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
});
