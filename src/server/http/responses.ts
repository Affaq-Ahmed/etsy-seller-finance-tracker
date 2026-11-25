import 'server-only';

/** Tenant and session responses must never be stored by browsers, proxies or CDNs. */
export const NO_STORE = 'private, no-store';

export function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

/** Copies a response with `Cache-Control: private, no-store`, preserving every Set-Cookie. */
export function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', NO_STORE);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
