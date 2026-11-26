import 'server-only';
import { readJsonBody } from '@/server/http/body';
import { parsePageRequest } from '@/server/http/pagination';
import { jsonResponse } from '@/server/http/responses';
import type { TenantRouteContext } from '@/server/http/routes';
import { createSupplier, createSupplierSchema, listSuppliers } from '@/server/suppliers/service';

/** GET /api/v1/suppliers */
export async function getSuppliers({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  return jsonResponse(await listSuppliers(deps.db, tenant, parsePageRequest(request.url)), 200);
}

/** POST /api/v1/suppliers: 201 with the created supplier. */
export async function postSupplier({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  const input = await readJsonBody(request, createSupplierSchema);
  return jsonResponse({ supplier: await createSupplier(deps.db, tenant, input) }, 201);
}
