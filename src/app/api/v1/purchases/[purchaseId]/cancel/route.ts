import { purchaseParamsSchema } from '@/server/api/params';
import { postCancelPurchase } from '@/server/api/purchases';
import { tenantRoute } from '@/server/http/routes';

export const POST = tenantRoute(postCancelPurchase, { params: purchaseParamsSchema });
