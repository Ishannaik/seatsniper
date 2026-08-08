import { describe, expect, test } from "bun:test";
import { matchesTimeFilter, parseTimeFilter } from "./time-filter.ts";

function istEpoch(hours: number, minutes: number): number {
  const utc = Date.UTC(2026, 0, 1, hours, minutes);
  return Math.floor((utc - 5.5 * 3600_000) / 1000);
}

describe("parseTimeFilter", () => {
  test("parses 24h times", () => {
    expect(parseTimeFilter("18:00")).toBe(18 * 60);
    expect(parseTimeFilter("00:00")).toBe(0);
    expect(parseTimeFilter("23:59")).toBe(23 * 60 + 59);
  });

  test("parses 12h times", () => {
    expect(parseTimeFilter("6:00 PM")).toBe(18 * 60);
    expect(parseTimeFilter("12:00 AM")).toBe(0);
    expect(parseTimeFilter("12:00 PM")).toBe(12 * 60);
  });

  test("rejects invalid times", () => {
    expect(parseTimeFilter("25:00")).toBeNull();
    expect(parseTimeFilter("12:60")).toBeNull();
    expect(parseTimeFilter("13:00 PM")).toBeNull();
    expect(parseTimeFilter("tomorrow")).toBeNull();
  });
});

describe("matchesTimeFilter", () => {
  test("matches after and before boundaries", () => {
    expect(matchesTimeFilter(istEpoch(18, 0), 18 * 60, null)).toBe(true);
    expect(matchesTimeFilter(istEpoch(17, 59), 18 * 60, null)).toBe(false);
    expect(matchesTimeFilter(istEpoch(11, 59), null, 12 * 60)).toBe(true);
    expect(matchesTimeFilter(istEpoch(12, 0), null, 12 * 60)).toBe(false);
  });

  test("intersects after and before", () => {
    expect(matchesTimeFilter(istEpoch(20, 0), 18 * 60, 22 * 60)).toBe(true);
    expect(matchesTimeFilter(istEpoch(17, 0), 18 * 60, 22 * 60)).toBe(false);
    expect(matchesTimeFilter(istEpoch(23, 0), 18 * 60, 22 * 60)).toBe(false);
  });

  test("no filters always matches", () => {
    expect(matchesTimeFilter(istEpoch(6, 0), null, null)).toBe(true);
  });
});
