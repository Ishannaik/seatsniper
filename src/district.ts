/** District movies: public SSR data only. No login, checkout or seat holds. */
import {
  asRecord,
  extractDistrictPoster,
  fetchDistrictHtml,
  isRecord,
  type JsonObject,
  parseDistrictHostUrl,
} from "./district-common.ts";
import type { FormatChip, Show, Target, TicketCategory } from "./movie-model.ts";
import { BmsError } from "./provider-error.ts";
import { epochToIst, isoDate } from "./time-filter.ts";

export function parseDistrictUrl(input: string): Omit<Target, "date"> & { date?: string } {
  const url = parseDistrictHostUrl(
    input,
    "Paste a full District movie URL.",
    "That's not a district.in movie link.",
  );

  const match = url.pathname.match(
    /^\/movies\/([a-z0-9-]+)-movie-tickets-in-([a-z0-9-]+)-(MV\d+)\/?$/i,
  );
  if (!match) {
    throw new BmsError(
      "bad_url",
      "Use a District movie link with a city, e.g. .../movies/ramayana-movie-tickets-in-mumbai-MV176276. " +
        "For events, use the full /events/<event>-buy-tickets link. Dining is not supported.",
    );
  }

  const rawDate = url.searchParams.get("fromdate");
  if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw new BmsError("bad_url", "District fromdate must be YYYY-MM-DD.");
  }

  return {
    provider: "district",
    city: match[2]!.toLowerCase(),
    slug: match[1]!.toLowerCase(),
    eventCode: match[3]!.toUpperCase(),
    ...(rawDate ? { date: rawDate.replaceAll("-", "") } : {}),
  };
}

export function districtUrl(t: Omit<Target, "date"> & { date?: string }, group?: string): string {
  const url = new URL(
    `https://www.district.in/movies/${t.slug}-movie-tickets-in-${t.city}-${t.eventCode}`,
  );
  if (t.date) url.searchParams.set("fromdate", isoDate(t.date));
  if (group) url.searchParams.set("frmtid", group);
  return url.href;
}

function failUnparseable(message: string): never {
  throw new BmsError("unparseable", `District: ${message}`);
}

export type DistrictPage = {
  title: string;
  shows: Show[];
  dates: string[];
  venues: { code: string; name: string }[];
  groups: string[];
  selectedGroup: string;
  upcoming: boolean;
  posterUrl?: string;
};

function parseSessionAreas(areas: unknown): TicketCategory[] {
  if (!Array.isArray(areas)) {
    return failUnparseable("missing ticket category availability");
  }
  return areas.map((area: unknown) => {
    if (
      !isRecord(area) ||
      typeof area.label !== "string" ||
      typeof area.sAvail !== "number" ||
      !Number.isInteger(area.sAvail) ||
      area.sAvail < 0 ||
      typeof area.price !== "number" ||
      !Number.isFinite(area.price) ||
      area.price < 0
    ) {
      return failUnparseable("invalid ticket category availability");
    }
    const totalSeats =
      typeof area.sTotal === "number" && Number.isInteger(area.sTotal) && area.sTotal > 0
        ? area.sTotal
        : undefined;
    return {
      name: area.label,
      available: area.sAvail,
      price: area.price,
      ...(totalSeats !== undefined ? { totalSeats } : {}),
    };
  });
}

function buildSeatLayoutUrl(session: JsonObject, contentId: string): string | undefined {
  if (
    typeof session.mcd !== "string" ||
    !/^[a-z0-9~_-]+$/i.test(session.mcd) ||
    typeof session.encSessionId !== "string" ||
    !/^[a-z0-9~_-]+$/i.test(session.encSessionId) ||
    session.sType !== 0
  ) {
    return undefined;
  }
  const url = new URL(`https://www.district.in/movies/seat-layout/${session.mcd.toLowerCase()}`);
  url.search = new URLSearchParams({
    encsessionid: session.encSessionId,
    freeseating: "false",
    fromsessions: "true",
    type: "MOVIES",
    contentid: contentId,
  }).toString();
  return url.href;
}

