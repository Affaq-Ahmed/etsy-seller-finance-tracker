import { purchaseParamsSchema } from '@/server/api/params';
import { getPurchase, patchPurchase } from '@/server/api/purchases';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getPurchase, { params: purchaseParamsSchema });
export const PATCH = tenantRoute(patchPurchase, { params: purchaseParamsSchema });
