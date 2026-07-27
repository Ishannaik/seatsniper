/**
 * BookMyShow provider.
 *
 * Two things here are load-bearing and were established by measurement
 * (docs/superpowers/specs/2026-07-27-bms-access-findings.md):
 *
 * 1. TLS fingerprint, not IP, is what Cloudflare blocks. A Safari profile gets 200
 *    from a datacenter IP. NEVER switch this to Chrome — chrome/chrome131 are served
 *    challenges. NEVER add custom headers — the library's profile ships a coherent
 *    set, and adding to it recreates the mismatch that causes 403s.
 *
 * 2. BookMyShow silently serves the NEAREST BOOKABLE DATE when the requested one is
 *    not open. URL, HTTP status and currentDateCode all echo what you asked for.
 *    Only showDateCode inside each show reveals the substitution. So availability is
 *    a field comparison, never a keyword or frequency heuristic.
 */
import * as tls from "node-tls-client";

// ponytail: pinned profile, but kept as a named const so rotating it when
// Cloudflare's scoring shifts is a one-line change rather than a hunt.
const TLS_PROFILE = "safari_ios_18_0";

export type Show = {
  sessionId: string;
  availStatus: string;
  showDateCode: string; // YYYYMMDD
  showTime: string; // "06:40 AM"
  attributes: string; // "IMAX", "" if none
};

export type Target = {
  city: string; // "mumbai"
  slug: string; // "the-odyssey"
  eventCode: string; // "ET00480917"
  date: string; // YYYYMMDD
};

/** Anything that is not a confident, parsed answer. Never swallowed into `[]`. */
export class BmsError extends Error {
  constructor(
    readonly kind: "network" | "blocked" | "unparseable" | "bad_url",
    message: string,
  ) {
    super(message);
    this.name = "BmsError";
  }
}

let session: any = null;

export async function initBms(): Promise<void> {
  const { Session, ClientIdentifier, initTLS } = tls as any;
  await initTLS();
  const id = ClientIdentifier[TLS_PROFILE];
  if (!id) throw new BmsError("unparseable", `unknown TLS profile ${TLS_PROFILE}`);
  session = new Session({ clientIdentifier: id, timeout: 30_000 });
}

export async function closeBms(): Promise<void> {
  await session?.close().catch(() => {});
  session = null;
}

/**
 * Pull city/event code (and date, if present) out of a pasted BookMyShow link.
 *
 * Measured 2026-07-27 against ET00480917: the **slug is ignored** by BookMyShow —
 * a deliberately wrong slug returns byte-for-byte equivalent results, because the ET
 * code is authoritative. The **city is not**: the same event on the same date returns
 * 51 shows for mumbai, 25 for delhi, 10 for pune. So a missing slug is harmless and a
 * missing city is a hard error — defaulting it would silently watch another city's
 * theatres.
 */
export function parseWatchUrl(input: string): Omit<Target, "date"> & { date?: string } {
  // Discord users paste <url> to suppress the link preview; strip that and any
  // surrounding whitespace or trailing punctuation before matching.
  const raw = input.trim().replace(/^<|>$/g, "").trim();

  if (!/^(https?:\/\/)?([a-z0-9-]+\.)*bookmyshow\.com\//i.test(raw)) {
    throw new BmsError(
      "bad_url",
      "That's not a bookmyshow.com link. Paste the URL from the movie's page.",
    );
  }

  const et = raw.match(/\b(ET\d{6,})\b/i)?.[1]?.toUpperCase();
  if (!et) {
    throw new BmsError(
      "bad_url",
      "No BookMyShow event code in that link. Open the movie on BookMyShow and copy " +
        "the URL from its page — it contains something like ET00480917.",
    );
  }

  // Ignore query string and fragment so ?utm_source=… and #anchor can't be mistaken
  // for path segments.
  const path = raw.split(/[?#]/)[0]!;

  const city = path.match(/\/movies\/([a-z][a-z-]*)\//i)?.[1]?.toLowerCase();
  if (!city) {
    throw new BmsError(
      "bad_url",
      "Couldn't tell which city that link is for, and I won't guess — show timings " +
        "differ per city. Use a link that looks like " +
        "`.../movies/mumbai/<movie>/buytickets/ET…`.",
    );
  }

  return {
    city,
    // Verified ignored by BookMyShow; kept only because the path shape expects a
    // segment there. Do not add a lookup to "correct" it.
    slug: path.match(/\/movies\/[a-z][a-z-]*\/([a-z0-9-]+)\//i)?.[1]?.toLowerCase() ?? "movie",
    eventCode: et,
    date: path.match(/\/(\d{8})\/?$/)?.[1],
  };
}

export function showtimesUrl(t: Target): string {
  return `https://in.bookmyshow.com/movies/${t.city}/${t.slug}/buytickets/${t.eventCode}/${t.date}`;
}

/**
 * Every showtime BookMyShow rendered for this page, whatever date they belong to.
 * Throws rather than returning [] whenever the page is not recognisably a
 * showtimes page — a Cloudflare block is a 200 with a plausible HTML body, and
 * treating that as "no shows" is the bug that silently kills every similar project.
 */
export async function fetchShows(t: Target): Promise<Show[]> {
  if (!session) throw new BmsError("unparseable", "initBms() was not called");

  let res: any;
  try {
    res = await session.get(showtimesUrl(t));
  } catch (e) {
    throw new BmsError("network", `request failed: ${(e as Error).message}`);
  }
  const html: string = await res.text();

  if (res.status !== 200) {
    throw new BmsError("blocked", `HTTP ${res.status} (${html.length} bytes)`);
  }
  if (!html.includes("showtimesSections")) {
    throw new BmsError(
      "blocked",
      `no showtimesSections in ${html.length} bytes — blocked or page reshaped`,
    );
  }
  return parseShows(html);
}

/** Exported for tests: the pure half of fetchShows. */
export function parseShows(html: string): Show[] {
  const re =
    /"additionalData":\{"sessionId":"(\d+)","availStatus":"(\d+)",[^}]*?"showDateCode":"(\d{8})","showDateTime":"\d+","showTimeCode":"\d+","showTime":"([^"]+)","attributes":"([^"]*)"/g;
  const out: Show[] = [];
  for (const m of html.matchAll(re)) {
    out.push({
      sessionId: m[1]!,
      availStatus: m[2]!,
      showDateCode: m[3]!,
      showTime: m[4]!,
      attributes: m[5]!,
    });
  }
  return out;
}

/**
 * The availability test. A date is bookable iff BookMyShow actually rendered shows
 * FOR THAT DATE — not merely that the page loaded and had shows on it.
 */
export function showsOnDate(shows: Show[], date: string): Show[] {
  return shows.filter((s) => s.showDateCode === date);
}

/** "20260730" -> "Thu 30 Jul" */
export function prettyDate(yyyymmdd: string): string {
  const d = new Date(
    +yyyymmdd.slice(0, 4),
    +yyyymmdd.slice(4, 6) - 1,
    +yyyymmdd.slice(6, 8),
  );
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}
