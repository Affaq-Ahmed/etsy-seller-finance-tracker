import { getOrder, patchOrder } from '@/server/api/orders';
import { orderParamsSchema } from '@/server/api/params';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getOrder, { params: orderParamsSchema });
export const PATCH = tenantRoute(patchOrder, { params: orderParamsSchema });
