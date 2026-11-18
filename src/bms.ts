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
import {
  cleanWatchInput,
  type FormatChip,
  type Show,
  type Target,
  type TicketCategory,
} from "./movie-model.ts";
import { BmsError } from "./provider-error.ts";
import { istToEpoch } from "./time-filter.ts";

// Only Safari/Firefox profiles are supported overrides; Chrome profiles are served
// challenges by BookMyShow, so never make one the default or document one as an option.
// Re-measured 2026-11-17 from Oracle VPS with tls-client lib v1.18.1: safari_ios_18_0
// started getting 403; safari_ios_17_0 gets 200 with a real page, 4/4 runs.
export const DEFAULT_TLS_PROFILE = "safari_ios_17_0";

export function resolveTlsProfile(env: Record<string, string | undefined> = process.env): string {
  return env.BMS_TLS_PROFILE?.trim() || DEFAULT_TLS_PROFILE;
}

const SUPPORTED_TLS_FAMILIES = ["safari", "firefox"] as const;

/**
 * Map a profile name onto node-tls-client's identifier, failing loudly so a typo
 * in BMS_TLS_PROFILE or a Chrome profile stops startup rather than polling challenged pages.
 */
export function resolveClientIdentifier(
  profile: string = resolveTlsProfile(),
): tls.ClientIdentifier {
  const name = profile.trim();
  const lookup = tls.ClientIdentifier as Record<string, tls.ClientIdentifier | undefined>;
  const id = lookup[name];
  const supported = SUPPORTED_TLS_FAMILIES.some((family) => name.startsWith(family));

  if (!supported) {
    throw new BmsError(
      "unparseable",
      `unsupported TLS profile "${profile}" — BookMyShow serves challenges to anything ` +
        `but Safari and Firefox fingerprints. Set BMS_TLS_PROFILE to a ${SUPPORTED_TLS_FAMILIES.join(
          "/",
        )} ClientIdentifier key such as ${DEFAULT_TLS_PROFILE}, or unset it to use the default`,
    );
  }
  if (!id) {
    throw new BmsError(
      "unparseable",
      `unknown TLS profile "${profile}" — set BMS_TLS_PROFILE to a node-tls-client ` +
        `ClientIdentifier key such as ${DEFAULT_TLS_PROFILE}, or unset it to use the default`,
    );
  }
  return id;
}

/** Rotate the native TLS session once every 24h at cycle boundary to bound cookie-jar growth. */
export const SESSION_MAX_AGE_MS = 86_400_000;

let session: tls.Session | null = null;
let sessionClientId: tls.ClientIdentifier | null = null;
let sessionOpenedAt = 0;

export async function initBms(): Promise<void> {
  const id = resolveClientIdentifier();
  await tls.initTLS();
  sessionClientId = id;
  session = new tls.Session({ clientIdentifier: id, timeout: 30_000 });
  sessionOpenedAt = Date.now();
}

export async function closeBms(): Promise<void> {
  await session?.close().catch(() => {});
  session = null;
  sessionClientId = null;
  sessionOpenedAt = 0;
  if (typeof tls.destroyTLS === "function") {
    await tls.destroyTLS().catch(() => {});
  }
}

export function rotateSessionIfStale(now = Date.now()): boolean {
  if (!session || !sessionClientId || now - sessionOpenedAt <= SESSION_MAX_AGE_MS) {
    return false;
  }
  const stale = session;
  session = new tls.Session({ clientIdentifier: sessionClientId, timeout: 30_000 });
  sessionOpenedAt = now;
  void stale.close().catch(() => {});
  return true;
}

const RESERVED_BMS_SEGMENTS = new Set(
  "explore buytickets movies events plays sports activities stream cinemas".split(" "),
);

