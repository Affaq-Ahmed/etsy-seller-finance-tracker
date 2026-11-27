import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORY_NAMES, EXPENSE_CATEGORY_OPTIONS, EXPENSE_CATEGORY_TYPES, EXPENSE_REFERENCE_INPUT_PATTERN, EXPENSE_REFERENCE_MAX_LENGTH,
  EXPENSE_REVERSAL_REASON_MAX_LENGTH, isManualCategoryType, PAYONEER_FEE_CATEGORY_TYPE,
} from '@/lib/expenses';
import { REFERENCE_PATTERN } from '@/lib/validation';
import type { ExpenseCategoryRow } from '@/server/dal/expense-categories';
import type { ExpenseListRow } from '@/server/dal/expenses';
import { assertCategoryUsableForPosting, assertManualCategoryType } from '@/server/expenses/categories';
import { createExpenseSchema, reverseExpenseSchema, toExpenseView } from '@/server/expenses/service';
import { EXPENSE_SOURCE, expenseInitialKey, expenseReversalKey } from '@/server/ledger/posting';

const ID = '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f';
const OTHER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const shared = { expenseType: 'SHARED', categoryType: 'SOFTWARE_SUBSCRIPTION', amount: '19.99', expenseDate: '2026-11-21' };
const direct = { expenseType: 'DIRECT', orderId: ID, categoryType: 'SHIPPING', amount: '4.25', expenseDate: '2026-11-21' };

describe('createExpenseSchema', () => {
  it('accepts a SHARED expense without an order and a DIRECT expense with one', () => {
    expect(createExpenseSchema.safeParse(shared).success).toBe(true);
    expect(createExpenseSchema.safeParse(direct).success).toBe(true);
  });

  it('requires an order for DIRECT and forbids one for SHARED, naming orderId', () => {
    for (const body of [{ ...direct, orderId: undefined }, { ...shared, orderId: ID }]) {
      const result = createExpenseSchema.safeParse(body);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['orderId']);
    }
  });

  it('accepts optional currency, reference and description, turning a blank description into null', () => {
    const parsed = createExpenseSchema.parse({ ...shared, currency: 'USD', sourceReference: 'INV-2026/11#1', description: '  ' });
    expect(parsed).toMatchObject({ currency: 'USD', sourceReference: 'INV-2026/11#1', description: null });
    expect(createExpenseSchema.parse({ ...shared, sourceReference: null }).sourceReference).toBeNull();
    expect(createExpenseSchema.parse({ ...shared, description: '  Annual plan  ' }).description).toBe('Annual plan');
  });

  it.each([
    ['a JSON number amount', { ...shared, amount: 19.99 }],
    ['three decimals', { ...shared, amount: '1.005' }],
    ['a negative amount', { ...shared, amount: '-1' }],
    ['an exponent', { ...shared, amount: '1e2' }],
    ['a comma', { ...shared, amount: '1,000.00' }],
    ['an empty amount', { ...shared, amount: '' }],
    ['more than the maximum', { ...shared, amount: '1000000000000.00' }],
    ['an impossible date', { ...shared, expenseDate: '2026-02-30' }],
    ['a date with a time', { ...shared, expenseDate: '2026-11-21T00:00:00Z' }],
    ['an unknown category type', { ...shared, categoryType: 'CUSTOM' }],
    ['a lowercase category type', { ...shared, categoryType: 'shipping' }],
    ['an unknown expense type', { ...shared, expenseType: 'OTHER' }],
    ['an email in the description', { ...shared, description: 'paid via jane@example.com' }],
    ['a phone number in the description', { ...shared, description: 'call +92 300 1234567' }],
    ['a reference with spaces', { ...shared, sourceReference: 'has spaces' }],
    ['a reference over 160 characters', { ...shared, sourceReference: 'a'.repeat(161) }],
    ['a description over 2000 characters', { ...shared, description: 'x'.repeat(2001) }],
    ['a lowercase currency', { ...shared, currency: 'usd' }],
    ['a non-uuid order', { ...direct, orderId: 'order-1' }],
    ['an unknown key', { ...shared, status: 'CONFIRMED' }],
    ['a forged accountId', { ...shared, accountId: ID }],
    ['a forged tenantId', { ...shared, tenantId: ID }],
    ['a forged ownerUserId', { ...shared, ownerUserId: ID }],
    ['a caller-chosen category ID', { ...shared, categoryId: ID }],
    ['a missing amount', { ...shared, amount: undefined }],
    ['a missing date', { ...shared, expenseDate: undefined }],
  ])('rejects %s', (_label, body) => {
    expect(createExpenseSchema.safeParse(body).success).toBe(false);
  });

  it('accepts the reserved Payoneer-fee type (the service answers 422 PAYONEER_FEE_NOT_ALLOWED), but no other unknown type', () => {
    expect(createExpenseSchema.safeParse({ ...shared, categoryType: PAYONEER_FEE_CATEGORY_TYPE }).success).toBe(true);
    expect(createExpenseSchema.safeParse({ ...shared, categoryType: 'PAYONEER_FEES' }).success).toBe(false);
  });

  it('accepts amounts with at most two decimals and the exact maximum', () => {
    for (const amount of ['0', '0.01', '5', '5.5', '999999999999.99']) {
      expect(createExpenseSchema.safeParse({ ...shared, amount }).success, amount).toBe(true);
    }
  });
});

