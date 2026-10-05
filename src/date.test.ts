import { describe, expect, test } from "bun:test";
import { BmsError } from "./bms.ts";
import { normaliseDate } from "./date.ts";

describe("normaliseDate", () => {
  test.each([
    ["2026-07-30", "20260730"],
    [" 2026/07/30 ", "20260730"],
    ["20260730", "20260730"],
    ["2028-02-29", "20280229"],
    ["2000-02-29", "20000229"],
    ["0096-02-29", "00960229"],
    ["2026-04-30", "20260430"],
  ])("normalizes the valid date %s", (input, expected) => {
    expect(normaliseDate(input)).toBe(expected);
  });

  test.each([
    "2026-02-30", "2026-04-31", "2026-02-29", "1900-02-29",
    "2026-06-31", "2026-11-31", "2026-00-01", "2026-13-01",
    "2026-01-00", "2026-01-32",
  ])("rejects the impossible date %s", (input) => {
    expect(() => normaliseDate(input)).toThrow(BmsError);
    expect(() => normaliseDate(input)).toThrow("isn't a real date.");
  });

  test.each(["2026-2-3", "tomorrow", "202607", "202607300", ""])(
    "rejects the invalid format %s", (input) => {
      expect(() => normaliseDate(input)).toThrow(BmsError);
      expect(() => normaliseDate(input)).toThrow("Date must look like");
    },
  );
});
