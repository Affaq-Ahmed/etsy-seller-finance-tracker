import { getSuppliers, postSupplier } from '@/server/api/suppliers';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getSuppliers);
export const POST = tenantRoute(postSupplier);