function parseCinemaSession(
  cinema: JsonObject,
  venueName: string,
  session: unknown,
  t: Omit<Target, "date"> & { date?: string },
): Show | null {
  if (
    !isRecord(session) ||
    typeof session.showTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(session.showTime) ||
    session.sid == null ||
    typeof session.scrnFmt !== "string" ||
    typeof session.disableClick !== "boolean" ||
    typeof session.avail !== "number"
  ) {
    return failUnparseable("invalid showtime");
  }

  // Measured against ScreeningEvent JSON-LD: raw zone-less timestamps are UTC.
  const epoch = Date.parse(`${session.showTime}Z`) / 1000;
  if (!Number.isFinite(epoch)) return failUnparseable("invalid show timestamp");

  const { dateCode, showTime } = epochToIst(epoch);
  if (session.disableClick || session.avail <= 0 || (t.date && dateCode !== t.date)) {
    return null;
  }

  const ticketCategories = parseSessionAreas(session.areas);
  const bookingUrl = buildSeatLayoutUrl(session, t.eventCode.slice(2));
  return {
    ticketCategories,
    bookingUrl,
    sessionId: `${String(cinema.id)}:${String(session.pid)}:${String(session.sid)}:${String(session.mid)}`,
    availStatus: "AVAILABLE",
    showDateCode: dateCode,
    showTime,
    epoch,
    attributes: session.scrnFmt,
    venueCode: String(cinema.id),
    venueName,
  };
}

function parseSessionEntry(
  entry: unknown,
  t: Omit<Target, "date"> & { date?: string },
  dates: Set<string>,
  venues: Map<string, { code: string; name: string }>,
  shows: Show[],
): void {
  if (
    !isRecord(entry) ||
    !isRecord(entry.data) ||
    !Array.isArray(entry.data.sessionDates) ||
    !isRecord(entry.pageData)
  ) {
    failUnparseable("invalid session container");
  }
  for (const date of entry.data.sessionDates) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      failUnparseable("invalid session date");
    }
    dates.add(date.replaceAll("-", ""));
  }
  for (const key of ["nearbyCinemas", "farCinemas"] as const) {
    const cinemas = entry.pageData[key];
    if (!Array.isArray(cinemas)) failUnparseable(`missing ${key}`);
    for (const cinema of cinemas) {
      const info = isRecord(cinema) ? asRecord(cinema.cinemaInfo) : undefined;
      if (
        !isRecord(cinema) ||
        !Array.isArray(cinema.sessions) ||
        (cinema.extraSessions != null && !Array.isArray(cinema.extraSessions)) ||
        typeof info?.name !== "string" ||
        cinema.id == null
      ) {
        failUnparseable("invalid cinema");
      }
      const code = String(cinema.id);
      if (!venues.has(code)) venues.set(code, { code, name: info.name });
      const extra = Array.isArray(cinema.extraSessions) ? cinema.extraSessions : [];
      for (const session of [...cinema.sessions, ...extra]) {
        const parsed = parseCinemaSession(cinema, info.name, session, t);
        if (parsed) shows.push(parsed);
      }
    }
  }
}

