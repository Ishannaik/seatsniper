import { expect, test } from "bun:test";
import { normaliseFormats, matchesFormat } from "./filters.ts";

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
