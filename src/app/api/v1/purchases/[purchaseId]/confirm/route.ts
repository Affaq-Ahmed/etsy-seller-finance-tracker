import { purchaseParamsSchema } from '@/server/api/params';
import { postConfirmPurchase } from '@/server/api/purchases';
import { tenantRoute } from '@/server/http/routes';

export const POST = tenantRoute(postConfirmPurchase, { params: purchaseParamsSchema });
