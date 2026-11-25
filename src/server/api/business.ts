import 'server-only';
import { getBusinessSummary } from '@/server/business/summary';
import { notFoundError } from '@/server/http/errors';
import { jsonResponse } from '@/server/http/responses';
import type { TenantRouteContext } from '@/server/http/routes';

/** GET /api/v1/business: the session tenant's business. */
export async function getBusiness({ deps, tenant }: TenantRouteContext): Promise<Response> {
  const business = await getBusinessSummary(deps.db, tenant);
  if (!business) throw notFoundError();
  return jsonResponse({ business }, 200);
}
