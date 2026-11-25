import 'server-only';
import { readJsonBody } from '@/server/http/body';
import { jsonResponse } from '@/server/http/responses';
import type { SessionRouteContext } from '@/server/http/routes';
import { onboardBusiness, onboardingInputSchema } from '@/server/onboarding/service';

/** POST /api/v1/onboarding: 201 when created, 200 when the user already has a business. */
export async function postOnboarding({ deps, request, session }: SessionRouteContext): Promise<Response> {
  const input = await readJsonBody(request, onboardingInputSchema);
  const result = await onboardBusiness(deps.db, session, input);
  return jsonResponse({ business: result.business, created: result.created }, result.created ? 201 : 200);
}