function parseBmsCityAndSlug(
  pathname: string,
): { city: string; slug: string; date?: string } | null {
  const moviesFirst = pathname.match(
    /^\/movies\/([a-z][a-z-]*)\/([a-z0-9-]+)\/(?:buytickets\/)?ET\d{6,}(?:\/(\d{8}))?\/?$/i,
  );
  if (moviesFirst && !RESERVED_BMS_SEGMENTS.has(moviesFirst[1]!.toLowerCase())) {
    const slug = moviesFirst[2]!.toLowerCase();
    return {
      city: moviesFirst[1]!.toLowerCase(),
      slug: slug === "buytickets" ? "movie" : slug,
      ...(moviesFirst[3] ? { date: moviesFirst[3] } : {}),
    };
  }
  const cityFirst = pathname.match(
    /^\/([a-z][a-z-]*)\/movies\/([a-z0-9-]+)\/(?:buytickets\/)?ET\d{6,}(?:\/(\d{8}))?\/?$/i,
  );
  if (cityFirst && !RESERVED_BMS_SEGMENTS.has(cityFirst[1]!.toLowerCase())) {
    return {
      city: cityFirst[1]!.toLowerCase(),
      slug: cityFirst[2]!.toLowerCase(),
      ...(cityFirst[3] ? { date: cityFirst[3] } : {}),
    };
  }
  return null;
}

/**
 * Pull city/event code (and date, if present) out of a pasted BookMyShow link.
 *
 * Measured 2026-07-27 against ET00480917: the slug is ignored by BookMyShow (ET code
 * is authoritative), while city changes which theatres are returned — so a missing
 * city is a hard error rather than defaulted.
 */
export function parseWatchUrl(input: string): Omit<Target, "date"> & { date?: string } {
  const raw = cleanWatchInput(input);

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

  const withoutHost = raw
    .split(/[?#]/)[0]!
    .replace(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*bookmyshow\.com/i, "");
  const parsed = parseBmsCityAndSlug(withoutHost);
  if (!parsed) {
    throw new BmsError(
      "bad_url",
      "Couldn't tell which city that link is for, and I won't guess — show timings " +
        "differ per city. Use a link that looks like " +
        "`.../movies/mumbai/<movie>/buytickets/ET…` or `.../mumbai/movies/<movie>/ET…`.",
    );
  }

  return {
    city: parsed.city,
    slug: parsed.slug,
    eventCode: et,
    date: parsed.date,
  };
}

export function showtimesUrl(t: Target): string {
  return `https://in.bookmyshow.com/movies/${t.city}/${t.slug}/buytickets/${t.eventCode}/${t.date}`;
}

export async function fetchShowtimes(
  t: Target,
): Promise<{ title: string; shows: Show[]; chips: FormatChip[]; posterUrl?: string }> {
  const { title, html, posterUrl } = await fetchPage(t);
  const chips = parseFormatChips(html, t.eventCode);
  const posterSpread = posterUrl ? { posterUrl } : {};
  if (!html.includes("showtimesSections")) {
    return { title, shows: [], chips, ...posterSpread };
  }
  return { title, shows: parseShows(html), chips, ...posterSpread };
}

async function fetchPage(t: Target): Promise<{ title: string; html: string; posterUrl?: string }> {
  if (!session) throw new BmsError("unparseable", "initBms() was not called");

  let res: tls.Response;
  try {
    res = await session.get(showtimesUrl(t));
  } catch (e) {
    throw new BmsError("network", `request failed: ${(e as Error).message}`);
  }
  const html = await res.text();

  if (res.status !== 200) {
    throw new BmsError("blocked", `HTTP ${res.status} (${html.length} bytes)`);
  }

  // Cloudflare blocks can return HTTP 200 HTML; window.__INITIAL_STATE__ is present
  // on every real BMS app page and absent on every block/challenge page.
  if (!html.includes("window.__INITIAL_STATE__")) {
    throw new BmsError(
      "blocked",
      `not a BookMyShow app page (${html.length} bytes, no __INITIAL_STATE__) — blocked or reshaped`,
    );
  }
  // A nonexistent event code (e.g. ET99999999) renders no <title>, whereas a valid
  // film with zero shows still renders "<Movie> Movie Showtimes in <City>".
  const title = parseMovieTitle(html);
  if (!title) {
    throw new BmsError(
      "not_found",
      `no movie found for ${t.eventCode} in ${t.city} — check the event code`,
    );
  }
  const posterUrl = parseMoviePoster(html);
  return { title, html, ...(posterUrl ? { posterUrl } : {}) };
}

/** Extract a verified BookMyShow movie poster (`iedb/movies/images/`), never generic logos. */
export function parseMoviePoster(html: string): string | undefined {
  const match =
    html.match(
      /<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["'](https:\/\/[^"']*bmscdn\.com\/iedb\/movies\/images\/[^"']+)["']/i,
    ) ??
    html.match(
      /<meta\b[^>]*\bcontent=["'](https:\/\/[^"']*bmscdn\.com\/iedb\/movies\/images\/[^"']+)["'][^>]*\bproperty=["']og:image["']/i,
    );
  return match?.[1];
}

/** "The Odyssey Movie Showtimes in Mumbai &amp; …" -> "The Odyssey" */
export function parseMovieTitle(html: string): string | null {
  const raw = html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (!raw) return null;
  const name = raw.split(/ Movie Showtimes/i)[0]!.trim();
  if (!name || name.length > 120) return null;
  return name
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const SESSION_RE =
  /"additionalData":\{"sessionId":"(\d+)","availStatus":"(\d+)",[^}]*?"showDateCode":"(\d{8})","showDateTime":"(\d{12})","showTimeCode":"\d+","showTime":"([^"]+)"(?:,"attributes":"([^"]*)")?/g;

function parseBmsCategories(tail: string): TicketCategory[] | undefined {
  const out: TicketCategory[] = [];
  const block = tail.match(/"categories":\[((?:\{[^}]*\}|\s|,)*)\]/);
  if (block) {
    for (const obj of block[1]!.matchAll(/\{([^}]*)\}/g)) {
      const raw = obj[1]!;
      const name = raw.match(/"(?:priceDesc|categoryName|desc)":"([^"]+)"/)?.[1]?.trim() ?? "";
      const priceStr = raw.match(/"(?:curPrice|maxPrice|price)":"?(\d+(?:\.\d+)?)"?/)?.[1];
      const status = raw.match(/"availStatus":"(\d+)"/)?.[1] ?? "3";
      const price = priceStr !== undefined ? Number(priceStr) : Number.NaN;
      if (!name || !Number.isFinite(price) || price <= 0) continue;
      out.push({ name, price, available: status === "0" ? 0 : 1 });
    }
    if (out.length) return out;
  }

  // Current BMS showtime bottomSheetData widgets embed per-tier prices as seatAvalibility/seatCost/seatType.
  for (const m of tail.matchAll(
    /"seatAvalibility":"([^"]+)","seatCost":"[^"]*?(\d+(?:\.\d+)?)","seatType":"([^"]+)"/g,
  )) {
    const avail = m[1]!.trim().toUpperCase();
    const price = Number(m[2]);
    const name = m[3]!.trim();
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    if (!out.some((c) => c.name === name && c.price === price)) {
      out.push({ name, price, available: avail === "SOLD OUT" ? 0 : 1 });
    }
  }
  return out.length ? out : undefined;
}

