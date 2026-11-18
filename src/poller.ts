/** Watch evaluation, subscription date/venue diffing, and stale-watch expiration. */
import {
  isSubscription,
  markFail,
  markOk,
  recordSeenDates,
  recordSeenVenues,
  removeWatch,
  seenDates,
  seenVenues,
  shouldSilentSeedVenues,
  type Watch,
} from "./db.ts";
import {
  filterMatchingShows,
  filterSummary,
  hasShowLevelFilter,
  matchesDay,
  matchesTheatre,
  type WatchFilters,
} from "./filters.ts";
import * as msg from "./messages.ts";
import {
  collectFormats,
  type FormatChip,
  type Show,
  showsOnDate,
  type Target,
} from "./movie-model.ts";
import {
  discoverListingCached,
  fetchShowtimesCached,
  isDistrictEvent,
  PROBE_DATE,
  providerName,
  showsForListingCached,
  showtimesUrl,
} from "./providers.ts";
import { todayIST } from "./time-filter.ts";

export type DeliveryOutcome = "dm" | "channel_fallback" | "failed";

export type MessagePayload = { embeds: unknown[]; components?: unknown[] };

type DeliverWatchAlert = (w: Watch, payload: MessagePayload) => Promise<DeliveryOutcome>;

type ListingRef = {
  provider?: "bms" | "district";
  city: string;
  slug: string;
  eventCode: string;
};

function targetForWatch(w: Watch, date: string): Target {
  return {
    provider: w.provider,
    city: w.city,
    slug: w.slug,
    eventCode: w.event_code,
    date,
  };
}

async function recordPollFailure(w: Watch, err: Error, deliver: DeliverWatchAlert): Promise<void> {
  markFail(w.id, err.message);
  if (w.fail_count + 1 === 3) {
    await deliver(
      w,
      msg.cannotRead({ title: w.title, error: err.message, provider: providerName(w) }),
    );
  }
}

/**
 * Shared subscription date-qualification used at both creation time (fresh baseline)
 * and poll time (cached diff). Applies `day_filter` without HTTP requests, then
 * inspects per-date sessions only when `hasShowLevelFilter` requires it.
 */
export async function qualifySubscriptionDates(
  listing: ListingRef,
  candidateDates: string[],
  filters: WatchFilters,
  chips: FormatChip[],
  readShows: (
    target: Target,
    formatFilter: string | null,
    knownChips?: FormatChip[],
  ) => Promise<{ shows: Show[] }>,
  opts?: { today?: string; nowMs?: number; logPrefix?: string },
): Promise<{ dates: string[]; shows: Show[] }> {
  const dayMatched = filters.day_filter
    ? candidateDates.filter((d) => matchesDay(d, filters.day_filter!))
    : candidateDates;

  if (!hasShowLevelFilter(listing.provider, filters) || !dayMatched.length) {
    return { dates: dayMatched, shows: [] };
  }

  const today = opts?.today ?? todayIST();
  const nowMs = opts?.nowMs ?? Date.now();
  const logPrefix = opts?.logPrefix ?? `[${listing.eventCode}]`;
  const kept: string[] = [];
  const matchedShows: Show[] = [];

  for (const d of dayMatched) {
    try {
      const { shows } = await readShows({ ...listing, date: d }, filters.format_filter, chips);
      const hits = filterMatchingShows(shows, filters, { today, nowMs });
      if (hits.length) {
        kept.push(d);
        matchedShows.push(...hits);
      } else if (filters.format_filter) {
        console.log(`${logPrefix} ${d} filtered out: no ${filters.format_filter} shows`);
      }
    } catch (e) {
      if (listing.provider === "district") throw e;
      console.error(`${logPrefix} format check failed for ${d}:`, (e as Error).message);
    }
  }

  return { dates: kept, shows: matchedShows };
}

/**
 * A dated watch whose calendar date has passed can never fire — BookMyShow silently
 * substitutes the next open date, so retire it and notify the owner.
 */
export async function expireStale(w: Watch, deliver: DeliverWatchAlert): Promise<boolean> {
  const today = todayIST();
  if (isSubscription(w) || w.date >= today) return false;
  await deliver(w, msg.watchExpired({ title: w.title, date: w.date }));
  removeWatch(w.id, w.user_id);
  console.log(`[poll] expired watch ${w.id} (${w.date} < ${today})`);
  return true;
}

async function qualifyDistrictVenues(
  w: Watch,
  dates: string[],
  freshVenues: { code: string; name: string }[],
  today: string,
  nowMs: number,
): Promise<{ code: string; name: string }[]> {
  const qualified = new Set<string>();
  for (const d of dates) {
    if (w.day_filter && !matchesDay(d, w.day_filter)) continue;
    const res = await fetchShowtimesCached(targetForWatch(w, d));
    for (const sh of filterMatchingShows(showsOnDate(res.shows, d), w, {
      today,
      nowMs,
      checkFormat: true,
    })) {
      qualified.add(sh.venueCode);
    }
  }
  return freshVenues.filter((v) => qualified.has(v.code));
}

