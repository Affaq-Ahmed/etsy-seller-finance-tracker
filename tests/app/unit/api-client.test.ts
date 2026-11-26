import { afterEach, describe, expect, it, vi } from 'vitest';
import { callApi, describeFailure, type ApiFailure } from '@/lib/api-client';

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callApi', () => {
  it('returns parsed data on success and sends JSON only when there is a body', async () => {
    const fetchMock = stubFetch(Response.json({ order: { id: 'o1' } }, { status: 201 }));
    const result = await callApi<{ order: { id: string } }>('/api/v1/orders', 'POST', { a: 1 });
    expect(result).toEqual({ ok: true, status: 201, data: { order: { id: 'o1' } } });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    await callApi('/api/v1/purchases/x/confirm', 'POST');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/purchases/x/confirm', { method: 'POST', headers: undefined, body: undefined });
  });

  it('turns an error body into a failure with its public message and field names', async () => {
    stubFetch(Response.json({ error: { code: 'INVALID_REQUEST', message: 'The request is invalid.', fields: ['netPayableAmount', 7, 'items.0.quantity'] } }, { status: 400 }));
    expect(await callApi('/x', 'POST', {})).toEqual({
      ok: false, failure: { status: 400, code: 'INVALID_REQUEST', message: 'The request is invalid.', fields: ['netPayableAmount', 'items.0.quantity'] },
    });
  });

  it('uses a friendly message for rate limiting, even without a JSON body', async () => {
    stubFetch(new Response('slow down', { status: 429 }));
    const result = await callApi('/x', 'POST', {});
    expect(result).toMatchObject({ ok: false, failure: { status: 429, code: 'UNKNOWN', message: 'Too many requests. Please wait a moment and try again.' } });
  });

  it('falls back to a generic message for malformed error bodies', async () => {
    stubFetch(new Response('<html>oops</html>', { status: 500 }));
    expect(await callApi('/x', 'GET')).toMatchObject({ ok: false, failure: { status: 500, message: 'Something went wrong. Please try again.', fields: [] } });
  });

  it('reports a network failure without throwing', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    expect(await callApi('/x', 'GET')).toEqual({
      ok: false, failure: { status: 0, code: 'NETWORK', message: 'Could not reach the server. Check your connection and try again.', fields: [] },
    });
  });
});

describe('describeFailure', () => {
  const failure = (fields: string[], message = 'The request is invalid.'): ApiFailure => ({ status: 400, code: 'INVALID_REQUEST', message, fields });

  it('returns the message alone without fields', () => {
    expect(describeFailure(failure([]))).toBe('The request is invalid.');
  });

  it('names fields with friendly labels and row numbers', () => {
    const labels = { netPayableAmount: 'Net payable', items: 'Items', 'items.quantity': 'quantity' };
    expect(describeFailure(failure(['netPayableAmount', 'items.1.quantity', 'items.1.quantity']), labels))
      .toBe('The request is invalid. Check: Net payable, quantity (row 2).');
  });

  it('falls back to the raw field name when there is no label', () => {
    expect(describeFailure(failure(['mystery']))).toBe('The request is invalid. Check: mystery.');
  });
});
