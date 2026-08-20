import { expect, test } from "bun:test";
import { normaliseFormats, matchesFormat, filterSummary } from "./filters.ts";

test("normaliseFormats uppercases and trims every variant", () => {
  expect(normaliseFormats("ScreenX")).toBe("SCREENX");
  expect(normaliseFormats(" SCREEN X ")).toBe("SCREEN X");
  expect(normaliseFormats("IMAX, 4dx , screenx")).toBe("IMAX,4DX,SCREENX");
});

test("matchesFormat catches ScreenX spelling variants", () => {
  expect(matchesFormat("SCREENX", "SCREENX")).toBe(true);
  expect(matchesFormat("SCREEN X", "SCREENX")).toBe(true);
  expect(matchesFormat("SCREENX", "SCREEN X")).toBe(true);
  expect(matchesFormat("IMAX", "SCREENX")).toBe(false);
});

test("normaliseFormats returns null for empty input", () => {
  expect(normaliseFormats("")).toBeNull();
  expect(normaliseFormats("  ")).toBeNull();
  expect(normaliseFormats(null)).toBeNull();
});

// --- filterSummary, including the time-of-day window (issue #22) ---

const NO_FILTERS = { format_filter: null, day_filter: null, after_filter: null, before_filter: null };

test("filterSummary is null when nothing is filtered", () => {
  expect(filterSummary(NO_FILTERS)).toBeNull();
});

test("filterSummary renders an open-ended after window", () => {
  expect(filterSummary({ ...NO_FILTERS, after_filter: "18:00" })).toBe("after 18:00");
});

test("filterSummary renders an open-ended before window", () => {
  expect(filterSummary({ ...NO_FILTERS, before_filter: "12:00" })).toBe("before 12:00");
});

test("filterSummary renders a bounded window as one phrase", () => {
  // "18:00-23:00" rather than "after 18:00 . before 23:00": it is one constraint.
  expect(filterSummary({ ...NO_FILTERS, after_filter: "18:00", before_filter: "23:00" })).toBe("18:00–23:00");
});

test("filterSummary keeps format and day parts alongside the window", () => {
  expect(
    filterSummary({ format_filter: "IMAX", day_filter: "fri,sat", after_filter: "18:00", before_filter: null }),
  ).toBe("IMAX · Fri, Sat · after 18:00");
});

test("filterSummary still works for callers that omit the time fields", () => {
  // The two new keys are optional, so pre-existing call sites keep compiling.
  expect(filterSummary({ format_filter: "IMAX", day_filter: null })).toBe("IMAX");
});
