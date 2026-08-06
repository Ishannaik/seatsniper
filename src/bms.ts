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

// ponytail: default stays pinned to a Safari profile. Operators can opt into
// another valid node-tls-client Safari/Firefox profile via BMS_TLS_PROFILE.
export function resolveTlsProfile(envValue: string | undefined): string {
  return envValue?.trim() || "safari_ios_18_0";
}

const TLS_PROFILE = resolveTlsProfile(process.env.BMS_TLS_PROFILE);

export type Show = {
  sessionId: string;
  availStatus: string;
  showDateCode: string; // YYYYMMDD
  showTime: string; // "06:40 AM"
  attributes: string; // "IMAX", "" if none
  /** Unix seconds. Lets Discord render the time in each reader's own locale. */
  epoch: number;
  venueCode: string;
  venueName: string;
};

/** "202607280640" (IST wall clock) -> unix seconds. India is UTC+5:30, no DST. */
export function istToEpoch(showDateTime: string): number {
  const [y, mo, d, h, mi] = [
    +showDateTime.slice(0, 4), +showDateTime.slice(4, 6), +showDateTime.slice(6, 8),
    +showDateTime.slice(8, 10), +showDateTime.slice(10, 12),
  ];
  return Math.floor(Date.UTC(y!, mo! - 1, d!, h!, mi!) / 1000) - 5.5 * 3600;
}

export type Target = {
  city: string; // "mumbai"
  slug: string; // "the-odyssey"
  eventCode: string; // "ET00480917"
  date: string; // YYYYMMDD
};

