import 'server-only';
import { readJsonBody } from '@/server/http/body';
import { parsePageRequest } from '@/server/http/pagination';
import { jsonResponse } from '@/server/http/responses';
import type { TenantRouteContext } from '@/server/http/routes';
import { createProduct, createProductSchema, listProducts } from '@/server/products/service';

/** GET /api/v1/products */
export async function getProducts({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  return jsonResponse(await listProducts(deps.db, tenant, parsePageRequest(request.url)), 200);
}

/** POST /api/v1/products: 201 with the created product. */
export async function postProduct({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  const input = await readJsonBody(request, createProductSchema);
  return jsonResponse({ product: await createProduct(deps.db, tenant, input) }, 201);
}
