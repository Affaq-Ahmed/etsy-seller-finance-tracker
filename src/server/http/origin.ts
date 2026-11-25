import 'server-only';
import { forbiddenOriginError } from './errors';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF defence for this app's own cookie-authenticated endpoints (Better
 * Auth's endpoints run their own check). State-changing requests must carry an
 * Origin equal to the configured application origin, and Fetch Metadata, when
 * sent, must say same-origin.
 */
export function assertSameOrigin(request: Request, allowedOrigin: string): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') throw forbiddenOriginError();
  const origin = request.headers.get('origin');
  if (origin === null || origin === 'null' || normalizeOrigin(origin) !== allowedOrigin) throw forbiddenOriginError();
}
