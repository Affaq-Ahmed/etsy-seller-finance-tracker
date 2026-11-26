import { describe, expect, it } from 'vitest';
import {
  containsEmail, containsPhoneNumber, ETSY_ORDER_ID_PATTERN, findPiiProblem, isSafeHttpUrl, REFERENCE_PATTERN, URL_MAX_LENGTH,
} from '@/lib/validation';

describe('email screening', () => {
  it.each([
    ['jane@example.com'], ['Ship to jane.doe+etsy@mail.example.co.uk please'], ['JANE@EXAMPLE.COM'], ['(jane@example.com)'], ['mailto:a@b.io'],
  ])('flags %j', (text) => {
    expect(containsEmail(text)).toBe(true);
    expect(findPiiProblem(text)).toBe('email');
  });

  it.each([['no address here'], ['handmade @ 5pm'], ['twitter handle @shopname'], ['a@b'], ['price: 5 @ 2']])('allows %j', (text) => {
    expect(containsEmail(text)).toBe(false);
  });
});

describe('phone-number screening', () => {
  it.each([
    ['+92 300 1234567'], ['03001234567'], ['0300-1234567'], ['(415) 555-2671'], ['415.555.2671'], ['+1 415 555 2671'],
    ['call me on 0092 300 123 4567'], ['+44 20 7946 0958'], ['+4915123456'],
  ])('flags %j', (text) => {
    expect(containsPhoneNumber(text)).toBe(true);
    expect(findPiiProblem(text)).toBe('phone');
  });

  it.each([
    ['Packed 2026-11-20 14:30'], ['2026-11-20'], ['qty 12, price 4.50'], ['order of 3 mugs'], ['sku 12345'], ['1234567'], ['$1,234,567'],
    ['bought 2026-11-20 at 09:15:30 for 12.50'], ['page 10-20-30'],
  ])('does not flag %j', (text) => {
    expect(containsPhoneNumber(text)).toBe(false);
  });

  it('documents that a long reference number in notes can be flagged: use the reference fields', () => {
    expect(containsPhoneNumber('eBay order 12-34567-89012')).toBe(true);
    expect(REFERENCE_PATTERN.test('12-34567-89012')).toBe(true);
  });

  it('cannot detect postal addresses or names (documented limitation)', () => {
    expect(findPiiProblem('Jane Doe, 221B Baker Street, London')).toBeNull();
  });
});

describe('isSafeHttpUrl', () => {
  it.each([
    ['https://www.ebay.com/itm/123456789012'], ['http://example.com'], ['https://www.aliexpress.com/item/1005001.html?spm=a2g0o.cart'],
    [`https://example.com/${'a'.repeat(URL_MAX_LENGTH - 'https://example.com/'.length)}`],
  ])('accepts %j', (url) => {
    expect(isSafeHttpUrl(url)).toBe(true);
  });

  it.each([
    [''], ['ftp://example.com/file'], ['javascript:alert(1)'], ['data:text/html,hi'], ['file:///etc/passwd'], ['//example.com'], ['example.com'],
    ['https://user@example.com/'], ['https://user:secret@example.com/'], ['https://example.com/?email=jane@example.com'],
    ['https://example.com/?email=jane%40example.com'], ['https://example.com/jane@example.com'], ['not a url'],
    [`https://example.com/${'a'.repeat(URL_MAX_LENGTH)}`],
  ])('rejects %j', (url) => {
    expect(isSafeHttpUrl(url)).toBe(false);
  });
});

describe('identifier patterns', () => {
  it.each([['1234567890'], ['ORDER-1_2.3'], ['a'.repeat(120)]])('accepts the Etsy order ID %j', (id) => {
    expect(ETSY_ORDER_ID_PATTERN.test(id)).toBe(true);
  });

  it.each([[''], ['a'.repeat(121)], ['jane@example.com'], ['12 34'], ['12/34'], ['<script>']])('rejects the Etsy order ID %j', (id) => {
    expect(ETSY_ORDER_ID_PATTERN.test(id)).toBe(false);
  });

  it.each([['EB-1234'], ['12-34567-89012'], ['A/B#7:1'], ['a'.repeat(160)]])('accepts the reference %j', (ref) => {
    expect(REFERENCE_PATTERN.test(ref)).toBe(true);
  });

  it.each([[''], ['a'.repeat(161)], ['a@b.co'], ['with space'], ['semi;colon']])('rejects the reference %j', (ref) => {
    expect(REFERENCE_PATTERN.test(ref)).toBe(false);
  });
});
