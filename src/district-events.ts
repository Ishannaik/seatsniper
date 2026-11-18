/** Public District event reads. React Flight is parsed as data, never executed. */
import {
  extractDistrictPoster,
  fetchDistrictHtml,
  isRecord,
  type JsonObject,
  parseDistrictHostUrl,
} from "./district-common.ts";
import type { FormatChip, Show, Target } from "./movie-model.ts";
import { BmsError } from "./provider-error.ts";
import { epochToIst } from "./time-filter.ts";

export function isDistrictEvent(t: {
  provider?: string;
  eventCode?: string;
  event_code?: string;
}): boolean {
  return t.provider === "district" && (t.eventCode ?? t.event_code ?? "").startsWith("EV:");
}

export function parseDistrictEventUrl(input: string): Omit<Target, "date"> {
  const url = parseDistrictHostUrl(
    input,
    "Paste a full District event URL.",
    "That's not a district.in event link.",
  );
  const event = url.pathname.match(/^\/events\/([a-z0-9-]+)-buy-tickets\/?$/i);
  if (!event) {
    throw new BmsError(
      "bad_url",
      "For District events, use the full /events/<event>-buy-tickets link.",
    );
  }
  const slug = event[1]!.toLowerCase();
  return { provider: "district", city: "", slug, eventCode: `EV:${slug}` };
}

export function districtEventUrl(t: Pick<Target, "slug">): string {
  return `https://www.district.in/events/${t.slug}-buy-tickets`;
}

function failUnparseable(message: string): never {
  throw new BmsError("unparseable", `District event: ${message}`);
}

function extractFlightStream(html: string): string {
  let stream = "";
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const call = script[1]!.match(/^self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?$/);
    if (!call) continue;
    try {
      const row: unknown = JSON.parse(call[1]!);
      if (Array.isArray(row) && row[0] === 1 && typeof row[1] === "string") {
        stream += row[1];
      }
    } catch {
      return failUnparseable("invalid Flight chunk");
    }
  }
  return stream;
}

