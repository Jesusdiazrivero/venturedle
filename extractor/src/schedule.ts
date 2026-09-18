/**
 * Dates are assigned after extraction, to the records that survived, in input order: the schedule
 * is always contiguous from `start`. A rejected domain does not consume a date — it shifts
 * everything after it, which is why the CLI shouts about rejections.
 */
import { isCalendarDate } from "@venturedle/shared/server";

const DAY_MS = 86_400_000;

export function addUtcDays(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new Error(`not a calendar date: "${date}"`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function assignDates<T>(
  records: readonly T[],
  start: string,
): (T & { date: string })[] {
  if (!isCalendarDate(start))
    throw new Error(`--start must be a real YYYY-MM-DD date, got "${start}"`);
  return records.map((record, i) => ({
    ...record,
    date: addUtcDays(start, i),
  }));
}
