/** District movies: public SSR data only. No login, checkout or seat holds. */
import type { Show, Target } from "./movie-model.ts";
import { BmsError } from "./provider-error.ts";

export function parseDistrictUrl(input: string): Omit<Target, "date"> & { date?: string } {
  let url: URL;
  try { url = new URL(input.trim().replace(/^<|>$/g, "").replace(/^(?=www\.)/, "https://")); }
  catch { throw new BmsError("bad_url", "Paste a full District movie URL."); }
  if (!["https:", "http:"].includes(url.protocol) || !["district.in", "www.district.in"].includes(url.hostname) || url.port || url.username || url.password) {
    throw new BmsError("bad_url", "That's not a district.in movie link.");
  }
  const event = url.pathname.match(/^\/events\/([a-z0-9-]+)-buy-tickets\/?$/i);
  if (event) return { provider: "district", city: "", slug: event[1]!.toLowerCase(), eventCode: `EV:${event[1]!.toLowerCase()}` };
  const match = url.pathname.match(/^\/movies\/([a-z0-9-]+)-movie-tickets-in-([a-z0-9-]+)-(MV\d+)\/?$/i);
  if (!match) throw new BmsError("bad_url", "Use a District movie link with a city, e.g. .../movies/ramayana-movie-tickets-in-mumbai-MV176276. For events, use the full /events/<event>-buy-tickets link. Dining is not supported.");
  const rawDate = url.searchParams.get("fromdate");
  if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) throw new BmsError("bad_url", "District fromdate must be YYYY-MM-DD.");
  return { provider: "district", city: match[2]!.toLowerCase(), slug: match[1]!.toLowerCase(), eventCode: match[3]!.toUpperCase(), ...(rawDate ? { date: rawDate.replaceAll("-", "") } : {}) };
}

export function districtUrl(t: Omit<Target, "date"> & { date?: string }, group?: string): string {
  const url = new URL(`https://www.district.in/movies/${t.slug}-movie-tickets-in-${t.city}-${t.eventCode}`);
  if (t.date) url.searchParams.set("fromdate", `${t.date.slice(0, 4)}-${t.date.slice(4, 6)}-${t.date.slice(6, 8)}`);
  if (group) url.searchParams.set("frmtid", group);
  return url.href;
}

const bad = (message: string): never => { throw new BmsError("unparseable", `District: ${message}`); };
const record = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

export type DistrictPage = { title: string; shows: Show[]; dates: string[]; groups: string[]; selectedGroup: string; upcoming: boolean };

