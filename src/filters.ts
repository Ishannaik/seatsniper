/** Known BMS screen formats for autocomplete. */
export const FORMAT_CHOICES = ["PXL", "PXL 3D", "PXL 2D", "IMAX", "IMAX 3D", "IMAX 2D", "4DX", "ScreenX", "3D", "2D", "MX4D", "ICE", "Dolby Atmos", "Dolby Cinema", "RPX", "VIP"];
export const DAY_CHOICES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "IMAX, 4dx , screenx" -> "IMAX,4DX,SCREENX" | null */
export function normaliseFormats(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  return raw.split(",").map((f) => f.trim().toUpperCase()).filter(Boolean).join(",") || null;
}

/** "pvr , INOX,imax wadala" -> "PVR,INOX,IMAX WADALA" | null */
export function normaliseTheatres(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  return raw.split(",").map((t) => t.trim().replace(/\s+/g, " ").toUpperCase()).filter(Boolean).join(",") || null;
}

/** "Fri, SAT ,sun" -> "fri,sat,sun". null when unset, or when any token isn't a weekday. */
export function normaliseDays(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  const days = raw.split(",").map((d) => d.trim().toLowerCase().slice(0, 3)).filter(Boolean);
  if (!days.length || days.some((d) => !DAY_CHOICES.includes(d))) return null;
  return days.join(",");
}

/** YYYYMMDD -> "mon"|"tue"|...|"sun" (UTC, host-TZ-independent). */
export function dayOfWeek(dateCode: string): string {
  const [y, m, d] = [+dateCode.slice(0, 4), +dateCode.slice(4, 6), +dateCode.slice(6, 8)];
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** Does a show's format match the filter? Case-insensitive substring: "IMAX" catches "IMAX 3D", and spaces are ignored so "SCREEN X" matches "SCREENX". */
export function matchesFormat(attributes: string, filter: string): boolean {
  const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const attr = compact(attributes ?? "");
  return filter.split(",").some((f) => {
    const needle = compact(f);
    return needle.length > 0 && attr.includes(needle);
  });
}

/** Does a YYYYMMDD date fall on one of the filtered days? */
export function matchesDay(dateCode: string, filter: string): boolean {
  return filter.split(",").includes(dayOfWeek(dateCode));
}

/**
 * Does a show's venue match the filter? Case-insensitive substring against the
 * venue name *and* the venue code, so "PVR" catches "PVR: Phoenix Palladium"
 * and a user who pasted a code like "IMOB" still matches. Whitespace is
 * collapsed on both sides so "IMAX  Wadala" matches "IMAX Wadala". The two are
 * joined by a NUL, which cannot occur in either, so a needle can never match
 * by straddling the name/code boundary.
 */
export function matchesTheatre(venueName: string, venueCode: string, filter: string): boolean {
  const haystack = `${venueName ?? ""}\u0000${venueCode ?? ""}`.toUpperCase().replace(/\s+/g, " ");
  return filter.split(",").some((t) => {
    const needle = t.trim().replace(/\s+/g, " ");
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** Human-readable filter summary for embeds, e.g. "IMAX · 4DX · Fri, Sat, Sun". */
export function filterSummary(w: {
  format_filter: string | null;
  day_filter: string | null;
  theatre_filter?: string | null;
  after_filter?: string | null;
  before_filter?: string | null;
  seat_count?: number | null;
  seat_budget?: number | null;
}): string | null {
  const parts: string[] = [];
  if (w.seat_count != null) parts.push(`${w.seat_count} seats in one category (adjacency unchecked)`);
  if (w.seat_budget != null) parts.push(`up to ₹${w.seat_budget}/seat before fees`);
  if (w.format_filter) parts.push(w.format_filter.split(",").join(" · "));
  if (w.theatre_filter) parts.push(w.theatre_filter.split(",").join(" · "));
  if (w.day_filter) parts.push(w.day_filter.split(",").map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(", "));
  // One phrase for the window rather than two, so "after 18:00 · before 23:00" reads as
  // the single constraint it is.
  if (w.after_filter && w.before_filter) parts.push(`${w.after_filter}–${w.before_filter}`);
  else if (w.after_filter) parts.push(`after ${w.after_filter}`);
  else if (w.before_filter) parts.push(`before ${w.before_filter}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Preserve existing alternatives while suggesting the last comma-separated format. */
export function formatSuggestions(value: string): {name: string; value: string}[] {
  const parts = value.split(",");
  const query = parts.pop()!.trim().toUpperCase();
  const selected = parts.map(p => p.trim()).filter(Boolean);
  return FORMAT_CHOICES.filter(choice => choice.toUpperCase().includes(query)
    && !selected.some(p => p.toUpperCase() === choice.toUpperCase()))
    .map(choice => ({name: choice, value: [...selected, choice].join(",")}))
    .filter(choice => choice.value.length <= 100).slice(0,25);
}