/** Anything that is not a confident, parsed answer. Never swallowed into `[]`. */
export class BmsError extends Error {
  constructor(
    readonly kind: "network" | "blocked" | "unparseable" | "bad_url" | "not_found",
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
 * The movie's real name plus every showtime BookMyShow rendered for this page,
 * whatever date those shows belong to.
 *
 * Throws rather than returning empty whenever the page is not recognisably a real
 * BookMyShow movie page — a Cloudflare block is a 200 with a plausible HTML body,
 * and treating that as "no shows" is the bug that silently kills every similar
 * project.
 */
export async function fetchShowtimes(t: Target): Promise<{ title: string; shows: Show[] }> {
  const { title, html } = await fetchPage(t);
  if (!html.includes("showtimesSections")) return { title, shows: [] }; // real page, no shows
  return { title, shows: parseShows(html) };
}

/** Fetch + validate a buytickets page. Every caller goes through this. */
async function fetchPage(t: Target): Promise<{ title: string; html: string }> {
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

  // Distinguish "a real BookMyShow page that happens to list nothing" from "we were
  // blocked / the page reshaped". Both are HTTP 200 with HTML, so size or a missing
  // showtimes key alone cannot tell them apart — a Cloudflare block is ~5.5KB, while
  // a genuine page for a date with no shows is ~118KB.
  //
  // __INITIAL_STATE__ is the app's own hydration payload: present on every real BMS
  // page, absent from every block/challenge page. Identify the page positively first,
  // THEN allow an empty result. This is not a fallback — an unidentified page still
  // throws.
  if (!html.includes("window.__INITIAL_STATE__")) {
    throw new BmsError(
      "blocked",
      `not a BookMyShow app page (${html.length} bytes, no __INITIAL_STATE__) — blocked or reshaped`,
    );
  }
  // A real event always titles its page "<Movie> Movie Showtimes in <City>".
  // A nonexistent event code renders a page with no <title> at all. Verified against
  // ET99999999 (no title) vs ET00000001 (an obscure old film — has a title, zero
  // shows). So "no title" means the code is wrong, which is worth telling the user
  // now rather than letting them wait forever for an alert that cannot come.
  const title = parseMovieTitle(html);
  if (!title) {
    throw new BmsError(
      "not_found",
      `no movie found for ${t.eventCode} in ${t.city} — check the event code`,
    );
  }
  return { title, html };
}

/** "The Odyssey Movie Showtimes in Mumbai &amp; …" -> "The Odyssey" */
export function parseMovieTitle(html: string): string | null {
  const raw = html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (!raw) return null;
  const name = raw.split(/ Movie Showtimes/i)[0]!.trim();
  if (!name || name.length > 120) return null;
  return name
    .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const SESSION_RE =
  /"additionalData":\{"sessionId":"(\d+)","availStatus":"(\d+)",[^}]*?"showDateCode":"(\d{8})","showDateTime":"(\d{12})","showTimeCode":"\d+","showTime":"([^"]+)","attributes":"([^"]*)"/g;

function parseSessionsInSlice(slice: string, venueCode: string, venueName: string): Show[] {
  const out: Show[] = [];
  for (const m of slice.matchAll(SESSION_RE)) {
    out.push({
      sessionId: m[1]!,
      availStatus: m[2]!,
      showDateCode: m[3]!,
      showTime: m[5]!,
      attributes: m[6]!,
      epoch: istToEpoch(m[4]!),
      venueCode,
      venueName,
    });
  }
  return out;
}

/** Exported for tests: the pure half of fetchShows. */
export function parseShows(html: string): Show[] {
  const marker = '"type":"venue-card"';
  const out: Show[] = [];
  let pos = 0;
  let venueCards = 0;

  while (true) {
    const start = html.indexOf(marker, pos);
    if (start === -1) break;
    venueCards++;
    const next = html.indexOf(marker, start + marker.length);
    const slice = next === -1 ? html.slice(start) : html.slice(start, next);
    const venueCode = slice.match(/"venueCode":"([^"]+)"/)?.[1] ?? "";
    const venueName = slice.match(/"venueName":"([^"]+)"/)?.[1] ?? "";
    out.push(...parseSessionsInSlice(slice, venueCode, venueName));
    pos = start + marker.length;
  }

  if (out.length > 0) return out;

  const hasSessions = /"sessionId":"\d+"/.test(html);
  if (html.includes("showtimesSections") && venueCards === 0 && hasSessions) {
    throw new BmsError("unparseable", "showtimes page has sessions but no venue-cards");
  }

  return [];
}

export function parseVenues(html: string): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const s of parseShows(html)) {
    if (!s.venueCode || seen.has(s.venueCode)) continue;
    seen.add(s.venueCode);
    out.push({ code: s.venueCode, name: s.venueName });
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

/**
 * A date BookMyShow will never have shows for. Used as a probe date.
 *
 * Why: the page carries a `dateCode` list of every bookable date — but BMS also
 * injects whatever date you asked for into that list, open or not. Asking for a real
 * date therefore contaminates the answer. Asking for an impossible one makes the
 * injected value identifiable, so it can be removed and the rest trusted.
 *
 * Verified 2026-07-27: probing with this returns exactly the sets found by scanning
 * eight days one request at a time — Odyssey {27,28,29 Jul}, Spider-Man
 * {30,31 Jul, 1,2 Aug}, AoT {28,29 Jul}. One request instead of eight.
 */
export const PROBE_DATE = "20991231";

/** Every date this movie is currently bookable for, in this city. One request.
 *  `venues` is null when venue-cards failed to parse — not the same as []. */
export async function fetchBookableDates(
  t: Omit<Target, "date">,
): Promise<{ title: string; dates: string[]; venues: { code: string; name: string }[] | null }> {
  const { title, html } = await fetchPage({ ...t, date: PROBE_DATE });
  const dates = parseBookableDates(html);
  let venues: { code: string; name: string }[] | null = null;
  try {
    venues = parseVenues(html);
  } catch (e) {
    console.error(`[bms] venue parse failed for ${t.eventCode}/${t.city}:`, (e as Error).message);
  }
  return { title, dates, venues };
}

/**
 * Per-cycle request coalescing.
 *
 * Every watch — dated or subscription — first asks the same question: which dates is
 * this movie bookable for in this city? That answer is keyed only by (city, event),
 * NOT by the watched date, so ten friends watching the same film collapse to one
 * HTTP request no matter which dates they each picked.
 *
 * The map is rebuilt every cycle, so it is a within-tick cache and can never serve a
 * stale answer across polls.
 */
let cycle = new Map<string, Promise<{ title: string; dates: string[]; venues: { code: string; name: string }[] | null }>>();
let cycleHits = 0;

export function beginCycle(): void {
  cycle = new Map();
  cycleHits = 0;
}

/** Requests saved by coalescing during the current cycle. */
export const coalescedCount = () => cycleHits;

export function bookableDatesCached(
  t: Omit<Target, "date">,
): Promise<{ title: string; dates: string[]; venues: { code: string; name: string }[] | null }> {
  const key = `${t.city}|${t.eventCode}`;
  const hit = cycle.get(key);
  if (hit) {
    cycleHits++;
    return hit;
  }
  const p = fetchBookableDates(t);
  cycle.set(key, p);
  return p;
}

/** Exported for tests: the pure half of fetchBookableDates. */
export function parseBookableDates(html: string): string[] {
  const dates = new Set<string>();
  for (const m of html.matchAll(/"dateCode":"(\d{8})"/g)) {
    if (m[1] !== PROBE_DATE) dates.add(m[1]!);
  }
  return [...dates].sort();
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
