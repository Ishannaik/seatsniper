import { expect, test } from "bun:test";
import {
  FORMAT_CHOICES,
  DAY_CHOICES,
  normaliseFormats,
  normaliseDays,
  dayOfWeek,
  matchesFormat,
  matchesDay,
  filterSummary,
} from "./filters.ts";

test("FORMAT_CHOICES and DAY_CHOICES are defined", () => {
  expect(FORMAT_CHOICES).toContain("IMAX");
  expect(DAY_CHOICES).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
});

test("normaliseFormats cleans whitespace and upper-cases values", () => {
  expect(normaliseFormats("IMAX, 4dx , screenx")).toBe("IMAX,4DX,SCREENX");
  expect(normaliseFormats("  ")).toBeNull();
  expect(normaliseFormats(null)).toBeNull();
});

test("normaliseDays parses valid days and ignores invalid tokens", () => {
  expect(normaliseDays("Fri, SAT ,sun")).toBe("fri,sat,sun");
  expect(normaliseDays("invalid, xyz")).toBeNull();
  expect(normaliseDays(null)).toBeNull();
});

test("dayOfWeek returns correct short day name UTC", () => {
  // 2026-07-30 is Thursday
  expect(dayOfWeek("20260730")).toBe("thu");
  // 2026-07-31 is Friday
  expect(dayOfWeek("20260731")).toBe("fri");
});

test("matchesFormat matches attributes case-insensitively", () => {
  expect(matchesFormat("IMAX 3D", "IMAX")).toBe(true);
  expect(matchesFormat("4DX", "IMAX,4DX")).toBe(true);
  expect(matchesFormat("2D", "IMAX")).toBe(false);
});

test("matchesDay checks if date falls on filter day", () => {
  // 2026-07-31 is Friday
  expect(matchesDay("20260731", "fri,sat")).toBe(true);
  expect(matchesDay("20260731", "mon,tue")).toBe(false);
});

test("filterSummary formats human-readable filter strings", () => {
  expect(filterSummary({ format_filter: "IMAX,4DX", day_filter: "fri,sat,sun" })).toBe("IMAX · 4DX · Fri, Sat, Sun");
  expect(filterSummary({ format_filter: "IMAX", day_filter: null })).toBe("IMAX");
  expect(filterSummary({ format_filter: null, day_filter: null })).toBeNull();
});
