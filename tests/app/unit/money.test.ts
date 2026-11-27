import { describe, expect, it } from 'vitest';
import {
  formatDbMoney, formatDeduction, formatMoney, isWithinMoneyLimit, MAX_MONEY, multiplyByQuantity, parseDbMoney, parseMoneyInput, sumMoney, toDbMoney,
} from '@/lib/money';

const money = (text: string) => {
  const parsed = parseMoneyInput(text);
  if (parsed === null) throw new Error(`not money: ${text}`);
  return parsed;
};

describe('parseMoneyInput', () => {
  it.each([
    ['0', '0.0000'], ['0.5', '0.5000'], ['10', '10.0000'], ['10.1', '10.1000'], ['10.10', '10.1000'], ['0.01', '0.0100'],
    ['999999999999.99', '999999999999.9900'], [' 5.25 ', '5.2500'], ['007.50', '7.5000'],
  ])('accepts %s', (input, db) => {
    expect(toDbMoney(money(input))).toBe(db);
  });

  it.each([
    [''], [' '], ['.5'], ['5.'], ['5.123'], ['-1'], ['+1'], ['1e3'], ['1,000.00'], ['1 000'], ['$5'], ['5 USD'], ['NaN'], ['Infinity'],
    ['0x10'], ['1000000000000'], ['1000000000000.00'], ['１２'],
  ])('rejects %j', (input) => {
    expect(parseMoneyInput(input)).toBeNull();
  });
});

describe('exact arithmetic', () => {
  it('adds 0.10 and 0.20 to exactly 0.30 (no binary floating point)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(formatMoney(sumMoney([money('0.10'), money('0.20')]))).toBe('0.30');
    expect(toDbMoney(sumMoney([money('0.10'), money('0.20')]))).toBe('0.3000');
  });

  it('multiplies exactly by whole quantities', () => {
    expect(formatMoney(multiplyByQuantity(money('3.33'), 3))).toBe('9.99');
    expect(formatMoney(multiplyByQuantity(money('12345.67'), 99_999))).toBe('1234554654.33');
    expect(multiplyByQuantity(money('5'), 0)).toBe(BigInt(0));
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 2]])('refuses quantity %s', (quantity) => {
    expect(() => multiplyByQuantity(money('1'), quantity)).toThrow();
  });

  it('splits 10.00 for 3 units into lines with no lost or invented cent', () => {
    const total = sumMoney([multiplyByQuantity(money('3.34'), 1), multiplyByQuantity(money('3.33'), 2)]);
    expect(formatMoney(total)).toBe('10.00');
  });

  it('sums an empty list to zero', () => {
    expect(sumMoney([])).toBe(BigInt(0));
  });
});

describe('database text round trip', () => {
  it.each([['0.0000'], ['40.0000'], ['0.0001'], ['123456789012345.6789'], ['-4.7500'], ['7']])('parseDbMoney/toDbMoney %s', (text) => {
    const normalized = text.includes('.') ? text : `${text}.0000`;
    expect(toDbMoney(parseDbMoney(text))).toBe(normalized);
  });

  it.each([[''], ['abc'], ['1.23456'], ['1e5'], ['--1']])('parseDbMoney rejects %j', (text) => {
    expect(() => parseDbMoney(text)).toThrow();
  });

  it('displays two decimals when exact and four only when needed, never rounding', () => {
    expect(formatDbMoney('40.0000')).toBe('40.00');
    expect(formatDbMoney('40.5000')).toBe('40.50');
    expect(formatDbMoney('40.0050')).toBe('40.0050');
    expect(formatDbMoney('0.0001')).toBe('0.0001');
    expect(formatDbMoney('-4.7500')).toBe('-4.75');
    expect(formatMoney(parseDbMoney('0'))).toBe('0.00');
  });
});

describe('limits', () => {
  it('accepts up to 999,999,999,999.99 and nothing above', () => {
    expect(MAX_MONEY).toBe(parseMoneyInput('999999999999.99'));
    expect(isWithinMoneyLimit(MAX_MONEY)).toBe(true);
    expect(isWithinMoneyLimit(MAX_MONEY + BigInt(1))).toBe(false);
    expect(isWithinMoneyLimit(BigInt(-1))).toBe(false);
    expect(isWithinMoneyLimit(BigInt(0))).toBe(true);
  });

  it('keeps the largest legal total inside NUMERIC(19,4)', () => {
    expect(toDbMoney(MAX_MONEY).replace('.', '').length).toBeLessThanOrEqual(19);
  });
});

describe('formatDeduction', () => {
  it('prefixes a real amount with a minus sign (U+2212)', () => {
    expect(formatDeduction('25.25')).toBe('\u221225.25');
    expect(formatDeduction('0.0050')).toBe('\u22120.0050');
    expect(formatDeduction(formatDbMoney('4.2500'))).toBe('\u22124.25');
  });

  it('shows zero without a sign, however it was formatted', () => {
    expect(formatDeduction('0.00')).toBe('0.00');
    expect(formatDeduction(formatMoney(money('0')))).toBe('0.00');
    expect(formatDeduction(formatDbMoney('0.0000'))).toBe('0.00');
    expect(formatDeduction('0')).toBe('0');
  });
});
