/** Route public movie reads without changing BookMyShow's measured transport. */
import * as bms from "./bms.ts";
import { parseDistrictUrl, districtUrl, fetchDistrictShowtimes, fetchDistrictDates } from "./district.ts";
import { isDistrictEvent, fetchDistrictEvent, districtEventUrl } from "./district-events.ts";
export { isDistrictEvent } from "./district-events.ts";
export { BmsError, PROBE_DATE, showsOnDate, prettyDate } from "./bms.ts";
export type { Target, Show, FormatChip } from "./bms.ts";
import type { Target } from "./bms.ts";

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

let dates = new Map<string, ReturnType<typeof fetchBookableDates>>();
let shows = new Map<string, ReturnType<typeof fetchShowtimes>>();
let events = new Map<string, ReturnType<typeof fetchDistrictEvent>>();
let hits = 0;
function eventCached(t: Target | Omit<Target, "date">) {
  const k = key(t), existing = events.get(k);
  if (existing) { hits++; return existing; }
  const result = fetchDistrictEvent(t); events.set(k, result); return result;
}
export function beginCycle() { dates = new Map(); shows = new Map(); events = new Map(); hits = 0; }
export const coalescedCount = () => hits;
const key = (t: Omit<Target, "date">) => `${providerOf(t)}|${t.city}|${t.eventCode}`;
export function bookableDatesCached(t: Omit<Target, "date">) {
  const k = key(t), existing = dates.get(k);
  if (existing) { hits++; return existing; }
  const result = isDistrictEvent(t) ? eventCached(t) : fetchBookableDates(t); dates.set(k, result); return result;
}
export function fetchShowtimesCached(t: Target) {
  const k = `${key(t)}|${t.date}`, existing = shows.get(k);
  if (existing) { hits++; return existing; }
  const result = isDistrictEvent(t) ? eventCached(t).then((r) => ({ title: r.title, shows: r.shows.filter((s) => s.showDateCode === t.date) })) : fetchShowtimes(t); shows.set(k, result); return result;
}
