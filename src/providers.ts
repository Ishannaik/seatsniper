/** Route public movie reads without changing BookMyShow's measured transport. */
import * as bms from "./bms.ts";
import { ReadCycle } from "./read-cycle.ts";
import { parseDistrictUrl, districtUrl, fetchDistrictShowtimes, fetchDistrictDates } from "./district.ts";
import { isDistrictEvent, fetchDistrictEvent, districtEventUrl } from "./district-events.ts";
export { isDistrictEvent } from "./district-events.ts";
export { BmsError } from "./provider-error.ts";
export { PROBE_DATE } from "./bms.ts";
export { showsOnDate } from "./movie-model.ts";
export { prettyDate } from "./time-filter.ts";
export type { Target, Show, FormatChip } from "./movie-model.ts";
import type { Target } from "./movie-model.ts";

export const providerOf = (t: { provider?: "bms" | "district" }) => t.provider ?? "bms";
export const providerName = (t: { provider?: "bms" | "district" }) => providerOf(t) === "district" ? "District" : "BookMyShow";
export function parseWatchUrl(input: string) {
  const raw = input.trim().replace(/^<|>$/g, "");
  if (/^(?:https?:\/\/)?(?:www\.)?district\.in(?:\/|$)/i.test(raw)) return parseDistrictUrl(raw);
  return { ...bms.parseWatchUrl(input), provider: "bms" as const };
}
export const fetchShowtimes = (t: Target) => isDistrictEvent(t) ? fetchDistrictEvent(t).then((r) => ({ title: r.title, shows: r.shows.filter((s) => s.showDateCode === t.date) })) : providerOf(t) === "district" ? fetchDistrictShowtimes(t) : bms.fetchShowtimes(t);
export const fetchBookableDates = (t: Omit<Target, "date">) => isDistrictEvent(t) ? fetchDistrictEvent(t) : providerOf(t) === "district" ? fetchDistrictDates(t) : bms.fetchBookableDates(t);
export const showtimesUrl = (t: Target) => isDistrictEvent(t) ? districtEventUrl(t) : providerOf(t) === "district" ? districtUrl(t) : bms.showtimesUrl(t);

let cycle = new ReadCycle();
const key = (t: Omit<Target, "date">) => `${providerOf(t)}|${t.city}|${t.eventCode}`;
function eventCached(t: Target | Omit<Target, "date">) {
  return cycle.once('event|' + key(t), () => fetchDistrictEvent(t));
}
export function beginCycle() { cycle = new ReadCycle(); }
export const coalescedCount = () => cycle.hits;
export function bookableDatesCached(t: Omit<Target, "date">) {
  return cycle.once('dates|' + key(t), () => isDistrictEvent(t) ? eventCached(t) : fetchBookableDates(t));
}
export function fetchShowtimesCached(t: Target) {
  return cycle.once(`shows|${key(t)}|${t.date}`, () => isDistrictEvent(t)
    ? eventCached(t).then(r => ({ title: r.title, shows: r.shows.filter(s => s.showDateCode === t.date) }))
    : fetchShowtimes(t));
}
