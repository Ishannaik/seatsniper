import { BmsError } from "./bms.ts";

/** "2026-07-30" | "20260730" -> "20260730". Throws on anything else. */
export function normaliseDate(input: string): string {
  const d = input.trim().replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(d)) throw new BmsError("bad_url", `Date must look like 2026-07-30, got "${input}"`);
  const [y, m, day] = [+d.slice(0, 4), +d.slice(4, 6), +d.slice(6, 8)];
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, m - 1, day);
  if (
    m < 1 || m > 12 || day < 1 || day > 31 ||
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== m - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new BmsError("bad_url", `"${input}" isn't a real date.`);
  }
  return d;
}
