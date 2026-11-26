import { purchaseParamsSchema } from '@/server/api/params';
import { postReversePurchase } from '@/server/api/purchases';
import { tenantRoute } from '@/server/http/routes';

export const POST = tenantRoute(postReversePurchase, { params: purchaseParamsSchema });
