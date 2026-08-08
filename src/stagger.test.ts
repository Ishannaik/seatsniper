import { expect, test } from "bun:test";
import {
  DEFAULT_STAGGER_MAX_MS,
  DEFAULT_STAGGER_MIN_MS,
  envNonNegative,
  staggerBounds,
  staggerDelayMs,
} from "./stagger.ts";

/** Collect warnings instead of printing them, so a test can assert the loud fallback happened. */
function recorder() {
  const lines: string[] = [];
  return { lines, warn: (message: string) => void lines.push(message) };
}

test("defaults reproduce the previous hardcoded 2000-5000ms stagger", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({}, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
  expect(lines).toEqual([]);
  expect(DEFAULT_STAGGER_MIN_MS).toBe(2000);
  expect(DEFAULT_STAGGER_MAX_MS).toBe(5000);
});

test("the default delay range matches the old 2000 + random * 3000 expression exactly", () => {
  const bounds = staggerBounds({});
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    expect(staggerDelayMs(bounds, () => r)).toBe(2000 + r * 3000);
  }
});

test("both bounds are read from env", () => {
  expect(staggerBounds({ STAGGER_MS_MIN: "500", STAGGER_MS_MAX: "1500" })).toEqual({ minMs: 500, maxMs: 1500 });
});

test("zero stagger is allowed — discouraged in the docs, not refused here", () => {
  const { warn, lines } = recorder();
  const bounds = staggerBounds({ STAGGER_MS_MIN: "0", STAGGER_MS_MAX: "0" }, warn);
  expect(bounds).toEqual({ minMs: 0, maxMs: 0 });
  expect(staggerDelayMs(bounds, () => 0.5)).toBe(0);
  expect(lines).toEqual([]);
});

test("an unparseable value falls back and says so", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MIN: "abc" }, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("STAGGER_MS_MIN");
  expect(lines[0]).toContain("abc");
});

test("a numeric non-finite value falls back and says so", () => {
  // "abc" is NaN, but "Infinity" parses to a real number that is still not a delay.
  // Pinned separately so a guard narrowed to NaN cannot hand Bun.sleep an infinite wait.
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MAX: "Infinity" }, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("STAGGER_MS_MAX");
});

test("a negative value falls back rather than shortening the cycle", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MAX: "-1" }, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("STAGGER_MS_MAX");
});

test("max below min is raised to min, not swapped", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MIN: "4000", STAGGER_MS_MAX: "1000" }, warn)).toEqual({
    minMs: 4000,
    maxMs: 4000,
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("below");
});

test("an empty or whitespace value is treated as unset, not as zero", () => {
  const { warn, lines } = recorder();
  expect(staggerBounds({ STAGGER_MS_MIN: "", STAGGER_MS_MAX: "   " }, warn)).toEqual({ minMs: 2000, maxMs: 5000 });
  expect(lines).toEqual([]);
});

test("envNonNegative accepts a fractional value", () => {
  expect(envNonNegative("X", 1, { X: "2.5" })).toBe(2.5);
});

test("staggerDelayMs stays inside its bounds across many draws", () => {
  const bounds = { minMs: 100, maxMs: 400 };
  for (let i = 0; i < 500; i++) {
    const delay = staggerDelayMs(bounds);
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThan(400);
  }
});