async function checkSubscription(w: Watch, deliver: DeliverWatchAlert): Promise<void> {
  const listing: ListingRef = {
    provider: w.provider,
    city: w.city,
    slug: w.slug,
    eventCode: w.event_code,
  };
  let dates: string[];
  let venues: { code: string; name: string }[] | null;
  let chips: FormatChip[] = [];
  let posterUrl: string | undefined;
  try {
    ({ dates, venues, chips, posterUrl } = await discoverListingCached(listing, w.format_filter));
  } catch (e) {
    await recordPollFailure(w, e as Error, deliver);
    return;
  }

  // null venues = parse failed; skip cinema diff rather than treating as empty.
  // BMS fresh venues are diffed by venue code + theatre_filter without extra requests.
  let freshVenues: { code: string; name: string }[] = [];
  if (venues) {
    if (!isDistrictEvent(w) && shouldSilentSeedVenues(w.id)) {
      recordSeenVenues(
        w.id,
        venues.map((v) => v.code),
      );
    } else {
      const known = new Set(seenVenues(w.id));
      freshVenues = venues.filter((v) => !known.has(v.code));
      if (w.theatre_filter) {
        freshVenues = freshVenues.filter((v) => matchesTheatre(v.name, v.code, w.theatre_filter!));
      }
    }
  }

  const today = todayIST();
  const nowMs = Date.now();
  if (w.provider === "district" && freshVenues.length) {
    freshVenues = await qualifyDistrictVenues(w, dates, freshVenues, today, nowMs);
  }

  const knownDates = new Set(seenDates(w.id));
  const unseenDates = dates.filter((d) => !knownDates.has(d));
  const qualified = await qualifySubscriptionDates(
    listing,
    unseenDates,
    w,
    chips,
    showsForListingCached,
    { today, nowMs, logPrefix: `[watch ${w.id}]` },
  );
  const freshDates = qualified.dates;
  const matchedShows = qualified.shows;

  markOk(w.id);
  if (!freshDates.length && !freshVenues.length) return;

  const outcome = await deliver(
    w,
    msg.subscriptionAlert({
      title: w.title,
      city: w.city,
      dates: freshDates,
      venues: freshVenues,
      url: showtimesUrl(targetForWatch(w, freshDates[0] ?? dates[0] ?? PROBE_DATE)),
      filters: filterSummary(w),
      matchedFormats: w.format_filter ? collectFormats(matchedShows) : [],
      shows: matchedShows,
      isEvent: isDistrictEvent(w),
      posterUrl,
      watchId: w.id,
    }),
  );
  if (outcome !== "failed") {
    if (freshDates.length) recordSeenDates(w.id, freshDates);
    if (freshVenues.length) {
      recordSeenVenues(
        w.id,
        freshVenues.map((v) => v.code),
      );
    }
  } else {
    console.error(`[watch ${w.id}] undelivered, will retry`);
  }
}

export async function checkWatch(w: Watch, deliver: DeliverWatchAlert): Promise<void> {
  if (isSubscription(w)) {
    try {
      await checkSubscription(w, deliver);
    } catch (e) {
      await recordPollFailure(w, e as Error, deliver);
    }
    return;
  }

  const target = targetForWatch(w, w.date);
  let candidateShows: Show[];
  let posterUrl: string | undefined;
  try {
    const res = await discoverListingCached(target, w.format_filter);
    posterUrl = res.posterUrl;
    if (!res.dates.includes(w.date)) {
      markOk(w.id);
      return;
    }
    const matched = await showsForListingCached(target, w.format_filter, res.chips);
    posterUrl ??= matched.posterUrl;
    candidateShows = matched.shows;
  } catch (e) {
    await recordPollFailure(w, e as Error, deliver);
    return;
  }
  markOk(w.id);

  const filtered = filterMatchingShows(candidateShows, w, { checkDay: true });
  if (!filtered.length) return;

  const outcome = await deliver(
    w,
    msg.ticketsLive({
      title: w.title,
      city: w.city,
      date: w.date,
      shows: filtered,
      url: showtimesUrl(target),
      filters: filterSummary(w),
      matchedFormats: w.format_filter ? collectFormats(filtered) : [],
      posterUrl,
    }),
  );
  if (outcome !== "failed") {
    removeWatch(w.id, w.user_id);
  } else {
    console.error(`[watch ${w.id}] undelivered, keeping watch alive to retry`);
  }
}
