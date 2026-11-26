import 'server-only';
import { readJsonBody } from '@/server/http/body';
import { parsePageRequest } from '@/server/http/pagination';
import { jsonResponse } from '@/server/http/responses';
import type { TenantRouteContext } from '@/server/http/routes';
import {
  changeOrderStatus, createOrder, createOrderSchema, getOrderDetail, listOrders, orderStatusChangeSchema, updateOrderDetails, updateOrderSchema,
} from '@/server/orders/service';
import type { OrderParams } from './params';

/** GET /api/v1/orders */
export async function getOrders({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  return jsonResponse(await listOrders(deps.db, tenant, parsePageRequest(request.url)), 200);
}

/** POST /api/v1/orders: 201 with the order, its items and profit. */
export async function postOrder({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  const input = await readJsonBody(request, createOrderSchema);
  return jsonResponse(await createOrder(deps.db, tenant, input), 201);
}

/** GET /api/v1/orders/:orderId */
export async function getOrder({ deps, tenant, params }: TenantRouteContext<OrderParams>): Promise<Response> {
  return jsonResponse(await getOrderDetail(deps.db, tenant, params.orderId), 200);
}

/** PATCH /api/v1/orders/:orderId */
export async function patchOrder({ deps, request, tenant, params }: TenantRouteContext<OrderParams>): Promise<Response> {
  const patch = await readJsonBody(request, updateOrderSchema);
  return jsonResponse(await updateOrderDetails(deps.db, tenant, params.orderId, patch), 200);
}

/** POST /api/v1/orders/:orderId/status */
export async function postOrderStatus({ deps, request, tenant, params }: TenantRouteContext<OrderParams>): Promise<Response> {
  const input = await readJsonBody(request, orderStatusChangeSchema);
  return jsonResponse(await changeOrderStatus(deps.db, tenant, params.orderId, input), 200);
}
