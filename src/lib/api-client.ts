// Browser helper for this app's JSON API (same-origin, cookie session). Error
// bodies are generic and name fields only, so their messages are safe to show.

export interface ApiFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly fields: readonly string[];
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly failure: ApiFailure };

const GENERIC_FAILURE = 'Something went wrong. Please try again.';
const NETWORK_FAILURE = 'Could not reach the server. Check your connection and try again.';

export async function callApi<T>(path: string, method: 'POST' | 'PATCH' | 'GET', body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, status: response.status, data: json as T };
    const error = (json as { error?: { code?: unknown; message?: unknown; fields?: unknown } } | null)?.error;
    return {
      ok: false,
      failure: {
        status: response.status,
        code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
        message: response.status === 429 ? 'Too many requests. Please wait a moment and try again.' : typeof error?.message === 'string' ? error.message : GENERIC_FAILURE,
        fields: Array.isArray(error?.fields) ? error.fields.filter((field): field is string => typeof field === 'string') : [],
      },
    };
  } catch {
    return { ok: false, failure: { status: 0, code: 'NETWORK', message: NETWORK_FAILURE, fields: [] } };
  }
}

/** "The request is invalid. Check: Net payable, Item 2 quantity." */
export function describeFailure(failure: ApiFailure, labels: Readonly<Record<string, string>> = {}): string {
  if (failure.fields.length === 0) return failure.message;
  const names = failure.fields.map((field) => {
    const [head = field, index, tail] = field.split('.');
    const base = labels[tail ? `${head}.${tail}` : head] ?? labels[head] ?? head;
    return index !== undefined && /^\d+$/.test(index) ? `${base} (row ${Number(index) + 1})` : base;
  });
  return `${failure.message} Check: ${[...new Set(names)].join(', ')}.`;
}
