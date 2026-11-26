import { describe, expect, it } from 'vitest';
import {
  compareCalendarDates, instantToZonedDate, isValidCalendarDate, isValidTimeZone, zonedDateToInstant,
} from '@/lib/dates';

describe('isValidCalendarDate', () => {
  it.each([['2026-11-25'], ['2024-02-29'], ['2000-01-01'], ['2100-12-31']])('accepts %s', (date) => {
    expect(isValidCalendarDate(date)).toBe(true);
  });

  it.each([
    [''], ['2026-2-3'], ['2026-02-30'], ['2025-02-29'], ['2026-13-01'], ['2026-00-10'], ['2026-11-31'], ['1999-12-31'], ['2101-01-01'],
    ['20261125'], ['2026/11/25'], ['2026-11-25T00:00:00Z'], [' 2026-11-25'], ['today'],
  ])('rejects %j', (date) => {
    expect(isValidCalendarDate(date)).toBe(false);
  });
});

describe('calendar dates in a business timezone', () => {
  it('stores Asia/Karachi midnight as 19:00 UTC the day before, and shows the same date again', () => {
    const instant = zonedDateToInstant('2026-11-25', 'Asia/Karachi');
    expect(instant.toISOString()).toBe('2026-11-24T19:00:00.000Z');
    expect(instantToZonedDate(instant, 'Asia/Karachi')).toBe('2026-11-25');
    // Reading the same instant in UTC would show the wrong calendar day, which is why UTC midnight is not stored.
    expect(instantToZonedDate(instant, 'UTC')).toBe('2026-11-24');
  });

  it('follows daylight saving time', () => {
    expect(zonedDateToInstant('2026-11-25', 'America/New_York').toISOString()).toBe('2026-11-25T05:00:00.000Z');
    expect(zonedDateToInstant('2026-07-04', 'America/New_York').toISOString()).toBe('2026-07-04T04:00:00.000Z');
    expect(zonedDateToInstant('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedDateToInstant('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(zonedDateToInstant('2026-11-01', 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it.each([
    'UTC', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin',
    'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Havana', 'America/Sao_Paulo', 'Africa/Casablanca',
  ])('round-trips every day around the year boundaries and DST changes in %s', (zone) => {
    for (const month of [1, 3, 4, 7, 9, 10, 11, 12]) {
      for (let day = 1; day <= 28; day++) {
        const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const instant = zonedDateToInstant(date, zone);
        expect(instantToZonedDate(instant, zone), `${zone} ${date}`).toBe(date);
      }
    }
  });

  it('keeps consecutive dates in order even across a spring-forward gap at midnight', () => {
    const before = zonedDateToInstant('2026-03-07', 'America/Havana').getTime();
    const gap = zonedDateToInstant('2026-03-08', 'America/Havana').getTime();
    const after = zonedDateToInstant('2026-03-09', 'America/Havana').getTime();
    expect(before).toBeLessThan(gap);
    expect(gap).toBeLessThan(after);
    expect(instantToZonedDate(new Date(gap), 'America/Havana')).toBe('2026-03-08');
  });

  it('refuses an invalid date', () => {
    expect(() => zonedDateToInstant('2026-02-30', 'UTC')).toThrow();
  });

  it('validates timezone names', () => {
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('compares calendar dates lexically', () => {
    expect(compareCalendarDates('2026-11-19', '2026-11-20')).toBe(-1);
    expect(compareCalendarDates('2026-11-20', '2026-11-20')).toBe(0);
    expect(compareCalendarDates('2026-12-01', '2026-11-30')).toBe(1);
  });
});
