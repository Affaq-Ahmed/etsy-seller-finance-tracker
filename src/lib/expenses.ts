// Expense category vocabulary (PRD §3.7; ARCHITECTURE.md A37). Pure and
// client-safe: the form's select and the server's allowlist share it.
//
// `expense_categories.category_type` is free text in the frozen schema, so the
// closed vocabulary is enforced in the application. Payoneer fees are NOT a
// manual category: they come from Payoneer transactions (Phase 3), and entering
// one by hand would post the same fee twice (PRODUCT.md §6.3).

export const EXPENSE_CATEGORY_TYPES = [
  'ADVERTISING', 'MARKETPLACE_SUBSCRIPTION', 'SOFTWARE_SUBSCRIPTION', 'SHIPPING', 'REFUND_RELATED', 'MISCELLANEOUS',
] as const;

export type ExpenseCategoryType = (typeof EXPENSE_CATEGORY_TYPES)[number];

/** Reserved: never assignable to a manual expense, never created by the application. */
export const PAYONEER_FEE_CATEGORY_TYPE = 'PAYONEER_FEE';

/** Names of the fixed categories (PRD §3.7). Unique per business. */
export const EXPENSE_CATEGORY_NAMES: Readonly<Record<ExpenseCategoryType, string>> = {
  ADVERTISING: 'Etsy advertisements',
  MARKETPLACE_SUBSCRIPTION: 'Marketplace subscriptions',
  SOFTWARE_SUBSCRIPTION: 'Software subscriptions',
  SHIPPING: 'Shipping',
  REFUND_RELATED: 'Refund-related expenses',
  MISCELLANEOUS: 'Miscellaneous expenses',
};

export const EXPENSE_CATEGORY_OPTIONS: ReadonlyArray<{ readonly type: ExpenseCategoryType; readonly label: string }> =
  EXPENSE_CATEGORY_TYPES.map((type) => ({ type, label: EXPENSE_CATEGORY_NAMES[type] }));

/** Longest supplier/receipt reference (matches REFERENCE_PATTERN in validation.ts and the varchar(180) column). */
export const EXPENSE_REFERENCE_MAX_LENGTH = 160;
/** Longest reversal reason. */
export const EXPENSE_REVERSAL_REASON_MAX_LENGTH = 500;
/**
 * The HTML `pattern` for the reference input, the same characters as REFERENCE_PATTERN. Browsers compile the
 * attribute with the `v` flag, where `/` and `-` inside a class must be escaped (an unescaped `/` is a syntax
 * error and the browser then ignores the pattern).
 */
export const EXPENSE_REFERENCE_INPUT_PATTERN = '[A-Za-z0-9._:\\/#\\-]+';

const MANUAL_TYPES: ReadonlySet<string> = new Set(EXPENSE_CATEGORY_TYPES);

/** True only for the six manual types; false for PAYONEER_FEE and anything unknown. */
export function isManualCategoryType(value: string): value is ExpenseCategoryType {
  return MANUAL_TYPES.has(value);
}
