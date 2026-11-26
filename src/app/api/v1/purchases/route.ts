import { getPurchases, postPurchase } from '@/server/api/purchases';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getPurchases);
export const POST = tenantRoute(postPurchase);