describe('reverseExpenseSchema', () => {
  it('trims the reason and accepts 1 to 500 characters', () => {
    expect(reverseExpenseSchema.parse({ reason: '  Entered twice  ' })).toEqual({ reason: 'Entered twice' });
    expect(reverseExpenseSchema.safeParse({ reason: 'x'.repeat(500) }).success).toBe(true);
  });

  it.each([
    ['missing', {}], ['empty', { reason: '' }], ['blank', { reason: '   ' }], ['too long', { reason: 'x'.repeat(501) }],
    ['not a string', { reason: 5 }], ['an email', { reason: 'write to jane@example.com' }], ['an extra key', { reason: 'ok', accountId: ID }],
  ])('rejects a reason that is %s', (_label, body) => {
    expect(reverseExpenseSchema.safeParse(body).success).toBe(false);
  });
});

describe('category vocabulary (ARCHITECTURE.md A37)', () => {
  it('has the six PRD §3.7 types, with unique names that fit the columns', () => {
    expect([...EXPENSE_CATEGORY_TYPES]).toEqual(['ADVERTISING', 'MARKETPLACE_SUBSCRIPTION', 'SOFTWARE_SUBSCRIPTION', 'SHIPPING', 'REFUND_RELATED', 'MISCELLANEOUS']);
    const names = EXPENSE_CATEGORY_TYPES.map((type) => EXPENSE_CATEGORY_NAMES[type]);
    expect(new Set(names).size).toBe(names.length);
    for (const type of EXPENSE_CATEGORY_TYPES) {
      expect(type.length).toBeLessThanOrEqual(40);
      expect(EXPENSE_CATEGORY_NAMES[type].length).toBeLessThanOrEqual(120);
    }
    expect(EXPENSE_CATEGORY_OPTIONS.map((option) => option.type)).toEqual([...EXPENSE_CATEGORY_TYPES]);
  });

  it('reserves PAYONEER_FEE: never offered, never manual, and no category is named like it', () => {
    expect((EXPENSE_CATEGORY_TYPES as readonly string[]).includes(PAYONEER_FEE_CATEGORY_TYPE)).toBe(false);
    expect(EXPENSE_CATEGORY_OPTIONS.some((option) => /payoneer/i.test(option.type) || /payoneer/i.test(option.label))).toBe(false);
    expect(isManualCategoryType(PAYONEER_FEE_CATEGORY_TYPE)).toBe(false);
    for (const type of EXPENSE_CATEGORY_TYPES) expect(isManualCategoryType(type)).toBe(true);
    for (const other of ['', 'CUSTOM', 'advertising', 'ADVERTISING ', 'Payoneer fees']) expect(isManualCategoryType(other), other).toBe(false);
  });

  it('assertManualCategoryType answers PAYONEER_FEE_NOT_ALLOWED for the reserved type and CATEGORY_NOT_USABLE for anything else', () => {
    expect(() => assertManualCategoryType(PAYONEER_FEE_CATEGORY_TYPE)).toThrowError(expect.objectContaining({ kind: 'unprocessable', code: 'PAYONEER_FEE_NOT_ALLOWED', fields: ['categoryType'] }));
    expect(() => assertManualCategoryType('CUSTOM')).toThrowError(expect.objectContaining({ code: 'CATEGORY_NOT_USABLE' }));
    expect(() => assertManualCategoryType('SHIPPING')).not.toThrow();
  });

  it('assertCategoryUsableForPosting re-reads the stored row and fails closed', () => {
    const category = (overrides: Partial<ExpenseCategoryRow>): ExpenseCategoryRow => ({
      id: ID, accountId: OTHER_ID, name: 'Shipping', categoryType: 'SHIPPING', isActive: true, createdAt: new Date('2026-11-26T00:00:00Z'), ...overrides,
    });
    expect(() => assertCategoryUsableForPosting(category({}))).not.toThrow();
    for (const bad of [null, category({ categoryType: 'PAYONEER_FEE' }), category({ categoryType: 'CUSTOM' }), category({ categoryType: '' }), category({ isActive: false })]) {
      expect(() => assertCategoryUsableForPosting(bad)).toThrowError(expect.objectContaining({ kind: 'unprocessable', code: 'CATEGORY_NOT_USABLE' }));
    }
    // A name that looks like a Payoneer fee never matters; only the stored type does.
    expect(() => assertCategoryUsableForPosting(category({ name: 'Payoneer fees' }))).not.toThrow();
  });
});