/** Flight text rows use byte lengths and may contain newlines or fake row headers. */
export function flightRecords(html: string): unknown[] {
  const bytes = new TextEncoder().encode(extractFlightStream(html));
  const decoder = new TextDecoder();
  const records: unknown[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    if (bytes[pos] === 10) {
      pos++;
      continue;
    }
    const header = decoder.decode(bytes.subarray(pos, pos + 80)).match(/^[0-9a-f]*:/);
    if (!header) return failUnparseable("invalid Flight row header");
    pos += header[0].length;

    // T<hex byte length>,<text>; text has no newline terminator.
    if (bytes[pos] === 84) {
      const length = decoder.decode(bytes.subarray(pos, pos + 30)).match(/^T([0-9a-f]+),/);
      if (!length) return failUnparseable("invalid Flight text row");
      pos += length[0].length + parseInt(length[1]!, 16);
      if (pos > bytes.length) return failUnparseable("truncated Flight text");
      continue;
    }

    const nl = bytes.indexOf(10, pos);
    const end = nl < 0 ? bytes.length : nl;
    const payload = decoder.decode(bytes.subarray(pos, end));
    if (/^[[{"]/.test(payload)) {
      try {
        records.push(JSON.parse(payload));
      } catch {
        return failUnparseable("invalid Flight JSON row");
      }
    }
    pos = end + 1;
  }
  return records;
}

export type EventSnapshot = {
  title: string;
  city: string;
  shows: Show[];
  dates: string[];
  venues: { code: string; name: string }[];
  chips: FormatChip[];
  posterUrl?: string;
};

function findEventPayload(records: unknown[], slug: string): JsonObject | undefined {
  let found: JsonObject | undefined;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    if (!isRecord(value)) return;
    const eventData = isRecord(value.eventData) ? value.eventData.data : undefined;
    if (isRecord(eventData) && eventData.slug === slug) {
      found = eventData;
    }
    for (const child of Object.values(value)) {
      if (isRecord(child) || Array.isArray(child)) walk(child);
    }
  };
  for (const row of records) walk(row);
  return found;
}

function collectSellableShows(
  eventId: string,
  sellableShows: unknown[],
  venueCode: string,
  venueName: string,
  now: number,
): Show[] {
  const shows: Show[] = [];
  const seen = new Set<string>();
  for (const show of sellableShows) {
    if (
      !isRecord(show) ||
      typeof show._id !== "string" ||
      typeof show.start_utc_timestamp !== "number" ||
      !Number.isFinite(show.start_utc_timestamp) ||
      show.start_utc_timestamp < 1e9 ||
      show.start_utc_timestamp > 1e11 ||
      typeof show.sold_out !== "boolean" ||
      typeof show.is_hidden !== "boolean"
    ) {
      return failUnparseable("invalid event show");
    }
    if (
      show.sold_out ||
      show.is_hidden ||
      show.start_utc_timestamp * 1000 <= now ||
      seen.has(show._id)
    ) {
      continue;
    }
    seen.add(show._id);
    const { dateCode, showTime } = epochToIst(show.start_utc_timestamp);
    shows.push({
      sessionId: `${eventId}:${show._id}`,
      availStatus: "AVAILABLE",
      showDateCode: dateCode,
      showTime,
      epoch: show.start_utc_timestamp,
      attributes: "",
      venueCode,
      venueName,
    });
  }
  return shows;
}

export function parseDistrictEvent(
  html: string,
  t: Pick<Target, "slug">,
  now = Date.now(),
): EventSnapshot {
  const data = findEventPayload(flightRecords(html), t.slug);
  if (
    !data ||
    typeof data._id !== "string" ||
    typeof data.name !== "string" ||
    typeof data.city !== "string" ||
    !data.city
  ) {
    return failUnparseable("missing or mismatched event identity");
  }

  if (
    typeof data.sold_out !== "boolean" ||
    typeof data.locked !== "boolean" ||
    typeof data.is_rsvp !== "boolean" ||
    typeof data.event_state !== "string" ||
    !isRecord(data.event_state_config) ||
    typeof data.event_state_config.user_action_state !== "string" ||
    !Array.isArray(data.sellable_shows)
  ) {
    return failUnparseable("missing sale state or sellable shows");
  }

  const city = data.city.toLowerCase().trim().replace(/\s+/g, "-");
  const posterUrl = extractDistrictPoster(
    [data.horizontal_cover_image, data.vertical_cover_image, data.card_image, data.image_url],
    html,
  );
  const result: EventSnapshot = {
    title: data.name,
    city,
    shows: [],
    dates: [],
    venues: [],
    chips: [],
    ...(posterUrl ? { posterUrl } : {}),
  };

  // Available alone is insufficient: preregistration/notify-me pages also say available.
  if (data.sold_out || data.locked || data.is_rsvp) return result;
  if (data.event_state !== "available") {
    return failUnparseable(`unsupported event state: ${data.event_state}`);
  }

  const action = data.event_state_config.user_action_state;
  if (action === "LOGIN") return result;
  if (action !== "BOOK_TICKETS") return failUnparseable(`unsupported ticket action: ${action}`);

  const venueIdObj = isRecord(data.venue) && isRecord(data.venue.id) ? data.venue.id : undefined;
  if (
    !isRecord(data.venue) ||
    typeof data.venue.name !== "string" ||
    typeof venueIdObj?._id !== "string"
  ) {
    return failUnparseable("missing venue identity");
  }
  if (!Array.isArray(data.sales)) return failUnparseable("missing sale restrictions");

  const hasOpenGeneralSale = data.sales.some(
    (sale: unknown) =>
      isRecord(sale) &&
      sale.sale_type === "general_sale" &&
      sale.status === "live" &&
      sale.is_active === true &&
      Array.isArray(sale.sales_conditions) &&
      sale.sales_conditions.length === 0 &&
      sale.is_bin_restriction_enabled !== true,
  );
  if (data.sales.length && !hasOpenGeneralSale) return result;

  result.shows = collectSellableShows(
    data._id,
    data.sellable_shows,
    venueIdObj._id,
    data.venue.name,
    now,
  );
  result.dates = [...new Set(result.shows.map((show) => show.showDateCode))].sort();
  if (result.shows.length) {
    result.venues = [{ code: venueIdObj._id, name: data.venue.name }];
  }
  return result;
}

export async function fetchDistrictEvent(t: Pick<Target, "slug">): Promise<EventSnapshot> {
  const html = await fetchDistrictHtml(
    districtEventUrl(t),
    "District event",
    "District event not found.",
  );
  return parseDistrictEvent(html, t);
}
