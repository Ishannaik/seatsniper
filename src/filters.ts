/** Known BMS screen formats for autocomplete. */
export const FORMAT_CHOICES = ["IMAX", "IMAX 3D", "4DX", "ScreenX", "3D", "2D", "MX4D", "ICE", "Dolby Atmos", "Dolby Cinema", "RPX", "VIP"];
export const DAY_CHOICES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "IMAX, 4dx , screenx" -> "IMAX,4DX,SCREENX" | null */
export function normaliseFormats(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  return raw.split(",").map((f) => f.trim().toUpperCase()).filter(Boolean).join(",") || null;
}

/** "Fri, SAT ,sun" -> "fri,sat,sun" | null */
export function normaliseDays(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const days = raw.split(",").map((d) => d.trim().toLowerCase().slice(0, 3)).filter((d) => DAY_CHOICES.includes(d));
  return days.length ? days.join(",") : null;
}

/** YYYYMMDD -> "mon"|"tue"|...|"sun" (UTC, host-TZ-independent). */
export function dayOfWeek(dateCode: string): string {
  const [y, m, d] = [+dateCode.slice(0, 4), +dateCode.slice(4, 6), +dateCode.slice(6, 8)];
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** Does a show's format match the filter? Case-insensitive substring: "IMAX" catches "IMAX 3D", and spaces are ignored so "SCREEN X" matches "SCREENX". */
export function matchesFormat(attributes: string, filter: string): boolean {
  const attr = (attributes ?? "").toUpperCase().replace(/\s+/g, "");
  return filter.split(",").some((f) => attr.includes(f.replace(/\s+/g, "")));
}

/** Does a YYYYMMDD date fall on one of the filtered days? */
export function matchesDay(dateCode: string, filter: string): boolean {
  return filter.split(",").includes(dayOfWeek(dateCode));
}

/** Human-readable filter summary for embeds, e.g. "IMAX · 4DX · Fri, Sat, Sun". */
export function filterSummary(w: { format_filter: string | null; day_filter: string | null }): string | null {
  const parts: string[] = [];
  if (w.format_filter) parts.push(w.format_filter.split(",").join(" · "));
  if (w.day_filter) parts.push(w.day_filter.split(",").map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(", "));
  return parts.length ? parts.join(" · ") : null;
}
