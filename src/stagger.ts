/**
 * Inter-watch stagger config.
 *
 * The poll loop sleeps between watches so a cycle never bursts. That is anti-burst
 * insurance against looking automated — not a residential-IP concern, since fingerprint
 * and request shape matter more. Operators on tiny boxes with few watches may want less;
 * multi-user hosts may want more.
 *
 * Lives in its own module so it is testable: index.ts throws on a missing DISCORD_TOKEN
 * at import time, so config parsed there cannot be unit-tested.
 */

export const DEFAULT_STAGGER_MIN_MS = 2000;
export const DEFAULT_STAGGER_MAX_MS = 5000;

export type StaggerBounds = { minMs: number; maxMs: number };

/**
 * Non-negative finite number from env, falling back loudly on anything else.
 *
 * Falling back rather than exiting: a typo in an optional tuning knob should not stop a
 * bot that is otherwise configured, but it must not pass silently either — a bare
 * `Number(process.env.X ?? d)` turns "abc" into NaN and `Bun.sleep(NaN)` is not a stagger.
 */
export function envNonNegative(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    warn(`[config] ${name}="${raw}" is not a non-negative number — falling back to ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * Resolve STAGGER_MS_MIN / STAGGER_MS_MAX, defaulting to today's hardcoded 2000-5000ms.
 *
 * A max below min is raised to min rather than rejected: the operator asked for a fixed
 * delay in a confusing way, and swapping them silently would give a range they never asked for.
 */
export function staggerBounds(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): StaggerBounds {
  const minMs = envNonNegative("STAGGER_MS_MIN", DEFAULT_STAGGER_MIN_MS, env, warn);
  const requestedMax = envNonNegative("STAGGER_MS_MAX", DEFAULT_STAGGER_MAX_MS, env, warn);

  if (requestedMax < minMs) {
    warn(`[config] STAGGER_MS_MAX (${requestedMax}) is below STAGGER_MS_MIN (${minMs}) — using ${minMs} for both`);
    return { minMs, maxMs: minMs };
  }
  return { minMs, maxMs: requestedMax };
}

/** Uniform delay in [minMs, maxMs). Equals the previous `2000 + Math.random() * 3000` at defaults. */
export function staggerDelayMs({ minMs, maxMs }: StaggerBounds, random: () => number = Math.random): number {
  return minMs + random() * (maxMs - minMs);
}