/** Captured SSR schema. Missing or changed data throws; only explicit empty states return []. */
export function parseDistrictPage(
  html: string,
  t: Omit<Target, "date"> & { date?: string },
): DistrictPage {
  const script = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) return failUnparseable("missing page data (blocked response or changed HTML)");

  let json: unknown;
  try {
    json = JSON.parse(script[1]!);
  } catch {
    return failUnparseable("invalid page JSON");
  }

  const pageProps = asRecord(asRecord(json)?.props)?.pageProps;
  const propsRecord = asRecord(pageProps);
  if (propsRecord?.statusCode === 404) throw new BmsError("not_found", "District movie not found.");

  const data = propsRecord?.data;
  const contentKey = isRecord(data) ? String(data.contentId) : "";
  if (!isRecord(data) || contentKey !== t.eventCode.slice(2)) {
    return failUnparseable("movie identity missing or mismatched");
  }
  const state = data.serverState;
  if (!isRecord(state)) return failUnparseable("missing server state");

  // Generic pages are used for films with no bookings yet, even with a city in the URL.
  const meta = asRecord(asRecord(data.movieData)?.meta);
  const upcoming = data.isGeneric === true && meta?.isReleased === false;
  const movie = upcoming ? meta?.movie : asRecord(state.movieContents)?.[contentKey];
  if (!isRecord(movie) || typeof movie.name !== "string" || !movie.name) {
    return failUnparseable("missing movie title");
  }
  const posterUrl = extractDistrictPoster(
    [movie.poster_url, movie.image_url, movie.posterUrl, movie.poster, movie.horizontal_poster],
    html,
  );
  const posterSpread = posterUrl ? { posterUrl } : {};
  if (upcoming) {
    return {
      title: movie.name,
      shows: [],
      dates: [],
      venues: [],
      groups: [],
      selectedGroup: "",
      upcoming: true,
      ...posterSpread,
    };
  }

  if (data.cityError || data.cityName !== t.city) {
    return failUnparseable("city missing or mismatched");
  }
  if (!isRecord(state.movieSessions) || !Array.isArray(movie.languageFormatGroups)) {
    return failUnparseable("missing sessions or language groups");
  }

  const groups = movie.languageFormatGroups.map((group: unknown) => {
    if (
      !isRecord(group) ||
      typeof group.format !== "string" ||
      !/^[a-z0-9~_-]+$/i.test(group.format)
    ) {
      return failUnparseable("invalid language group");
    }
    return group.format.toLowerCase();
  });

  const queryState = asRecord(state.queryState);
  const selectedGroup = queryState?.frmtid;
  if (typeof selectedGroup !== "string" || !groups.includes(selectedGroup.toLowerCase())) {
    return failUnparseable("missing selected language group");
  }

  const entries = Object.values(state.movieSessions);
  const fromDate =
    typeof queryState?.fromdate === "string" ? queryState.fromdate.replaceAll("-", "") : "";
  // Measured: a valid movie and an unavailable requested date have an explicit empty map.
  if (!entries.length && (!t.date || fromDate !== t.date)) {
    return failUnparseable("unexpected empty sessions");
  }

  const shows: Show[] = [];
  const dates = new Set<string>();
  const venues = new Map<string, { code: string; name: string }>();
  for (const entry of entries) {
    parseSessionEntry(entry, t, dates, venues, shows);
  }

  return {
    title: movie.name,
    shows,
    dates: [...dates].sort(),
    venues: [...venues.values()],
    groups,
    selectedGroup: selectedGroup.toLowerCase(),
    upcoming: false,
    ...posterSpread,
  };
}

async function fetchPage(
  t: Omit<Target, "date"> & { date?: string },
  group?: string,
): Promise<DistrictPage> {
  const html = await fetchDistrictHtml(
    districtUrl(t, group),
    "District",
    "District movie not found.",
  );
  const page = parseDistrictPage(html, t);
  if (group && !page.upcoming && page.selectedGroup !== group.toLowerCase()) {
    return failUnparseable("requested language group was not returned");
  }
  return page;
}

/** Check every language group; formats are attached to individual sessions, not BMS child events. */
async function fetchAll(t: Omit<Target, "date"> & { date?: string }): Promise<DistrictPage[]> {
  const first = await fetchPage(t);
  const pages = [first];
  for (const group of first.groups) {
    if (group !== first.selectedGroup) {
      pages.push(await fetchPage(t, group));
    }
  }
  return pages;
}

export async function fetchDistrictShowtimes(
  t: Target,
): Promise<{ title: string; shows: Show[]; chips: FormatChip[]; posterUrl?: string }> {
  const pages = await fetchAll(t);
  const shows = new Map(pages.flatMap((page) => page.shows).map((show) => [show.sessionId, show]));
  const posterUrl = pages.find((page) => page.posterUrl)?.posterUrl;
  return {
    title: pages[0]!.title,
    shows: [...shows.values()],
    chips: [],
    ...(posterUrl ? { posterUrl } : {}),
  };
}

export async function fetchDistrictDates(t: Omit<Target, "date">): Promise<{
  title: string;
  dates: string[];
  venues: { code: string; name: string }[];
  chips: FormatChip[];
  posterUrl?: string;
}> {
  // Do not carry a dated watch's date into the shared movie/date-strip request.
  const pages = await fetchAll({
    city: t.city,
    slug: t.slug,
    eventCode: t.eventCode,
    provider: "district",
  });
  const venues = new Map(pages.flatMap((page) => page.venues).map((v) => [v.code, v] as const));
  const posterUrl = pages.find((page) => page.posterUrl)?.posterUrl;
  return {
    title: pages[0]!.title,
    dates: [...new Set(pages.flatMap((page) => page.dates))].sort(),
    venues: [...venues.values()],
    chips: [],
    ...(posterUrl ? { posterUrl } : {}),
  };
}
