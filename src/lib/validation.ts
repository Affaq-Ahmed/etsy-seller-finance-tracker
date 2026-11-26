// Free-text screening (PRODUCT.md §5 rule 2). The database cannot enforce
// "no buyer PII", so text is screened before storage. This is a best-effort
// filter, not a guarantee:
//   - email addresses and phone-number-like digit runs are detected;
//   - postal addresses and names CANNOT be detected reliably and are not;
//   - long digit runs in notes (order or tracking numbers) can be flagged by
//     mistake, so reference numbers belong in their dedicated fields.

export const NOTES_MAX_LENGTH = 2000;
export const URL_MAX_LENGTH = 2048;
export const REFERENCE_PATTERN = /^[A-Za-z0-9._:/#-]{1,160}$/;
export const ETSY_ORDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export const PII_WARNING = "Don't enter buyer details (names, addresses, emails or phone numbers). Only the Etsy Order ID identifies an order.";

const EMAIL_PATTERN = /[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[A-Za-z]{2,}/;
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const CLOCK_TIME_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const PHONE_CANDIDATE_PATTERN = /\+?\(?\d[\d\s().-]{6,}\d/g;
const MIN_PHONE_DIGITS = 9;
const MIN_INTERNATIONAL_PHONE_DIGITS = 8;

export function containsEmail(text: string): boolean {
  return EMAIL_PATTERN.test(text);
}

export function containsPhoneNumber(text: string): boolean {
  const cleaned = text.replace(ISO_DATE_PATTERN, ' ').replace(CLOCK_TIME_PATTERN, ' ');
  for (const candidate of cleaned.match(PHONE_CANDIDATE_PATTERN) ?? []) {
    const digits = candidate.replace(/\D/g, '').length;
    const minimum = candidate.startsWith('+') ? MIN_INTERNATIONAL_PHONE_DIGITS : MIN_PHONE_DIGITS;
    if (digits >= minimum) return true;
  }
  return false;
}

export type PiiProblem = 'email' | 'phone';

export function findPiiProblem(text: string): PiiProblem | null {
  if (containsEmail(text)) return 'email';
  if (containsPhoneNumber(text)) return 'phone';
  return null;
}

/** http(s) URL of bounded length with no credentials and no email address anywhere in it. */
export function isSafeHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escapes: screen the raw text only.
  }
  return !containsEmail(value) && !containsEmail(decoded);
}
