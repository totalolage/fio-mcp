import { DateTime, Effect } from "effect";

/**
 * Calendar-day arithmetic on `YYYY-MM-DD` strings. FIO publishes dates in
 * Prague time and takes period bounds as plain dates, so the cache works in
 * calendar days, never instants.
 */

export const FIO_TIME_ZONE = "Europe/Prague";

/** An inclusive range of calendar days. */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

/** Today's calendar date in Prague, from the Effect Clock. */
export const pragueToday: Effect.Effect<string> = Effect.map(DateTime.now, (now) =>
  DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(now, FIO_TIME_ZONE)),
);

/** The Prague calendar date of an instant. */
export function pragueDateOf(epochMillis: number): string {
  return DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(epochMillis), FIO_TIME_ZONE));
}

// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function dayNumber(date: string): number {
  return daysFromCivil(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
}

export function addDays(date: string, days: number): string {
  return civilFromDays(dayNumber(date) + days);
}

/** Number of days in an inclusive range (0 when `to` is before `from`). */
export function rangeLength(range: DayRange): number {
  return Math.max(0, dayNumber(range.to) - dayNumber(range.from) + 1);
}

export function eachDay(range: DayRange): ReadonlyArray<string> {
  const start = dayNumber(range.from);
  return Array.from({ length: rangeLength(range) }, (_, i) => civilFromDays(start + i));
}

export const minDate = (a: string, b: string): string => (a < b ? a : b);
export const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** The overlap of two ranges, if any. */
export function intersect(a: DayRange, b: DayRange): DayRange | undefined {
  const from = maxDate(a.from, b.from);
  const to = minDate(a.to, b.to);
  return from <= to ? { from, to } : undefined;
}

/** Splits a multi-day range into two halves; the later half first. */
export function splitNewestFirst(range: DayRange): readonly [DayRange, DayRange] {
  const mid = addDays(range.from, Math.floor((rangeLength(range) - 1) / 2));
  return [
    { from: addDays(mid, 1), to: range.to },
    { from: range.from, to: mid },
  ];
}

/** Collapses sorted, distinct days into runs of consecutive days. */
export function toRanges(sortedDays: ReadonlyArray<string>): ReadonlyArray<DayRange> {
  const ranges: Array<DayRange> = [];
  let current: { from: string; to: string } | undefined;
  for (const day of sortedDays) {
    if (current !== undefined && addDays(current.to, 1) === day) current.to = day;
    else {
      if (current !== undefined) ranges.push(current);
      current = { from: day, to: day };
    }
  }
  if (current !== undefined) ranges.push(current);
  return ranges;
}

/** Ranges ordered newest first, overlapping or adjacent ones merged. */
export function normalizeRanges(ranges: ReadonlyArray<DayRange>): ReadonlyArray<DayRange> {
  const sorted = [...ranges].filter((r) => r.from <= r.to).sort((a, b) => (a.from < b.from ? -1 : 1));
  const merged: Array<{ from: string; to: string }> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.from <= addDays(last.to, 1)) last.to = maxDate(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged.reverse();
}

/** `range` minus every day in `remove` (sorted ascending), as ranges newest first. */
export function subtractDays(range: DayRange, remove: ReadonlySet<string>): ReadonlyArray<DayRange> {
  return [...toRanges(eachDay(range).filter((day) => !remove.has(day)))].reverse();
}