describe('event keys', () => {
  it('are deterministic and distinct per event', () => {
    expect(EXPENSE_SOURCE).toBe('expense');
    expect(expenseInitialKey(ID)).toBe(`expense:${ID}:INITIAL`);
    expect(expenseReversalKey(ID)).toBe(`expense:${ID}:REVERSAL`);
    expect(expenseInitialKey(ID)).not.toBe(expenseReversalKey(ID));
    expect(expenseInitialKey(ID)).not.toBe(expenseInitialKey(OTHER_ID));
  });
});

function expenseRow(overrides: Partial<ExpenseListRow>): ExpenseListRow {
  return {
    id: ID, accountId: OTHER_ID, categoryId: ID, orderId: null, expenseType: 'SHARED', amount: '19.9900', currency: 'USD',
    expenseDate: new Date('2026-11-20T19:00:00Z'), description: null, sourceReference: null, status: 'DRAFT', createdAt: new Date('2026-11-26T00:00:00Z'),
    categoryName: 'Software subscriptions', categoryType: 'SOFTWARE_SUBSCRIPTION', etsyOrderId: null, reversed: false, postedAt: null, ...overrides,
  };
}

describe('expense view', () => {
  it('shows dates in the business timezone, not in UTC', () => {
    // 20:00 UTC on the 26th is already the 27th in Karachi (UTC+5) but still the 26th in New York.
    const postedAt = new Date('2026-11-26T20:00:00Z');
    const view = toExpenseView(expenseRow({ status: 'CONFIRMED', postedAt }), 'Asia/Karachi');
    expect(view.expenseDate).toBe('2026-11-21');
    expect(view.confirmedDate).toBe('2026-11-27');
    expect(view.confirmedAt).toBe('2026-11-26T20:00:00.000Z');
    expect(toExpenseView(expenseRow({ status: 'CONFIRMED', postedAt }), 'America/New_York').confirmedDate).toBe('2026-11-26');
    expect(toExpenseView(expenseRow({}), 'Asia/Karachi')).toMatchObject({ confirmedAt: null, confirmedDate: null });
  });

  it('derives REVERSED from the ledger while the stored status stays CONFIRMED', () => {
    const postedAt = new Date('2026-11-26T20:00:00Z');
    expect(toExpenseView(expenseRow({ status: 'CONFIRMED', postedAt, reversed: true }), 'UTC')).toMatchObject({ status: 'CONFIRMED', effectiveStatus: 'REVERSED' });
    expect(toExpenseView(expenseRow({ status: 'CONFIRMED', postedAt }), 'UTC').effectiveStatus).toBe('CONFIRMED');
    expect(toExpenseView(expenseRow({ status: 'DRAFT' }), 'UTC').effectiveStatus).toBe('DRAFT');
    expect(toExpenseView(expenseRow({ status: 'VOIDED' }), 'UTC').effectiveStatus).toBe('VOIDED');
  });

  it('never rounds the amount and carries the order only for DIRECT expenses', () => {
    expect(toExpenseView(expenseRow({ amount: '0.0050' }), 'UTC').amount).toBe('0.0050');
    expect(toExpenseView(expenseRow({ amount: '1234.5000' }), 'UTC').amount).toBe('1234.50');
    const direct = toExpenseView(expenseRow({ expenseType: 'DIRECT', orderId: ID, etsyOrderId: '1234567890' }), 'UTC');
    expect(direct).toMatchObject({ expenseType: 'DIRECT', orderId: ID, etsyOrderId: '1234567890' });
    expect(toExpenseView(expenseRow({}), 'UTC')).toMatchObject({ expenseType: 'SHARED', orderId: null, etsyOrderId: null });
  });
});

