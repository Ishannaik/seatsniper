/** Minutes since midnight for an IST wall-clock time. */
export function parseTimeFilter(value: string): number | null {
  const raw = value.trim().toLowerCase();

  const match24 = raw.match(/^(\d{2}):(\d{2})$/);
  if (match24) {
    const hours = Number(match24[1]);
    const minutes = Number(match24[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  const match12 = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (match12) {
    let hours = Number(match12[1]);
    const minutes = Number(match12[2]);
    const period = match12[3];
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  return null;
}

/** True when a show's IST wall-clock time falls inside the optional window. */
export function matchesTimeFilter(
  epoch: number,
  afterMinutes?: number | null,
  beforeMinutes?: number | null,
): boolean {
  if (afterMinutes == null && beforeMinutes == null) return true;

  const minutes = istMinutes(epoch);

  if (afterMinutes != null && minutes < afterMinutes) return false;
  if (beforeMinutes != null && minutes >= beforeMinutes) return false;
  return true;
}

/** "202607280640" (IST wall clock) -> unix seconds. India is UTC+5:30, no DST. */
export function istToEpoch(showDateTime: string): number {
  const [y, mo, d, h, mi] = [
    +showDateTime.slice(0, 4), +showDateTime.slice(4, 6), +showDateTime.slice(6, 8),
    +showDateTime.slice(8, 10), +showDateTime.slice(10, 12),
  ];
  return Math.floor(Date.UTC(y!, mo! - 1, d!, h!, mi!) / 1000) - 5.5 * 3600;
}


/**
 * "20260730" -> "Thu, 30 Jul".
 *
 * Builds the date in local time and formats it in local time, so the day never
 * shifts across timezones. Assumes a well-formed BMS date code: callers must
 * not pass the empty date a subscription watch carries (see `SUBSCRIPTION`),
 * because `Number("")` is 0 and that formats as a plausible-looking 1899 date
 * rather than failing. Pinned in `bms.test.ts`.
 */
export function prettyDate(yyyymmdd: string): string {
  const d = new Date(
    +yyyymmdd.slice(0, 4),
    +yyyymmdd.slice(4, 6) - 1,
    +yyyymmdd.slice(6, 8),
  );
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

export const IST_OFFSET_MS = 19_800_000;
export function todayIST(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10).replaceAll('-', '');
}
export function istMinutes(epochSeconds: number): number {
  const date = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}
export function isRealDateCode(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const actual = new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T00:00:00Z`);
  return Number.isFinite(actual.getTime()) && actual.toISOString().slice(0,10).replaceAll('-', '') === date;
}
