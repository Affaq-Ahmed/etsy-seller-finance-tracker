import { getExpenses, postCreateExpense } from '@/server/api/expenses';
import { tenantRoute } from '@/server/http/routes';

export const GET = tenantRoute(getExpenses);
export const POST = tenantRoute(postCreateExpense);
