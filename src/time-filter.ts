/** IST wall-clock windows, natural date inputs, and show epoch conversions. */
import { BmsError } from "./provider-error.ts";

export type WeekdayCode = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export const WEEKDAY_CODES: readonly WeekdayCode[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

export const FULL_WEEKDAYS: Record<WeekdayCode, string> = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
};

export const WEEKDAY_ALIASES: Record<string, WeekdayCode> = {
  sun: "sun",
  sunday: "sun",
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  weds: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
};

export const IST_OFFSET_MS = 19_800_000;

/** Minutes since midnight for an IST wall-clock time ("18:00", "6:00 PM", "6pm"). */
export function parseTimeFilter(value: string): number | null {
  const raw = value.trim().toLowerCase();

  const match24 = raw.match(/^(\d{2}):(\d{2})$/);
  if (match24) {
    const hours = Number(match24[1]);
    const minutes = Number(match24[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  const match12 = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match12) {
    let hours = Number(match12[1]);
    const minutes = Number(match12[2] ?? 0);
    const period = match12[3];
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  return null;
}

/** Render an optional [after, before) window as a single constraint phrase. */
export function formatTimeWindow(after?: string | null, before?: string | null): string | null {
  if (after && before) return `${after}–${before}`;
  if (after) return `after ${after}`;
  if (before) return `before ${before}`;
  return null;
}

/** True when a show's IST wall-clock time falls inside the optional window. */
export function matchesTimeFilter(
  epoch: number,
  afterMinutes?: number | null,
  beforeMinutes?: number | null,
): boolean {
  if (epoch <= 0 || (afterMinutes == null && beforeMinutes == null)) return true;
  const minutes = istMinutes(epoch);
  if (afterMinutes != null && minutes < afterMinutes) return false;
  if (beforeMinutes != null && minutes >= beforeMinutes) return false;
  return true;
}

/** "202607280640" (IST wall clock) -> unix seconds. India is UTC+5:30, no DST. */
export function istToEpoch(showDateTime: string): number {
  const y = Number(showDateTime.slice(0, 4));
  const mo = Number(showDateTime.slice(4, 6));
  const d = Number(showDateTime.slice(6, 8));
  const h = Number(showDateTime.slice(8, 10));
  const mi = Number(showDateTime.slice(10, 12));
  return Math.floor((Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS) / 1000);
}

/** Unix seconds -> IST calendar date (`YYYYMMDD`) and 24-hour clock (`HH:MM`). */
export function epochToIst(epochSeconds: number): { dateCode: string; showTime: string } {
  const iso = new Date(epochSeconds * 1000 + IST_OFFSET_MS).toISOString();
  return {
    dateCode: iso.slice(0, 10).replaceAll("-", ""),
    showTime: iso.slice(11, 16),
  };
}

/** Format `YYYYMMDD` as `YYYY-MM-DD`. */
export function isoDate(dateCode: string): string {
  return `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
}

/**
 * "20260730" -> "Thu, 30 Jul".
 *
 * Builds the date in local time and formats it in local time, so the day never
 * shifts across timezones. Callers must not pass a subscription watch's empty
 * date (`SUBSCRIPTION`), because `Number("")` is 0 and formats as an 1899 date.
 */
export function prettyDate(yyyymmdd: string): string {
  const d = new Date(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8));
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

export function todayIST(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

/** Suppress showtimes on today's IST date whose start time has already passed. */
export function isUpcomingOnToday(
  show: { showDateCode: string; epoch: number },
  today = todayIST(),
  nowMs = Date.now(),
): boolean {
  if (show.showDateCode !== today) return true;
  return show.epoch <= 0 || show.epoch * 1000 > nowMs;
}

/** Shift a YYYYMMDD calendar date by `days` (UTC math, host-TZ-independent). */
export function addDaysToDateCode(dateCode: string, days: number): string {
  const y = Number(dateCode.slice(0, 4));
  const m = Number(dateCode.slice(4, 6));
  const d = Number(dateCode.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10).replaceAll("-", "");
}

function utcWeekdayIndex(dateCode: string): number {
  const y = Number(dateCode.slice(0, 4));
  const m = Number(dateCode.slice(4, 6));
  const d = Number(dateCode.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** YYYYMMDD -> "mon"|"tue"|...|"sun" (UTC, host-TZ-independent). */
export function dayOfWeek(dateCode: string): WeekdayCode {
  if (!/^\d{8}$/.test(dateCode)) {
    throw new Error(`dayOfWeek: expected a YYYYMMDD date code, got ${JSON.stringify(dateCode)}`);
  }
  return WEEKDAY_CODES[utcWeekdayIndex(dateCode)] ?? "sun";
}

function resolveRelativeDate(lower: string, today: string): string | null {
  if (lower === "today" || lower === "tod") return today;
  if (lower === "tomorrow" || lower === "tom" || lower === "tmrw") {
    return addDaysToDateCode(today, 1);
  }
  const nextMatch = lower.match(/^next\s+([a-z]+)$/);
  if (nextMatch) {
    const canonical = WEEKDAY_ALIASES[nextMatch[1] ?? ""];
    if (canonical) {
      const targetDow = WEEKDAY_CODES.indexOf(canonical);
      const offset = (targetDow - utcWeekdayIndex(today) + 7) % 7 || 7;
      return addDaysToDateCode(today, offset);
    }
  }
  const token = lower.startsWith("this ") ? lower.slice(5) : lower;
  const canonical = WEEKDAY_ALIASES[token];
  if (canonical) {
    const targetDow = WEEKDAY_CODES.indexOf(canonical);
    const offset = (targetDow - utcWeekdayIndex(today) + 7) % 7;
    return addDaysToDateCode(today, offset);
  }
  return null;
}

/**
 * Parse user date input into a YYYYMMDD IST date code or `"any"` subscription marker.
 * Supports `"any"`/`"all"`/`"every"`/`"new"`, `"today"`, `"tomorrow"`/`"tom"`,
 * upcoming IST weekdays (`"fri"`, `"sunday"`, `"next fri"`), and `YYYY-MM-DD`/`YYYYMMDD`.
 */
export function parseDateInput(raw: string, now = Date.now()): string | "any" {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new BmsError(
      "bad_url",
      'Date cannot be empty — use 2026-07-30, "today", "tomorrow", "fri", or "any".',
    );
  }
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (/^(any|all|every|new)$/.test(lower)) return "any";

  const relative = resolveRelativeDate(lower, todayIST(now));
  if (relative) return relative;

  const compact = trimmed.replace(/[-/]/g, "");
  if (/^\d{8}$/.test(compact)) {
    if (!isRealDateCode(compact)) {
      throw new BmsError("bad_url", `"${trimmed}" isn't a real date.`);
    }
    return compact;
  }

  throw new BmsError(
    "bad_url",
    `Date must look like 2026-07-30, "today", "tomorrow", "fri", or "any" — got "${trimmed}".`,
  );
}

export function istMinutes(epochSeconds: number): number {
  const date = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export function isRealDateCode(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const actual = new Date(`${isoDate(date)}T00:00:00Z`);
  return (
    Number.isFinite(actual.getTime()) &&
    actual.toISOString().slice(0, 10).replaceAll("-", "") === date
  );
}
