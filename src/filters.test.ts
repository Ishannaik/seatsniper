import { expect, test } from "bun:test";
import {
  daySuggestions,
  filterMatchingShows,
  filterSummary,
  formatSuggestions,
  matchesBookingPreferences,
  matchesFormat,
  matchesTheatre,
  normaliseDays,
  normaliseFormats,
  normaliseTheatres,
  parseWatchFilters,
  validateBookingPreferences,
} from "./filters.ts";
import type { Show } from "./movie-model.ts";
import { dayOfWeek } from "./time-filter.ts";

const sampleShow: Show = {
  sessionId: "s",
  availStatus: "AVAILABLE",
  showDateCode: "20261120",
  showTime: "19:30",
  attributes: "IMAX 3D",
  epoch: Date.parse("2026-11-20T14:00:00Z") / 1000, // 19:30 IST on Friday
  venueCode: "PVRM",
  venueName: "PVR: Phoenix Palladium",
  ticketCategories: [
    { name: "Classic", available: 1, price: 300 },
    { name: "Recliner", available: 4, price: 900 },
  ],
};

test("normaliseFormats uppercases, trims, deduplicates, and returns null on empty input", () => {
  expect(normaliseFormats("ScreenX")).toBe("SCREENX");
  expect(normaliseFormats(" SCREEN X ")).toBe("SCREEN X");
  expect(normaliseFormats("IMAX, 4dx , screenx")).toBe("IMAX,4DX,SCREENX");
  expect(normaliseFormats("IMAX, imax, 4DX")).toBe("IMAX,4DX");
  expect(normaliseFormats("")).toBeNull();
  expect(normaliseFormats("  ")).toBeNull();
  expect(normaliseFormats(null)).toBeNull();
});

test("matchesFormat matches case-insensitively across spaces and punctuation without empty wildcards", () => {
  expect(matchesFormat("3D SCREEN X", "SCREENX")).toBe(true);
  expect(matchesFormat("SCREENX", "SCREEN X")).toBe(true);
  expect(matchesFormat("P[XL] (3D)", "pxl")).toBe(true);
  expect(matchesFormat("PXL (3D)", "PXL 3D")).toBe(true);
  expect(matchesFormat("PXL 2D", "PXL 3D")).toBe(false);
  expect(matchesFormat("IMAX 3D", "IMAX")).toBe(true);
  expect(matchesFormat("IMAX 2D", "PXL, IMAX")).toBe(true);
  expect(matchesFormat("PXL", "IMAX")).toBe(false);
  expect(matchesFormat("", "SCREENX")).toBe(false);
  expect(matchesFormat("Standard 2D", ",")).toBe(false);
});

test("normaliseTheatres uppercases, trims, deduplicates, and collapses inner whitespace", () => {
  expect(normaliseTheatres("pvr , INOX,imax  wadala")).toBe("PVR,INOX,IMAX WADALA");
  expect(normaliseTheatres("PVR, pvr, INOX")).toBe("PVR,INOX");
  expect(normaliseTheatres("")).toBeNull();
  expect(normaliseTheatres(",  ,")).toBeNull();
  expect(normaliseTheatres(null)).toBeNull();
});

test("matchesTheatre checks venue name and code without straddling boundary or matching empty tokens", () => {
  expect(matchesTheatre("PVR: Phoenix Palladium, Lower Parel", "PVLP", "PVR")).toBe(true);
  expect(matchesTheatre("IMAX Wadala", "IMOB", "IMOB")).toBe(true);
  expect(matchesTheatre("INOX: R-City, Ghatkopar", "INRC", "PVR,INOX")).toBe(true);
  expect(matchesTheatre("IMAX  Wadala", "IMOB", "IMAX WADALA")).toBe(true);
  expect(matchesTheatre("IMAX Wadala", "IMOB", "WADALAIMOB")).toBe(false);
  expect(matchesTheatre("", "", "PVR")).toBe(false);
  expect(matchesTheatre("INOX: R-City", "INRC", "PVR,")).toBe(false);
});

test("normaliseDays canonicalises weekday lists and rejects non-weekday tokens", () => {
  expect(normaliseDays("Fri, SAT ,sun")).toBe("fri,sat,sun");
  expect(normaliseDays("tues,thurs,fri,friday")).toBe("tue,thu,fri");
  expect(normaliseDays(null)).toBeNull();
  expect(normaliseDays("   ")).toBeNull();
  expect(normaliseDays("weekend")).toBeNull();
  expect(normaliseDays("fri,xyz")).toBeNull();
});