describe('reference input pattern and shared limits', () => {
  // Browsers compile the pattern attribute as new RegExp(`^(?:${pattern})$`, 'v').
  const browserRegex = () => new RegExp(`^(?:${EXPENSE_REFERENCE_INPUT_PATTERN})$`, 'v');

  it('compiles under the v flag (an unescaped / or - inside the class would be a syntax error)', () => {
    expect(browserRegex).not.toThrow();
    expect(() => new RegExp('^(?:[A-Za-z0-9._:/#\\-]+)$', 'v')).toThrow();
  });

  it('accepts and rejects the same strings as the server reference rule', () => {
    const accepted = ['INV-2026/11#1', 'a', 'RCPT.9:2', '0', 'A_b', '12/34', '#7', 'x'.repeat(EXPENSE_REFERENCE_MAX_LENGTH)];
    const rejected = ['', 'has space', 'a+b', 'a,b', 'x@y', 'tab\there', 'a\\b', 'ünï', '(1)', '[1]'];
    for (const value of accepted) {
      expect(browserRegex().test(value), value).toBe(true);
      expect(REFERENCE_PATTERN.test(value), value).toBe(true);
    }
    for (const value of rejected) {
      expect(browserRegex().test(value), value).toBe(false);
      expect(REFERENCE_PATTERN.test(value), value).toBe(false);
    }
  });

  it('shares its limits with the server schemas', () => {
    expect(createExpenseSchema.safeParse({ ...shared, sourceReference: 'a'.repeat(EXPENSE_REFERENCE_MAX_LENGTH) }).success).toBe(true);
    expect(createExpenseSchema.safeParse({ ...shared, sourceReference: 'a'.repeat(EXPENSE_REFERENCE_MAX_LENGTH + 1) }).success).toBe(false);
    expect(reverseExpenseSchema.safeParse({ reason: 'x'.repeat(EXPENSE_REVERSAL_REASON_MAX_LENGTH) }).success).toBe(true);
    expect(reverseExpenseSchema.safeParse({ reason: 'x'.repeat(EXPENSE_REVERSAL_REASON_MAX_LENGTH + 1) }).success).toBe(false);
  });
});
