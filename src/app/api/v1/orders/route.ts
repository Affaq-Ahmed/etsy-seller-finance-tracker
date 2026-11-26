import { getOrders, postOrder } from '@/server/api/orders';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getOrders);
export const POST = tenantRoute(postOrder);
