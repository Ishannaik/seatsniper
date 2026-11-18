import { expect, test } from "bun:test";
import {
  DEFAULT_STAGGER_MAX_MS,
  DEFAULT_STAGGER_MIN_MS,
  staggerBounds,
  staggerDelayMs,
} from "./stagger.ts";

function recorder() {
  const lines: string[] = [];
  return { lines, warn: (message: string) => void lines.push(message) };
}

test("staggerBounds defaults to 2000–5000ms and treats blank env values as unset", () => {
  const { warn, lines } = recorder();
  expect(DEFAULT_STAGGER_MIN_MS).toBe(2000);
  expect(DEFAULT_STAGGER_MAX_MS).toBe(5000);
  expect(staggerBounds({}, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
  expect(staggerBounds({ STAGGER_MS_MIN: "", STAGGER_MS_MAX: "   " }, warn)).toEqual({
    minMs: 2000,
    maxMs: 5000,
  });
  expect(lines).toEqual([]);
});

test("staggerBounds reads integer, fractional, and zero bounds from env", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MIN: "500", STAGGER_MS_MAX: "1500" }, warn)).toEqual({
    minMs: 500,
    maxMs: 1500,
  });
  expect(staggerBounds({ STAGGER_MS_MIN: "2.5", STAGGER_MS_MAX: "5.5" }, warn)).toEqual({
    minMs: 2.5,
    maxMs: 5.5,
  });
  expect(staggerBounds({ STAGGER_MS_MIN: "0", STAGGER_MS_MAX: "0" }, warn)).toEqual({
    minMs: 0,
    maxMs: 0,
  });
  expect(lines).toEqual([]);
});

test("unparseable, non-finite, and negative env values fall back with a warning", () => {
  for (const [env, key] of [
    [{ STAGGER_MS_MIN: "abc" }, "STAGGER_MS_MIN"],
    [{ STAGGER_MS_MAX: "Infinity" }, "STAGGER_MS_MAX"],
    [{ STAGGER_MS_MAX: "-1" }, "STAGGER_MS_MAX"],
  ] as const) {
    const { warn, lines } = recorder();
    expect(staggerBounds(env, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(key);
  }
});

test("max below min is raised to min rather than swapped", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MIN: "4000", STAGGER_MS_MAX: "1000" }, warn)).toEqual({
    minMs: 4000,
    maxMs: 4000,
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("below");
});

test("staggerDelayMs honours half-open [minMs, maxMs) boundaries", () => {
  const bounds = { minMs: 2000, maxMs: 5000 };
  expect(staggerDelayMs(bounds, () => 0)).toBe(2000);
  expect(staggerDelayMs(bounds, () => 0.5)).toBe(3500);
  expect(staggerDelayMs(bounds, () => 0.999999)).toBeLessThan(5000);
  expect(staggerDelayMs({ minMs: 0, maxMs: 0 }, () => 0.5)).toBe(0);
});

test("staggerDelayMs returns exactly minMs when random() is 0", () => {
  expect(staggerDelayMs({ minMs: 2000, maxMs: 5000 }, () => 0)).toBe(2000);
});

test("staggerDelayMs stays strictly below maxMs at the top of random()'s [0, 1) range", () => {
  expect(staggerDelayMs({ minMs: 2000, maxMs: 5000 }, () => 0.999999)).toBeLessThan(5000);
});
