import { getExpense } from '@/server/api/expenses';
import { expenseParamsSchema } from '@/server/api/params';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getExpense, { params: expenseParamsSchema });
