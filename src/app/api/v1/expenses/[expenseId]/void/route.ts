import { postVoidExpense } from '@/server/api/expenses';
import { expenseParamsSchema } from '@/server/api/params';
import { tenantRoute } from '@/server/http/routes';

export const POST = tenantRoute(postVoidExpense, { params: expenseParamsSchema });
