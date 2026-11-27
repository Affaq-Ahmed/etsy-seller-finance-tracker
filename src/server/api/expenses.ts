import 'server-only';
import { confirmExpense, createExpense, createExpenseSchema, getExpenseDetail, listExpenses, reverseExpense, reverseExpenseSchema, voidExpense } from '@/server/expenses/service';
import { readJsonBody } from '@/server/http/body';
import { parsePageRequest } from '@/server/http/pagination';
import { jsonResponse } from '@/server/http/responses';
import type { TenantRouteContext } from '@/server/http/routes';
import type { ExpenseParams } from './params';

/** GET /api/v1/expenses */
export async function getExpenses({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  return jsonResponse(await listExpenses(deps.db, tenant, parsePageRequest(request.url)), 200);
}

/** POST /api/v1/expenses: 201 with a DRAFT expense. Nothing is posted to the ledger. */
export async function postCreateExpense({ deps, request, tenant }: TenantRouteContext): Promise<Response> {
  const input = await readJsonBody(request, createExpenseSchema);
  return jsonResponse(await createExpense(deps.db, tenant, input), 201);
}

/** GET /api/v1/expenses/:expenseId */
export async function getExpense({ deps, tenant, params }: TenantRouteContext<ExpenseParams>): Promise<Response> {
  return jsonResponse(await getExpenseDetail(deps.db, tenant, params.expenseId), 200);
}

/** POST /api/v1/expenses/:expenseId/confirm: posts the expense atomically; a repeat returns the same posting. */
export async function postConfirmExpense({ deps, tenant, params }: TenantRouteContext<ExpenseParams>): Promise<Response> {
  const result = await confirmExpense(deps.db, tenant, params.expenseId);
  return jsonResponse({ ...result.detail, alreadyConfirmed: result.alreadyConfirmed }, 200);
}

/** POST /api/v1/expenses/:expenseId/void (drafts only; posts nothing) */
export async function postVoidExpense({ deps, tenant, params }: TenantRouteContext<ExpenseParams>): Promise<Response> {
  return jsonResponse(await voidExpense(deps.db, tenant, params.expenseId), 200);
}

/** POST /api/v1/expenses/:expenseId/reverse: exact opposite posting; a reason is required. */
export async function postReverseExpense({ deps, request, tenant, params }: TenantRouteContext<ExpenseParams>): Promise<Response> {
  const input = await readJsonBody(request, reverseExpenseSchema);
  const result = await reverseExpense(deps.db, tenant, params.expenseId, input);
  return jsonResponse({ ...result.detail, alreadyReversed: result.alreadyReversed }, 200);
}
