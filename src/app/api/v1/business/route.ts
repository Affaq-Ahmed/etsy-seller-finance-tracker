import { getBusiness } from '@/server/api/business';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getBusiness);