function parseSessionsInSlice(slice: string, venueCode: string, venueName: string): Show[] {
  const out: Show[] = [];
  const matches = [...slice.matchAll(SESSION_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const availStatus = m[2]!;
    // BMS availStatus "0" is Sold Out; skip so sold-out sessions never trigger live alerts.
    if (availStatus === "0") continue;
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : slice.length;
    const ticketCategories = parseBmsCategories(slice.slice(start, end));
    out.push({
      ...(ticketCategories ? { ticketCategories } : {}),
      sessionId: m[1]!,
      availStatus,
      showDateCode: m[3]!,
      showTime: m[5]!,
      attributes: m[6] ?? "",
      epoch: istToEpoch(m[4]!),
      venueCode,
      venueName,
    });
  }
  return out;
}

function venueCardSlices(html: string): { slice: string; code: string; name: string }[] {
  const marker = '"type":"venue-card"';
  const cards: { slice: string; code: string; name: string }[] = [];
  let pos = 0;
  while (true) {
    const start = html.indexOf(marker, pos);
    if (start === -1) break;
    const next = html.indexOf(marker, start + marker.length);
    const slice = next === -1 ? html.slice(start) : html.slice(start, next);
    cards.push({
      slice,
      code: slice.match(/"venueCode":"([^"]+)"/)?.[1] ?? "",
      name: slice.match(/"venueName":"([^"]+)"/)?.[1] ?? "",
    });
    pos = start + marker.length;
  }
  return cards;
}

export function parseShows(html: string): Show[] {
  const cards = venueCardSlices(html);
  const out: Show[] = [];
  for (const card of cards) {
    out.push(...parseSessionsInSlice(card.slice, card.code, card.name));
  }
  if (out.length > 0) return out;
  if (html.includes("showtimesSections") && cards.length === 0 && /"sessionId":"\d+"/.test(html)) {
    throw new BmsError("unparseable", "showtimes page has sessions but no venue-cards");
  }
  return [];
}

