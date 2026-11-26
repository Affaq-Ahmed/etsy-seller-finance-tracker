import { describe, expect, it, vi } from 'vitest';
import { DomainError, notFound as notFoundError } from '@/server/domain/errors';
import { resolveRecordCurrency } from '@/server/business/context';
import { parsePageRequest, toPage } from '@/server/http/pagination';
import { HttpError } from '@/server/http/errors';

class NotFoundSignal extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('NEXT_NOT_FOUND');
  },
}));

const { assertUuidOrNotFound, orNotFound } = await import('@/server/http/pages');
const { pageFromSearchParams } = await import('@/server/http/page-search');

describe('page helpers', () => {
  it('renders not-found for a missing record and passes other errors through', async () => {
    await expect(orNotFound(Promise.reject(notFoundError('Order')))).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(orNotFound(Promise.reject(new DomainError('conflict', 'X', 'x')))).rejects.toMatchObject({ code: 'X' });
    await expect(orNotFound(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(orNotFound(Promise.resolve(42))).resolves.toBe(42);
  });

  it('treats a malformed ID as not found', () => {
    expect(assertUuidOrNotFound('3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f')).toBe('3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f');
    for (const bad of ['', 'abc', '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5', '../etc/passwd', '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f ']) {
      expect(() => assertUuidOrNotFound(bad), bad).toThrow(NotFoundSignal);
    }
  });

  it('reads only a clean numeric ?offset= for server-rendered lists', async () => {
    const page = (offset: string | string[] | undefined) => pageFromSearchParams(Promise.resolve({ offset }));
    expect(await page('50')).toEqual({ limit: 25, offset: 50 });
    for (const bad of [undefined, '', '-1', '1.5', 'abc', '9999999', ['1', '2']]) expect(await page(bad), String(bad)).toEqual({ limit: 25, offset: 0 });
  });
});

describe('API pagination', () => {
  const url = (query: string) => `https://app.example.test/api/v1/orders${query}`;

  it('defaults to 25 from offset 0 and accepts the documented bounds', () => {
    expect(parsePageRequest(url(''))).toEqual({ limit: 25, offset: 0 });
    expect(parsePageRequest(url('?limit=100&offset=100000'))).toEqual({ limit: 100, offset: 100000 });
    expect(parsePageRequest(url('?limit=1'))).toEqual({ limit: 1, offset: 0 });
  });

  it.each([['?limit=0'], ['?limit=101'], ['?offset=-1'], ['?offset=100001'], ['?limit=2.5'], ['?limit=abc'], ['?cursor=1'], ['?limit=10&sort=asc']])('rejects %s naming the field', (query) => {
    try {
      parsePageRequest(url(query));
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).fields?.length).toBeGreaterThan(0);
      return;
    }
    throw new Error(`${query} was accepted`);
  });

  it('shapes a page', () => {
    expect(toPage(['a'], { limit: 25, offset: 0 }, 1)).toEqual({ items: ['a'], page: { limit: 25, offset: 0, total: 1 } });
  });
});

describe('currency rule (no FX in Phase 2a)', () => {
  const business = { baseCurrency: 'USD', timeZone: 'Asia/Karachi' };

  it('defaults to the business currency and accepts it explicitly', () => {
    expect(resolveRecordCurrency(undefined, business)).toBe('USD');
    expect(resolveRecordCurrency('USD', business)).toBe('USD');
  });

  it('rejects any other currency with a clear, field-named error', () => {
    try {
      resolveRecordCurrency('PKR', business);
    } catch (error) {
      expect(error).toMatchObject({ kind: 'unprocessable', code: 'CURRENCY_NOT_SUPPORTED', fields: ['currency'] });
      expect((error as Error).message).toContain('USD');
      return;
    }
    throw new Error('PKR was accepted');
  });
});
