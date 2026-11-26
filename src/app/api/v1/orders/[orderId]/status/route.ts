import { postOrderStatus } from '@/server/api/orders';
import { orderParamsSchema } from '@/server/api/params';
import { tenantRoute } from '@/server/http/routes';

export const POST = tenantRoute(postOrderStatus, { params: orderParamsSchema });