/** Captured SSR schema. Missing or changed data throws; only explicit empty states return []. */
export function parseDistrictPage(html: string, t: Omit<Target, "date"> & { date?: string }): DistrictPage {
  const script = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) return bad("missing page data (blocked response or changed HTML)");
  let json: any;
  try { json = JSON.parse(script[1]!); } catch { return bad("invalid page JSON"); }
  const p = json?.props?.pageProps;
  const d = p?.data;
  if (json?.props?.pageProps?.statusCode === 404 || p?.statusCode === 404) throw new BmsError("not_found", "District movie not found.");
  if (!record(d) || String(d.contentId) !== t.eventCode.slice(2)) return bad("movie identity missing or mismatched");
  const state = d.serverState;
  if (!record(state)) return bad("missing server state");
  // Generic pages are used for films with no bookings yet, even with a city in the URL.
  const upcoming = d.isGeneric === true && d.movieData?.meta?.isReleased === false;
  const movie = upcoming ? d.movieData?.meta?.movie : state.movieContents?.[d.contentId];
  if (!record(movie) || typeof movie.name !== "string" || !movie.name) return bad("missing movie title");
  if (upcoming) return { title: movie.name, shows: [], dates: [], groups: [], selectedGroup: "", upcoming: true };
  if (d.cityError || d.cityName !== t.city) return bad("city missing or mismatched");
  if (!record(state.movieSessions) || !Array.isArray(movie.languageFormatGroups)) return bad("missing sessions or language groups");
  const groups = movie.languageFormatGroups.map((g: any) => {
    if (typeof g.format !== "string" || !/^[a-z0-9]+$/i.test(g.format)) return bad("invalid language group");
    return g.format.toLowerCase();
  });
  const selectedGroup = state.queryState?.frmtid;
  if (typeof selectedGroup !== "string" || !groups.includes(selectedGroup.toLowerCase())) return bad("missing selected language group");
  const entries = Object.values(state.movieSessions);
  // Measured: a valid movie and an unavailable requested date have an explicit empty map.
  if (!entries.length && (!t.date || state.queryState?.fromdate?.replaceAll("-", "") !== t.date)) return bad("unexpected empty sessions");
  const shows: Show[] = [];
  const dates = new Set<string>();
  for (const entry of entries) {
    if (!record(entry) || !Array.isArray(entry.data?.sessionDates) || !record(entry.pageData)) return bad("invalid session container");
    for (const date of entry.data.sessionDates) {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("invalid session date");
      dates.add(date.replaceAll("-", ""));
    }
    for (const key of ["nearbyCinemas", "farCinemas"]) {
      const cinemas = entry.pageData[key];
      if (!Array.isArray(cinemas)) return bad(`missing ${key}`);
      for (const cinema of cinemas) {
        if (!record(cinema) || !Array.isArray(cinema.sessions) || typeof cinema.cinemaInfo?.name !== "string" || cinema.id == null) return bad("invalid cinema");
        for (const session of cinema.sessions) {
          if (!record(session) || typeof session.showTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(session.showTime) || session.sid == null || typeof session.scrnFmt !== "string" || typeof session.disableClick !== "boolean" || typeof session.avail !== "number") return bad("invalid showtime");
          // Measured against ScreeningEvent JSON-LD: raw zone-less timestamps are UTC.
          const epoch = Date.parse(`${session.showTime}Z`) / 1000;
          if (!Number.isFinite(epoch)) return bad("invalid show timestamp");
          const ist = new Date((epoch + 19800) * 1000).toISOString();
          const date = ist.slice(0, 10).replaceAll("-", "");
          if (session.disableClick || session.avail <= 0 || (t.date && date !== t.date)) continue;
          let ticketCategories: Show["ticketCategories"];
          if (!Array.isArray(session.areas)) return bad("missing ticket category availability");
          if (Array.isArray(session.areas)) {
            ticketCategories = session.areas.map((area: any) => {
              if (typeof area.label !== "string" || !Number.isInteger(area.sAvail) || area.sAvail < 0 || typeof area.price !== "number" || !Number.isFinite(area.price) || area.price < 0) return bad("invalid ticket category availability");
              return { name: area.label, available: area.sAvail, price: area.price };
            });
          }
          let bookingUrl: string | undefined;
          if (typeof session.mcd === "string" && /^[a-z0-9]+$/i.test(session.mcd) && typeof session.encSessionId === "string" && /^[a-z0-9-]+$/i.test(session.encSessionId) && session.sType === 0) {
            const url = new URL(`https://www.district.in/movies/seat-layout/${session.mcd.toLowerCase()}`);
            url.search = new URLSearchParams({ encsessionid: session.encSessionId, freeseating: "false", fromsessions: "true", type: "MOVIES", contentid: t.eventCode.slice(2) }).toString();
            bookingUrl = url.href;
          }
          shows.push({ ticketCategories, bookingUrl, sessionId: `${cinema.id}:${session.pid}:${session.sid}:${session.mid}`, availStatus: "AVAILABLE", showDateCode: date, showTime: ist.slice(11, 16), epoch, attributes: session.scrnFmt, venueCode: String(cinema.id), venueName: cinema.cinemaInfo.name });
        }
      }
    }
  }
  return { title: movie.name, shows, dates: [...dates].sort(), groups, selectedGroup: selectedGroup.toLowerCase(), upcoming: false };
}

async function fetchPage(t: Omit<Target, "date"> & { date?: string }, group?: string): Promise<DistrictPage> {
  let response: Response;
  try { response = await fetch(districtUrl(t, group), { signal: AbortSignal.timeout(30_000), redirect: "error" }); }
  catch (e) { throw new BmsError("network", `District request failed: ${(e as Error).message}`); }
  if (response.status === 404) throw new BmsError("not_found", "District movie not found.");
  if (!response.ok) throw new BmsError("blocked", `District HTTP ${response.status}`);
  const page = parseDistrictPage(await response.text(), t);
  if (group && !page.upcoming && page.selectedGroup !== group.toLowerCase()) return bad("requested language group was not returned");
  return page;
}

/** Check every language group; formats are attached to individual sessions, not BMS child events. */
async function fetchAll(t: Omit<Target, "date"> & { date?: string }): Promise<DistrictPage[]> {
  const first = await fetchPage(t);
  const pages = [first];
  for (const group of first.groups) {
    if (group !== first.selectedGroup) pages.push(await fetchPage(t, group));
  }
  return pages;
}

export async function fetchDistrictShowtimes(t: Target): Promise<{ title: string; shows: Show[] }> {
  const pages = await fetchAll(t);
  const shows = new Map(pages.flatMap((p) => p.shows).map((s) => [s.sessionId, s]));
  return { title: pages[0]!.title, shows: [...shows.values()] };
}

export async function fetchDistrictDates(t: Omit<Target, "date">) {
  // Do not carry a dated watch's date into the shared movie/date-strip request.
  const pages = await fetchAll({ city: t.city, slug: t.slug, eventCode: t.eventCode, provider: "district" });
  const shows = pages.flatMap((p) => p.shows);
  const venues = new Map(shows.map((s) => [s.venueCode, { code: s.venueCode, name: s.venueName }]));
  return { title: pages[0]!.title, dates: [...new Set(pages.flatMap((p) => p.dates))].sort(), venues: [...venues.values()], chips: [] };
}
