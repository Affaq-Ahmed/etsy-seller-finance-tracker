import 'server-only';
import { z } from 'zod';
import { uuidField } from '@/server/validation/fields';

// Route segment schemas. A malformed ID is answered like a missing record (404).
export const orderParamsSchema = z.strictObject({ orderId: uuidField });
export const purchaseParamsSchema = z.strictObject({ purchaseId: uuidField });
export const expenseParamsSchema = z.strictObject({ expenseId: uuidField });
export type OrderParams = z.output<typeof orderParamsSchema>;
export type PurchaseParams = z.output<typeof purchaseParamsSchema>;
export type ExpenseParams = z.output<typeof expenseParamsSchema>;
