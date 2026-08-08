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

  const istDate = new Date(epoch * 1000 + 5.5 * 3600_000);
  const minutes = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();

  if (afterMinutes != null && minutes < afterMinutes) return false;
  if (beforeMinutes != null && minutes >= beforeMinutes) return false;
  return true;
}
