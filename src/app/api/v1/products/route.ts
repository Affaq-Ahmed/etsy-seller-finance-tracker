import { getProducts, postProduct } from '@/server/api/products';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getProducts);
export const POST = tenantRoute(postProduct);
