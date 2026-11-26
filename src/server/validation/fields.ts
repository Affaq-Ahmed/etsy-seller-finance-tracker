import 'server-only';
import { z } from 'zod';
import { isValidCalendarDate } from '@/lib/dates';
import { MAX_MONEY, parseMoneyInput } from '@/lib/money';
import {
  ETSY_ORDER_ID_PATTERN, findPiiProblem, isSafeHttpUrl, NOTES_MAX_LENGTH, REFERENCE_PATTERN,
} from '@/lib/validation';

// Reusable Zod fields. Failures name the field only; values are never echoed
// (src/server/http/body.ts), so rejected text never reaches responses or logs.

export const MAX_LINE_QUANTITY = 100_000;
export const MAX_ITEMS_PER_ORDER = 50;
export const MAX_LINES_PER_PURCHASE = 100;
export const NAME_MAX_LENGTH = 240;

export const uuidField = z.uuid();

/** "YYYY-MM-DD", a real calendar date. */
export const calendarDateField = z.string().refine(isValidCalendarDate);

/** Non-negative amount with at most 2 decimals, as a string (never a JSON number). */
export const moneyField = z.string().refine((value) => {
  const parsed = parseMoneyInput(value);
  return parsed !== null && parsed <= MAX_MONEY;
});

export const quantityField = z.number().int().min(1).max(MAX_LINE_QUANTITY);

/** Free text screened for email and phone-number patterns; '' becomes null. */
export const notesField = z.string().trim().max(NOTES_MAX_LENGTH)
  .refine((value) => findPiiProblem(value) === null)
  .transform((value) => (value === '' ? null : value));

export const nameField = z.string().trim().min(1).max(NAME_MAX_LENGTH)
  .refine((value) => findPiiProblem(value) === null);

export const skuField = z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/);

export const etsyOrderIdField = z.string().trim().regex(ETSY_ORDER_ID_PATTERN);

export const referenceField = z.string().trim().regex(REFERENCE_PATTERN);

/** Optional http(s) URL; '' becomes null. */
export const urlField = z.string().trim()
  .refine((value) => value === '' || isSafeHttpUrl(value))
  .transform((value) => (value === '' ? null : value));

export const currencyField = z.string().regex(/^[A-Z]{3}$/);