test("dayOfWeek resolves YYYYMMDD dates and rejects malformed date strings", () => {
  expect(dayOfWeek("20261003")).toBe("sat");
  expect(() => dayOfWeek("202613")).toThrow("YYYYMMDD");
  expect(() => dayOfWeek("")).toThrow("YYYYMMDD");
  expect(() => dayOfWeek("2026-10-03")).toThrow("YYYYMMDD");
});

test("seat count and budget must match within the same ticket category", () => {
  expect(matchesBookingPreferences(sampleShow, { seat_count: 2, seat_budget: 500 })).toBe(false);
  expect(matchesBookingPreferences(sampleShow, { seat_count: 2, seat_budget: 900 })).toBe(true);
  expect(matchesBookingPreferences(sampleShow, { seat_count: 5 })).toBe(false);
  expect(matchesBookingPreferences(sampleShow, { seat_budget: 300 })).toBe(true);
  expect(
    matchesBookingPreferences({ ...sampleShow, ticketCategories: undefined }, { seat_count: 2 }),
  ).toBe(false);
  expect(matchesBookingPreferences(sampleShow, {})).toBe(true);

  for (const prefs of [
    { seat_count: 0 },
    { seat_count: 11 },
    { seat_count: 1.5 },
    { seat_budget: 0 },
    { seat_budget: Number.NaN },
  ]) {
    expect(() => validateBookingPreferences(prefs)).toThrow();
  }
});

test("parseWatchFilters and filterMatchingShows enforce combined watch constraints", () => {
  expect(parseWatchFilters({ days: "wknd" }).ok).toBe(false);
  expect(parseWatchFilters({ after: "22:00", before: "18:00" }).ok).toBe(false);
  expect(parseWatchFilters({ seats: 0 }).ok).toBe(false);

  const parsed = parseWatchFilters({
    format: "imax",
    days: "fri,sat",
    after: "6pm",
    before: "10pm",
    theatre: "pvr",
    seats: 2,
    budget: 900,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  expect(
    filterMatchingShows([sampleShow], parsed.filters, {
      today: "20261118",
      checkFormat: true,
      checkDay: true,
    }),
  ).toHaveLength(1);
  expect(
    filterMatchingShows(
      [sampleShow],
      { ...parsed.filters, seat_budget: 500 },
      {
        today: "20261118",
        checkFormat: true,
        checkDay: true,
      },
    ),
  ).toHaveLength(0);
});

test("filterSummary formats seat/budget, format, theatre, days, and IST windows", () => {
  const empty = { format_filter: null, day_filter: null };
  expect(filterSummary(empty)).toBeNull();
  expect(filterSummary({ ...empty, after_filter: "18:00" })).toBe("after 18:00");
  expect(filterSummary({ ...empty, before_filter: "12:00" })).toBe("before 12:00");
  expect(filterSummary({ ...empty, after_filter: "18:00", before_filter: "23:00" })).toBe(
    "18:00–23:00",
  );
  expect(
    filterSummary({
      format_filter: "IMAX",
      theatre_filter: "PVR,INOX",
      day_filter: "fri,sat",
      after_filter: "18:00",
      seat_budget: 500,
    }),
  ).toBe("up to ₹500/seat before fees · IMAX · PVR · INOX · Fri, Sat · after 18:00");
});

test("formatSuggestions and daySuggestions preserve comma-separated selections and presets", () => {
  expect(formatSuggestions("px").map((c) => c.value)).toContain("PXL");
  expect(formatSuggestions("PXL, im").map((c) => c.value)).toContain("PXL,IMAX");
  expect(formatSuggestions("PXL,").map((c) => c.value)).not.toContain("PXL,PXL");

  const empty = daySuggestions("");
  expect(empty[0]).toEqual({ name: "Weekend (fri,sat,sun)", value: "fri,sat,sun" });
  expect(empty[1]).toEqual({ name: "Weekdays (mon–fri)", value: "mon,tue,wed,thu,fri" });
  expect(daySuggestions("wknd")).toEqual([{ name: "Weekend (fri,sat,sun)", value: "fri,sat,sun" }]);
  expect(daySuggestions("thur")).toEqual([{ name: "thu", value: "thu" }]);
  expect(daySuggestions("Fri, sa")).toEqual([{ name: "sat", value: "fri,sat" }]);
  expect(daySuggestions("fri,").map((c) => c.value)).not.toContain("fri,fri");
});
