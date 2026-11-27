// Exact money arithmetic for application code (PRODUCT.md D3 is still open).
//
// Interim rule: users enter amounts with at most 2 decimal places, and no
// operation here ever rounds. Values are bigint integers scaled by 10^4 (the
// scale of NUMERIC(19,4)), so addition and integer multiplication are exact.
// JavaScript floating-point numbers are never used for money.

export type Money = bigint;

export const MONEY_SCALE = 4;
// BigInt() calls instead of literals: the TypeScript target (ES2017) rejects `10n`.
const ZERO = BigInt(0);
const SCALE_FACTOR = BigInt(10_000);
const INPUT_DECIMALS = 2;
const INPUT_FACTOR = BigInt(100);

/** Largest accepted amount, input or total: 999,999,999,999.99 (well inside NUMERIC(19,4)). */
export const MAX_MONEY: Money = BigInt(999_999_999_999) * SCALE_FACTOR + BigInt(99) * INPUT_FACTOR;

const INPUT_PATTERN = /^(\d{1,12})(?:\.(\d{1,2}))?$/;
const DB_PATTERN = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

/**
 * Parses a user-entered, non-negative amount: digits with an optional
 * fraction of at most 2 digits. No signs, separators, exponents or spaces
 * inside the number. Returns null when invalid.
 */
export function parseMoneyInput(value: string): Money | null {
  const match = INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(INPUT_DECIMALS, '0');
  return whole * SCALE_FACTOR + BigInt(fraction) * INPUT_FACTOR;
}

/** Parses a value read from NUMERIC(19,4) (up to 4 decimals, optional sign). Throws on anything else. */
export function parseDbMoney(value: string): Money {
  const match = DB_PATTERN.exec(value.trim());
  if (!match) throw new Error('Unexpected money value from the database');
  const whole = BigInt(match[2] ?? '0');
  const fraction = (match[3] ?? '').padEnd(MONEY_SCALE, '0');
  const magnitude = whole * SCALE_FACTOR + BigInt(fraction);
  return match[1] === '-' ? -magnitude : magnitude;
}

/** Four-decimal text for NUMERIC(19,4) parameters, e.g. 4000000 (scaled) -> "400.0000". */
export function toDbMoney(value: Money): string {
  const negative = value < ZERO;
  const magnitude = negative ? -value : value;
  const whole = magnitude / SCALE_FACTOR;
  const fraction = (magnitude % SCALE_FACTOR).toString().padStart(MONEY_SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Display text: two decimals, or four only when the value genuinely has them. Never rounds. */
export function formatMoney(value: Money): string {
  const text = toDbMoney(value);
  return text.endsWith('00') ? text.slice(0, -2) : text;
}

/** Normalizes a decimal string from the database for display (no rounding). */
export function formatDbMoney(value: string): string {
  return formatMoney(parseDbMoney(value));
}

/**
 * A display amount shown as a deduction ("−25.25"). A zero amount is shown without a sign ("0.00"), never as "−0.00".
 * `formatted` is an amount already formatted by formatMoney/formatDbMoney.
 */
export function formatDeduction(formatted: string): string {
  return parseDbMoney(formatted) === ZERO ? formatted : `\u2212${formatted}`;
}

export function multiplyByQuantity(unit: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Quantity must be a non-negative integer');
  return unit * BigInt(quantity);
}

export function sumMoney(values: readonly Money[]): Money {
  return values.reduce((total, value) => total + value, ZERO);
}

export function isWithinMoneyLimit(value: Money): boolean {
  return value >= ZERO && value <= MAX_MONEY;
}