export function parseVenues(html: string): { code: string; name: string }[] {
  const cards = venueCardSlices(html);
  if (cards.length === 0 && html.includes("showtimesSections") && /"sessionId":"\d+"/.test(html)) {
    throw new BmsError("unparseable", "showtimes page has sessions but no venue-cards");
  }
  const out: { code: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (!card.code || seen.has(card.code) || !SESSION_RE.test(card.slice)) {
      SESSION_RE.lastIndex = 0;
      continue;
    }
    SESSION_RE.lastIndex = 0;
    seen.add(card.code);
    out.push({ code: card.code, name: card.name });
  }
  return out;
}

/**
 * Parse format-selector chips off a buytickets page ("3D SCREEN X", "IMAX 3D", …).
 * When `eventCode` is provided and BMS stamps `language` on that parent chip, restrict
 * returned chips to the same language so dubs (Hindi/Tamil/Telugu) do not cross-fire.
 */
export function parseFormatChips(html: string, eventCode?: string): FormatChip[] {
  const rawChips: (FormatChip & { language?: string })[] = [];
  const re =
    /\{"type":"chip","title":"([^"]+)","cta":\{"type":"formatSelector","analytics":\{[^}]*"event_code":"(ET\d{6,})"[^}]*\},"additionalData":\{([^}]*)\}/g;
  for (const m of html.matchAll(re)) {
    const title = m[1]!;
    const code = m[2]!;
    const addl = m[3]!;
    const slug = addl.match(/"eventUrl":"([^"]+)"/)?.[1];
    if (!slug) continue;
    const language = addl.match(/"language":"([^"]+)"/)?.[1];
    if (!rawChips.some((c) => c.title === title && c.eventCode === code)) {
      rawChips.push({ title, eventCode: code, slug, ...(language ? { language } : {}) });
    }
  }
  const targetLang = eventCode
    ? rawChips.find((c) => c.eventCode === eventCode)?.language
    : undefined;
  return rawChips
    .filter((c) => !targetLang || !c.language || c.language === targetLang)
    .map(({ title, eventCode: code, slug }) => ({ title, eventCode: code, slug }));
}

/**
 * Impossible probe date: BMS injects whatever date was requested into the page's
 * `dateCode` list even if closed, so probing `20991231` lets us strip the echo
 * and read every genuinely open date in a single request.
 */
export const PROBE_DATE = "20991231";

/** `venues` is null when venue-cards failed to parse — distinct from `[]`. */
export async function fetchBookableDates(t: Omit<Target, "date">): Promise<{
  title: string;
  dates: string[];
  venues: { code: string; name: string }[] | null;
  chips: FormatChip[];
  posterUrl?: string;
}> {
  const { title, html, posterUrl } = await fetchPage({ ...t, date: PROBE_DATE });
  // Inactive sibling format chips can echo the shared movie date strip even when
  // that child ET has zero shows on the page; require showtimesSections to trust dates.
  const dates = html.includes("showtimesSections") ? parseBookableDates(html) : [];
  let venues: { code: string; name: string }[] | null = null;
  try {
    venues = parseVenues(html);
  } catch (e) {
    console.error(`[bms] venue parse failed for ${t.eventCode}/${t.city}:`, (e as Error).message);
  }
  const chips = parseFormatChips(html, t.eventCode);
  return { title, dates, venues, chips, ...(posterUrl ? { posterUrl } : {}) };
}

/**
 * When the probe date is closed on a coming-soon page, BMS falls back to TODAY
 * as `additionalData.dateCode` (`"date-disabled"`, zero shows). Trust that
 * page-default date only when a show on the page carries matching `showDateCode`.
 */
export function parseBookableDates(html: string): string[] {
  const pageDefault = html.match(/"additionalData":\{"dateCode":"(\d{8})","eventCode":/)?.[1];
  const dates = new Set<string>();
  for (const m of html.matchAll(/"dateCode":"(\d{8})"/g)) {
    if (m[1] !== PROBE_DATE) dates.add(m[1]!);
  }
  if (pageDefault && !html.includes(`"showDateCode":"${pageDefault}"`)) dates.delete(pageDefault);
  return [...dates].sort();
}
