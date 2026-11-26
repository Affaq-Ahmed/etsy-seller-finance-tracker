// Calendar dates in the business timezone (PRODUCT.md decision, Phase 2a).
//
// Users enter calendar dates ("2026-11-25"). A date is stored as the instant of
// local midnight in the business timezone, and displayed by converting the
// instant back into that timezone, so the calendar date never shifts.
// Storing UTC midnight instead would show the previous or next day to users
// whose timezone is not UTC. Uses only Intl (no dependency).

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function localParts(instantMs: number, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0, month: values.month ?? 0, day: values.day ?? 0,
    hour: values.hour ?? 0, minute: values.minute ?? 0, second: values.second ?? 0,
  };
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds (local wall clock minus UTC). */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(instantMs, timeZone);
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecondMs;
}

/** The calendar date ("YYYY-MM-DD") that an instant falls on in `timeZone`. */
export function instantToZonedDate(instant: Date, timeZone: string): string {
  const p = localParts(instant.getTime(), timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The instant of local midnight at the start of `date` in `timeZone`. If local
 * midnight does not exist (a DST gap), the first valid instant of that date is
 * used, so the date still round-trips.
 */
export function zonedDateToInstant(date: string, timeZone: string): Date {
  const match = DATE_PATTERN.exec(date);
  if (!match || !isValidCalendarDate(date)) throw new Error('Invalid calendar date');
  const wallClockAsUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const firstGuess = wallClockAsUtc - offsetMs(wallClockAsUtc, timeZone);
  const secondGuess = wallClockAsUtc - offsetMs(firstGuess, timeZone);
  const candidate = new Date(secondGuess);
  if (instantToZonedDate(candidate, timeZone) === date) return candidate;
  return new Date(firstGuess);
}

/** Compares two valid calendar dates; negative when a is earlier. */
export function compareCalendarDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
