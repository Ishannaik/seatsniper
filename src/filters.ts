/** Screen format, theatre, weekday, time-window, and seat/budget watch filters. */
import type { Show } from "./movie-model.ts";
import {
  dayOfWeek,
  FULL_WEEKDAYS,
  formatTimeWindow,
  isUpcomingOnToday,
  matchesTimeFilter,
  parseTimeFilter,
  todayIST,
  WEEKDAY_ALIASES,
  type WeekdayCode,
} from "./time-filter.ts";

const FORMAT_CHOICES = [
  "PXL",
  "PXL 3D",
  "PXL 2D",
  "IMAX",
  "IMAX 3D",
  "IMAX 2D",
  "4DX",
  "ScreenX",
  "3D",
  "2D",
  "MX4D",
  "ICE",
  "Dolby Atmos",
  "Dolby Cinema",
  "RPX",
  "VIP",
];

const DAY_CHOICES: readonly WeekdayCode[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DAY_PRESETS = [
  { name: "Weekend (fri,sat,sun)", value: "fri,sat,sun", keywords: ["weekend", "wknd"] },
  { name: "Weekdays (mon–fri)", value: "mon,tue,wed,thu,fri", keywords: ["weekdays", "weekday"] },
];

export type BookingPreferences = {
  seat_count?: number | null;
  seat_budget?: number | null;
};

export type WatchFilters = BookingPreferences & {
  format_filter: string | null;
  day_filter: string | null;
  after_filter?: string | null;
  before_filter?: string | null;
  theatre_filter?: string | null;
};

export type NormalizedWatchFilters = {
  format_filter: string | null;
  day_filter: string | null;
  after_filter: string | null;
  before_filter: string | null;
  theatre_filter: string | null;
  seat_count: number | null;
  seat_budget: number | null;
};

/** Counts are within one ticket category; they never imply seats are adjacent. */
export function matchesBookingPreferences(show: Show, prefs: BookingPreferences): boolean {
  if (prefs.seat_count == null && prefs.seat_budget == null) return true;
  const minSeats = prefs.seat_count ?? 1;
  return (
    show.ticketCategories?.some(
      (category) =>
        category.available >= minSeats &&
        (prefs.seat_budget == null || category.price <= prefs.seat_budget),
    ) ?? false
  );
}

function bookingPreferenceError(prefs: BookingPreferences): string | null {
  if (
    prefs.seat_count != null &&
    (!Number.isInteger(prefs.seat_count) || prefs.seat_count < 1 || prefs.seat_count > 10)
  ) {
    return "seats must be a whole number from 1 to 10.";
  }
  if (
    prefs.seat_budget != null &&
    (!Number.isFinite(prefs.seat_budget) || prefs.seat_budget <= 0)
  ) {
    return "budget must be a positive price per seat in INR.";
  }
  return null;
}

export function validateBookingPreferences(prefs: BookingPreferences): void {
  const err = bookingPreferenceError(prefs);
  if (err) throw new Error(err);
}

/** "IMAX, 4dx , screenx" -> "IMAX,4DX,SCREENX" | null */
export function normaliseFormats(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const unique = Array.from(
    new Set(
      raw
        .split(",")
        .map((f) => f.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  return unique.join(",") || null;
}

/** "pvr , INOX,imax wadala" -> "PVR,INOX,IMAX WADALA" | null */
export function normaliseTheatres(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const unique = Array.from(
    new Set(
      raw
        .split(",")
        .map((t) => t.trim().replace(/\s+/g, " ").toUpperCase())
        .filter(Boolean),
    ),
  );
  return unique.join(",") || null;
}

/** "Fri, SAT ,sun" -> "fri,sat,sun". null when unset, or when any token isn't a weekday. */
export function normaliseDays(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const tokens = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return null;
  const mapped: string[] = [];
  for (const token of tokens) {
    const canonical = WEEKDAY_ALIASES[token];
    if (!canonical) return null;
    if (!mapped.includes(canonical)) mapped.push(canonical);
  }
  return mapped.join(",");
}

/**
 * Case-insensitive substring ignoring spaces/punctuation, so "IMAX" catches
 * "IMAX 3D", "SCREEN X" matches "SCREENX", and "P[XL] (3D)" matches "PXL 3D".
 */
export function matchesFormat(attributes: string, filter: string): boolean {
  const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const attr = compact(attributes ?? "");
  return filter.split(",").some((f) => {
    const needle = compact(f);
    return needle.length > 0 && attr.includes(needle);
  });
}

/** Does a YYYYMMDD date fall on one of the filtered days? */
export function matchesDay(dateCode: string, filter: string): boolean {
  return filter.split(",").includes(dayOfWeek(dateCode));
}

/**
 * Case-insensitive substring against venue name and code joined by NUL so a needle
 * cannot match by straddling the name/code boundary.
 */
export function matchesTheatre(venueName: string, venueCode: string, filter: string): boolean {
  const haystack = `${venueName ?? ""}\u0000${venueCode ?? ""}`.toUpperCase().replace(/\s+/g, " ");
  return filter.split(",").some((t) => {
    const needle = t.trim().replace(/\s+/g, " ");
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** True when evaluating dates requires inspecting individual sessions on each date. */
export function hasShowLevelFilter(
  provider: "bms" | "district" | undefined,
  f: WatchFilters,
): boolean {
  return (
    provider === "district" ||
    f.seat_count != null ||
    f.seat_budget != null ||
    Boolean(f.format_filter || f.theatre_filter || f.after_filter || f.before_filter)
  );
}

/** Filter shows against all active watch constraints (today's clock, day, format, venue, window, tier). */
export function filterMatchingShows(
  shows: Show[],
  f: WatchFilters,
  opts?: {
    today?: string;
    nowMs?: number;
    checkFormat?: boolean;
    checkDay?: boolean;
  },
): Show[] {
  const today = opts?.today ?? todayIST();
  const nowMs = opts?.nowMs ?? Date.now();
  const afterMin = f.after_filter ? parseTimeFilter(f.after_filter) : null;
  const beforeMin = f.before_filter ? parseTimeFilter(f.before_filter) : null;

  return shows.filter(
    (sh) =>
      isUpcomingOnToday(sh, today, nowMs) &&
      (!opts?.checkDay || !f.day_filter || matchesDay(sh.showDateCode, f.day_filter)) &&
      (!opts?.checkFormat || !f.format_filter || matchesFormat(sh.attributes, f.format_filter)) &&
      (!f.theatre_filter || matchesTheatre(sh.venueName, sh.venueCode, f.theatre_filter)) &&
      matchesTimeFilter(sh.epoch, afterMin, beforeMin) &&
      matchesBookingPreferences(sh, f),
  );
}

/** Parse raw `/watch` filter inputs, rejecting unreadable values instead of dropping them. */
export function parseWatchFilters(raw: {
  format?: string | null;
  days?: string | null;
  after?: string | null;
  before?: string | null;
  theatre?: string | null;
  seats?: number | null;
  budget?: number | null;
}):
  | { ok: true; filters: NormalizedWatchFilters; summary: string | null }
  | { ok: false; error: string } {
  const seat_count = raw.seats ?? null;
  const seat_budget = raw.budget ?? null;
  const prefError = bookingPreferenceError({ seat_count, seat_budget });
  if (prefError) return { ok: false, error: `❌ ${prefError}` };

  const format_filter = normaliseFormats(raw.format ?? null);
  const daysRaw = raw.days?.trim() || null;
  const day_filter = normaliseDays(daysRaw);
  if (daysRaw !== null && day_filter === null) {
    return {
      ok: false,
      error: `❌ I couldn't read \`days: ${daysRaw}\` — use short weekday names like \`fri,sat,sun\`.`,
    };
  }

  const after_filter = raw.after?.trim() || null;
  const before_filter = raw.before?.trim() || null;
  const afterMinutes = after_filter === null ? null : parseTimeFilter(after_filter);
  const beforeMinutes = before_filter === null ? null : parseTimeFilter(before_filter);
  if (after_filter !== null && afterMinutes === null) {
    return {
      ok: false,
      error: `❌ I couldn't read \`after: ${after_filter}\` as a time. Use 24-hour \`18:00\` or \`6pm\`.`,
    };
  }
  if (before_filter !== null && beforeMinutes === null) {
    return {
      ok: false,
      error: `❌ I couldn't read \`before: ${before_filter}\` as a time. Use 24-hour \`12:00\` or \`11am\`.`,
    };
  }
  if (beforeMinutes === 0) {
    return {
      ok: false,
      error: `❌ \`before: ${before_filter}\` is midnight (00:00), so no show on that date could start earlier. Omit \`before:\` or use \`23:59\`.`,
    };
  }
  if (afterMinutes !== null && beforeMinutes !== null && afterMinutes >= beforeMinutes) {
    return {
      ok: false,
      error:
        `❌ \`after: ${after_filter}\` is not before \`before: ${before_filter}\`, so no show could ever match. ` +
        "The window does not wrap past midnight.",
    };
  }

  const filters: NormalizedWatchFilters = {
    format_filter,
    day_filter,
    after_filter,
    before_filter,
    theatre_filter: normaliseTheatres(raw.theatre ?? null),
    seat_count,
    seat_budget,
  };
  return { ok: true, filters, summary: filterSummary(filters) };
}

/** Human-readable filter summary for embeds, e.g. "IMAX · 4DX · Fri, Sat, Sun". */
export function filterSummary(w: WatchFilters): string | null {
  const parts: string[] = [];
  if (w.seat_count != null) {
    parts.push(`${w.seat_count} seats in one category (adjacency unchecked)`);
  }
  if (w.seat_budget != null) {
    parts.push(`up to ₹${w.seat_budget}/seat before fees`);
  }
  if (w.format_filter) {
    parts.push(w.format_filter.split(",").join(" · "));
  }
  if (w.theatre_filter) {
    parts.push(w.theatre_filter.split(",").join(" · "));
  }
  if (w.day_filter) {
    parts.push(
      w.day_filter
        .split(",")
        .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
        .join(", "),
    );
  }
  const windowText = formatTimeWindow(w.after_filter, w.before_filter);
  if (windowText) parts.push(windowText);
  return parts.length ? parts.join(" · ") : null;
}

/** Preserve existing alternatives while suggesting the last comma-separated format. */
export function formatSuggestions(value: string): { name: string; value: string }[] {
  const parts = value.split(",");
  const query = (parts.pop() ?? "").trim().toUpperCase();
  const selected = parts.map((part) => part.trim()).filter(Boolean);
  return FORMAT_CHOICES.filter(
    (choice) =>
      choice.toUpperCase().includes(query) &&
      !selected.some((part) => part.toUpperCase() === choice.toUpperCase()),
  )
    .map((choice) => ({ name: choice, value: [...selected, choice].join(",") }))
    .filter((choice) => choice.value.length <= 100)
    .slice(0, 25);
}

/** Preserve comma-separated weekday selections and surface Weekend / Weekdays presets. */
export function daySuggestions(value: string): { name: string; value: string }[] {
  const parts = value.split(",");
  const query = (parts.pop() ?? "").trim().toLowerCase();
  const selected = parts
    .map((part) => {
      const token = part.trim().toLowerCase();
      return WEEKDAY_ALIASES[token] ?? token;
    })
    .filter(Boolean);

  const presets =
    selected.length === 0
      ? DAY_PRESETS.filter(
          (preset) => query === "" || preset.keywords.some((kw) => kw.includes(query)),
        ).map(({ name, value: presetValue }) => ({ name, value: presetValue }))
      : [];

  const singles = DAY_CHOICES.filter((day) => {
    if (selected.includes(day)) return false;
    return day.includes(query) || FULL_WEEKDAYS[day].includes(query);
  }).map((day) => ({
    name: day,
    value: [...selected, day].join(","),
  }));

  return [...presets, ...singles].filter((choice) => choice.value.length <= 100).slice(0, 25);
}
