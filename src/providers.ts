/** Route public movie and event reads without changing BookMyShow's measured transport. */
import * as bms from "./bms.ts";
import {
  districtUrl,
  fetchDistrictDates,
  fetchDistrictShowtimes,
  parseDistrictUrl,
} from "./district.ts";
import { isDistrictCandidate } from "./district-common.ts";
import {
  districtEventUrl,
  type EventSnapshot,
  fetchDistrictEvent,
  isDistrictEvent,
  parseDistrictEventUrl,
} from "./district-events.ts";
import { matchesFormat } from "./filters.ts";
import {
  cleanWatchInput,
  type FormatChip,
  type Show,
  showsOnDate,
  type Target,
} from "./movie-model.ts";
import { ReadCycle } from "./read-cycle.ts";

export { closeBms as closeProviders, initBms as initProviders, PROBE_DATE } from "./bms.ts";
export { isDistrictEvent } from "./district-events.ts";
export { showsOnDate } from "./movie-model.ts";
export type { FormatChip, Show, Target, TicketCategory } from "./movie-model.ts";
export { BmsError } from "./provider-error.ts";

type ShowtimesResult = {
  title: string;
  shows: Show[];
  chips: FormatChip[];
  posterUrl?: string;
};

type BookableDatesResult = {
  title: string;
  dates: string[];
  venues: { code: string; name: string }[] | null;
  chips: FormatChip[];
  posterUrl?: string;
};

export function providerOf(t: { provider?: "bms" | "district" }): "bms" | "district" {
  return t.provider ?? "bms";
}

export function providerName(t: { provider?: "bms" | "district" }): "BookMyShow" | "District" {
  return providerOf(t) === "district" ? "District" : "BookMyShow";
}

export function parseWatchUrl(input: string): Omit<Target, "date"> & { date?: string } {
  const raw = cleanWatchInput(input);
  if (isDistrictCandidate(raw)) {
    if (/^(?:https?:\/\/)?(?:(?:www|m)\.)?district\.in\/events(?:\/|$)/i.test(raw)) {
      return parseDistrictEventUrl(raw);
    }
    return parseDistrictUrl(raw);
  }
  return { ...bms.parseWatchUrl(raw), provider: "bms" as const };
}

export async function resolveTargetCity(t: Omit<Target, "date">): Promise<string> {
  return isDistrictEvent(t) ? (await fetchDistrictEvent(t)).city : t.city;
}

function eventShowtimesOnDate(event: EventSnapshot, date: string): ShowtimesResult {
  return {
    title: event.title,
    shows: showsOnDate(event.shows, date),
    chips: [],
    ...(event.posterUrl ? { posterUrl: event.posterUrl } : {}),
  };
}

export async function fetchShowtimes(t: Target): Promise<ShowtimesResult> {
  if (isDistrictEvent(t)) {
    return eventShowtimesOnDate(await fetchDistrictEvent(t), t.date);
  }
  if (providerOf(t) === "district") {
    return fetchDistrictShowtimes(t);
  }
  return bms.fetchShowtimes(t);
}

export function fetchBookableDates(t: Omit<Target, "date">): Promise<BookableDatesResult> {
  if (isDistrictEvent(t)) {
    return fetchDistrictEvent(t);
  }
  if (providerOf(t) === "district") {
    return fetchDistrictDates(t);
  }
  return bms.fetchBookableDates(t);
}

export function showtimesUrl(t: Target): string {
  if (isDistrictEvent(t)) {
    return districtEventUrl(t);
  }
  if (providerOf(t) === "district") {
    return districtUrl(t);
  }
  return bms.showtimesUrl(t);
}

let cycle = new ReadCycle();

function cacheKey(t: Omit<Target, "date">): string {
  return `${providerOf(t)}|${t.city}|${t.eventCode}`;
}

function eventCached(t: Pick<Target, "slug">) {
  return cycle.once(`event|${t.slug}`, () => fetchDistrictEvent(t));
}

export function beginCycle(): void {
  cycle = new ReadCycle();
  bms.rotateSessionIfStale();
}

export function coalescedCount(): number {
  return cycle.hits;
}

export function bookableDatesCached(t: Omit<Target, "date">): Promise<BookableDatesResult> {
  return cycle.once(`dates|${cacheKey(t)}`, () =>
    isDistrictEvent(t) ? eventCached(t) : fetchBookableDates(t),
  );
}

export function fetchShowtimesCached(t: Target): Promise<ShowtimesResult> {
  return cycle.once(`shows|${cacheKey(t)}|${t.date}`, async () =>
    isDistrictEvent(t) ? eventShowtimesOnDate(await eventCached(t), t.date) : fetchShowtimes(t),
  );
}

