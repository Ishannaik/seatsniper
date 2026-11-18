/** Public listing contracts shared by providers and watch runtimes. */
import { BmsError } from "./provider-error.ts";

export type TicketCategory = {
  name: string;
  available: number;
  price: number;
  totalSeats?: number;
};

export type Show = {
  bookingUrl?: string;
  ticketCategories?: TicketCategory[];
  sessionId: string;
  availStatus: string;
  showDateCode: string; // YYYYMMDD
  showTime: string; // "06:40 AM" or "13:50"
  attributes: string; // "IMAX", "" if none
  /** Unix seconds. Lets Discord render the time in each reader's own locale. */
  epoch: number;
  venueCode: string;
  venueName: string;
};

export type Target = {
  provider?: "bms" | "district";
  city: string; // "mumbai"
  slug: string; // "the-odyssey"
  eventCode: string; // "ET00480917"
  date: string; // YYYYMMDD
};

export type FormatChip = {
  title: string;
  eventCode: string;
  slug: string; // the child event's URL slug, e.g. "spider-man-brand-new-day-3d-screen-x"
};

const SHORTLINK_RE =
  /^(?:https?:\/\/)?(?:(?:[a-z0-9-]+\.)*(?:bmsurl\.co|onelink\.me)|link\.district\.in)(?:\/|$)/i;

/** Strip `<url>` wrappers and surrounding Share-sheet prose, rejecting opaque shortlinks. */
export function cleanWatchInput(input: string): string {
  const trimmed = input.trim().replace(/^<|>$/g, "").trim();
  const raw = /\s/.test(trimmed)
    ? (trimmed.match(/https?:\/\/[^\s<>]+/i)?.[0] ?? trimmed).replace(/[.,;:!?)]+$/, "")
    : trimmed;
  if (SHORTLINK_RE.test(raw)) {
    throw new BmsError(
      "bad_url",
      "Short share links hide the city and movie code — open the link once in your browser and paste the full URL.",
    );
  }
  return raw;
}

/** Format a city slug ("mumbai", "new-delhi") as human title case ("Mumbai", "New Delhi"). */
export function formatCity(city: string): string {
  return city
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** Distinct non-empty format labels in first-seen order. */
export function collectFormats(shows: readonly Show[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shows) {
    if (s.attributes && !seen.has(s.attributes)) {
      seen.add(s.attributes);
      out.push(s.attributes);
    }
  }
  return out;
}

/** BMS numeric availStatus ("1".."3") only signals tier open/closed, whereas District reports exact seat counts. */
export function hasExactSeatCounts(show: Show): boolean {
  return !/^\d+$/.test(show.availStatus);
}

/** BMS availStatus "1"/"2" = filling fast; District <= 20 seats left across categories. */
export function isShowFillingFast(show: Show): boolean {
  if (!hasExactSeatCounts(show)) {
    return show.availStatus === "1" || show.availStatus === "2";
  }
  if (!show.ticketCategories?.length) return false;
  const total = show.ticketCategories.reduce((sum, c) => sum + c.available, 0);
  return total > 0 && total <= 20;
}

/**
 * The availability test. A date is bookable iff BookMyShow actually rendered shows
 * FOR THAT DATE — not merely that the page loaded and had shows on it.
 */
export function showsOnDate(shows: Show[], date: string): Show[] {
  return shows.filter((s) => s.showDateCode === date);
}
