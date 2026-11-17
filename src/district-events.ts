/** Public District event reads. React Flight is parsed as data, never executed. */
import { BmsError, type Show, type Target } from "./bms.ts";
export const isDistrictEvent = (t: { provider?: string; eventCode?: string; event_code?: string }) => t.provider === "district" && (t.eventCode ?? t.event_code ?? "").startsWith("EV:");
export const districtEventUrl = (t: Pick<Target, "slug">) => `https://www.district.in/events/${t.slug}-buy-tickets`;
const bad = (s: string): never => { throw new BmsError("unparseable", `District event: ${s}`); };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Flight text rows use byte lengths and may contain newlines or fake row headers. */
export function flightRecords(html: string): unknown[] {
  let stream = "";
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const call = script[1]!.match(/^self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?$/);
    if (!call) continue;
    try { const row = JSON.parse(call[1]!); if (row[0] === 1 && typeof row[1] === "string") stream += row[1]; }
    catch { return bad("invalid Flight chunk"); }
  }
  const bytes = new TextEncoder().encode(stream), decoder = new TextDecoder();
  const records: unknown[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (bytes[pos] === 10) { pos++; continue; }
    const header = decoder.decode(bytes.subarray(pos, pos + 80)).match(/^[0-9a-f]*:/);
    if (!header) return bad("invalid Flight row header");
    pos += header[0].length;
    if (bytes[pos] === 84) { // T<hex byte length>,<text>; text has no newline terminator.
      const length = decoder.decode(bytes.subarray(pos, pos + 30)).match(/^T([0-9a-f]+),/);
      if (!length) return bad("invalid Flight text row");
      pos += length[0].length + parseInt(length[1]!, 16);
      if (pos > bytes.length) return bad("truncated Flight text");
      continue;
    }
    let end = bytes.indexOf(10, pos); if (end < 0) end = bytes.length;
    const payload = decoder.decode(bytes.subarray(pos, end));
    if (/^[\[{"]/.test(payload)) {
      try { records.push(JSON.parse(payload)); } catch { return bad("invalid Flight JSON row"); }
    }
    pos = end + 1;
  }
  return records;
}

export type EventSnapshot = { title: string; city: string; shows: Show[]; dates: string[]; venues: { code: string; name: string }[]; chips: never[] };
export function parseDistrictEvent(html: string, t: Pick<Target, "slug">, now = Date.now()): EventSnapshot {
  let data: any;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const child of v) walk(child); }
    else if (object(v)) {
      if (object(v.eventData?.data) && v.eventData.data.slug === t.slug) data = v.eventData.data;
      for (const child of Object.values(v)) if (object(child) || Array.isArray(child)) walk(child);
    }
  };
  for (const row of flightRecords(html)) walk(row);
  if (!data || typeof data._id !== "string" || typeof data.name !== "string" || typeof data.city !== "string" || !data.city) return bad("missing or mismatched event identity");
  if (typeof data.sold_out !== "boolean" || typeof data.locked !== "boolean" || typeof data.is_rsvp !== "boolean" || typeof data.event_state !== "string" || !object(data.event_state_config) || typeof data.event_state_config.user_action_state !== "string" || !Array.isArray(data.sellable_shows)) return bad("missing sale state or sellable shows");
  const city = data.city.toLowerCase().trim().replace(/\s+/g, "-");
  const result: EventSnapshot = { title: data.name, city, shows: [], dates: [], venues: [], chips: [] };
  // Available alone is insufficient: preregistration/notify-me pages also say available.
  if (data.sold_out || data.locked || data.is_rsvp) return result;
  if (data.event_state !== "available") return bad(`unsupported event state: ${data.event_state}`);
  const action = data.event_state_config.user_action_state;
  if (action === "LOGIN") return result;
  if (action !== "BOOK_TICKETS") return bad(`unsupported ticket action: ${action}`);
  if (!object(data.venue) || typeof data.venue.name !== "string" || typeof data.venue.id?._id !== "string") return bad("missing venue identity");
  if (!Array.isArray(data.sales)) return bad("missing sale restrictions");
  if (data.sales.length && !data.sales.some((sale: any) => sale.sale_type === "general_sale" && sale.status === "live" && sale.is_active === true && Array.isArray(sale.sales_conditions) && sale.sales_conditions.length === 0 && sale.is_bin_restriction_enabled !== true)) return result;
  const seen = new Set<string>();
  for (const show of data.sellable_shows) {
    if (!object(show) || typeof show._id !== "string" || typeof show.start_utc_timestamp !== "number" || !Number.isFinite(show.start_utc_timestamp) || show.start_utc_timestamp < 1e9 || show.start_utc_timestamp > 1e11 || typeof show.sold_out !== "boolean" || typeof show.is_hidden !== "boolean") return bad("invalid event show");
    if (show.sold_out || show.is_hidden || show.start_utc_timestamp * 1000 <= now || seen.has(show._id)) continue;
    seen.add(show._id);
    const ist = new Date((show.start_utc_timestamp + 19800) * 1000).toISOString();
    result.shows.push({ sessionId: `${data._id}:${show._id}`, availStatus: "AVAILABLE", showDateCode: ist.slice(0, 10).replaceAll("-", ""), showTime: ist.slice(11, 16), epoch: show.start_utc_timestamp, attributes: "", venueCode: data.venue.id._id, venueName: data.venue.name });
  }
  result.dates = [...new Set(result.shows.map((s) => s.showDateCode))].sort();
  if (result.shows.length) result.venues = [{ code: data.venue.id._id, name: data.venue.name }];
  return result;
}

export async function fetchDistrictEvent(t: Pick<Target, "slug">): Promise<EventSnapshot> {
  let res: Response;
  try { res = await fetch(districtEventUrl(t), { signal: AbortSignal.timeout(30_000), redirect: "error" }); }
  catch (e) { throw new BmsError("network", `District event request failed: ${(e as Error).message}`); }
  if (res.status === 404) throw new BmsError("not_found", "District event not found.");
  if (!res.ok) throw new BmsError("blocked", `District event HTTP ${res.status}`);
  return parseDistrictEvent(await res.text(), t);
}
