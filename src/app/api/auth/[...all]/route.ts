// public: Better Auth's own endpoints (sign-up, sign-in, sign-out, get-session).
// They enforce their own Origin/CSRF checks and database rate limits; see
// src/server/auth/auth.ts. Responses are marked private, no-store.
import { getContainer } from '@/server/container';
import { withNoStore } from '@/server/http/responses';

// A catch-all dynamic segment without generateStaticParams is never prerendered.
async function handle(request: Request): Promise<Response> {
  return withNoStore(await getContainer().auth.handler(request));
}

export const GET = handle;
export const POST = handle;
