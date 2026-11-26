import 'server-only';
import { readJsonBody } from '@/server/http/body';
import { parsePageRequest } from '@/server/http/pagination';
import { jsonResponse } from '@/server/http/responses';
import type { TenantRouteContext } from '@/server/http/routes';
import {
  cancelDraftPurchase, confirmPurchase, createPurchase, createPurchaseSchema, getPurchaseDetail, listPurchases, reversePurchase,
  reversePurchaseSchema, updateDraftPurchase, updatePurchaseSchema,
} from '@/server/purchases/service';
import type { PurchaseParams } from './params';

/** GET /api/v1/purchases */
export async function getPurchases({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  return jsonResponse(await listPurchases(deps.db, tenant, parsePageRequest(request.url)), 200);
}

/** POST /api/v1/purchases: 201 with a DRAFT purchase. Nothing is posted to the ledger. */
export async function postPurchase({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  const input = await readJsonBody(request, createPurchaseSchema);
  return jsonResponse(await createPurchase(deps.db, tenant, input), 201);
}

/** GET /api/v1/purchases/:purchaseId */
export async function getPurchase({ deps, tenant, params }: TenantRouteContext<PurchaseParams>): Promise<Response> {
  return jsonResponse(await getPurchaseDetail(deps.db, tenant, params.purchaseId), 200);
}

/** PATCH /api/v1/purchases/:purchaseId (drafts only) */
export async function patchPurchase({ deps, request, tenant, params }: TenantRouteContext<PurchaseParams>): Promise<Response> {
  const patch = await readJsonBody(request, updatePurchaseSchema);
  return jsonResponse(await updateDraftPurchase(deps.db, tenant, params.purchaseId, patch), 200);
}

/** POST /api/v1/purchases/:purchaseId/confirm: posts the cost atomically; a repeat returns the same posting. */
export async function postConfirmPurchase({ deps, tenant, params }: TenantRouteContext<PurchaseParams>): Promise<Response> {
  const result = await confirmPurchase(deps.db, tenant, params.purchaseId);
  return jsonResponse({ ...result.detail, alreadyConfirmed: result.alreadyConfirmed }, 200);
}

/** POST /api/v1/purchases/:purchaseId/cancel (drafts only) */
export async function postCancelPurchase({ deps, tenant, params }: TenantRouteContext<PurchaseParams>): Promise<Response> {
  return jsonResponse(await cancelDraftPurchase(deps.db, tenant, params.purchaseId), 200);
}

/** POST /api/v1/purchases/:purchaseId/reverse: exact opposite posting; a reason is required. */
export async function postReversePurchase({ deps, request, tenant, params }: TenantRouteContext<PurchaseParams>): Promise<Response> {
  const input = await readJsonBody(request, reversePurchaseSchema);
  const result = await reversePurchase(deps.db, tenant, params.purchaseId, input);
  return jsonResponse({ ...result.detail, alreadyReversed: result.alreadyReversed }, 200);
}