function relevantSiblingChips(
  chips: FormatChip[],
  parentEventCode: string,
  formatFilter: string | null,
): FormatChip[] {
  const seen = new Set<string>([parentEventCode]);
  const out: FormatChip[] = [];
  for (const chip of chips) {
    if (seen.has(chip.eventCode)) continue;
    if (formatFilter && !matchesFormat(chip.title, formatFilter)) continue;
    seen.add(chip.eventCode);
    out.push(chip);
  }
  return out;
}

function enrichChipShow(show: Show, chipTitle: string): Show {
  const label = chipTitle.trim();
  if (!label) return show;
  if (!show.attributes) return { ...show, attributes: label };
  if (
    matchesFormat(show.attributes, label) ||
    show.attributes.toUpperCase().includes(label.toUpperCase())
  ) {
    return show;
  }
  return { ...show, attributes: `${label} · ${show.attributes}` };
}

async function collectListingDates(
  t: Omit<Target, "date">,
  formatFilter: string | null,
  readDates: (target: Omit<Target, "date">) => Promise<BookableDatesResult>,
): Promise<BookableDatesResult> {
  const parent = await readDates(t);
  const siblings = relevantSiblingChips(parent.chips, t.eventCode, formatFilter);
  if (!siblings.length) return parent;

  const dates = new Set(parent.dates);
  const venueMap =
    parent.venues === null ? null : new Map(parent.venues.map((v) => [v.code, v] as const));

  for (const chip of siblings) {
    try {
      const child = await readDates({ city: t.city, slug: chip.slug, eventCode: chip.eventCode });
      for (const d of child.dates) dates.add(d);
      if (venueMap && child.venues) {
        for (const v of child.venues) {
          if (!venueMap.has(v.code)) venueMap.set(v.code, v);
        }
      }
    } catch (e) {
      console.error(`[${t.eventCode}] ${chip.title} date check failed:`, (e as Error).message);
    }
  }

  return {
    ...parent,
    dates: [...dates].sort(),
    venues: venueMap ? [...venueMap.values()] : null,
  };
}

/** Discover open dates and venues for a listing, unioning BMS sibling format chips. */
export function discoverListing(
  t: Omit<Target, "date">,
  formatFilter: string | null,
): Promise<BookableDatesResult> {
  return collectListingDates(t, formatFilter, fetchBookableDates);
}

/** Per-cycle coalesced `discoverListing`. */
export function discoverListingCached(
  t: Omit<Target, "date">,
  formatFilter: string | null,
): Promise<BookableDatesResult> {
  return collectListingDates(t, formatFilter, bookableDatesCached);
}

async function collectListingShows(
  target: Target,
  formatFilter: string | null,
  knownChips: FormatChip[] | undefined,
  readShowtimes: (t: Target) => Promise<ShowtimesResult>,
): Promise<{ title: string; shows: Show[]; posterUrl?: string }> {
  const res = await readShowtimes(target);
  const shows = showsOnDate(res.shows, target.date).filter(
    (s) => !formatFilter || matchesFormat(s.attributes, formatFilter),
  );

  for (const chip of relevantSiblingChips(
    knownChips ?? res.chips,
    target.eventCode,
    formatFilter,
  )) {
    try {
      const child = await readShowtimes({
        city: target.city,
        slug: chip.slug,
        eventCode: chip.eventCode,
        date: target.date,
      });
      for (const rawShow of showsOnDate(child.shows, target.date)) {
        const show = enrichChipShow(rawShow, chip.title);
        if (
          !formatFilter ||
          matchesFormat(show.attributes, formatFilter) ||
          matchesFormat(chip.title, formatFilter)
        ) {
          shows.push(show);
        }
      }
    } catch (e) {
      console.error(
        `[${target.eventCode}] ${chip.title} check failed for ${target.date}:`,
        (e as Error).message,
      );
    }
  }

  return {
    title: res.title,
    shows,
    ...(res.posterUrl ? { posterUrl: res.posterUrl } : {}),
  };
}

export function showsForListing(
  target: Target,
  formatFilter: string | null,
  knownChips?: FormatChip[],
): Promise<{ title: string; shows: Show[]; posterUrl?: string }> {
  return collectListingShows(target, formatFilter, knownChips, fetchShowtimes);
}

export function showsForListingCached(
  target: Target,
  formatFilter: string | null,
  knownChips?: FormatChip[],
): Promise<{ title: string; shows: Show[]; posterUrl?: string }> {
  return collectListingShows(target, formatFilter, knownChips, fetchShowtimesCached);
}
