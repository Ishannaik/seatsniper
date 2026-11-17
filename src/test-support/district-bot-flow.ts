// Isolated bot smoke test: real command/poller/DB/provider code, fake Discord and HTTP.
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import * as discord from "discord.js";
import { strict as assert } from "node:assert";

const handlers = new Map<string, (...args: any[]) => any>();
const deliveries: any[] = [];
let failDelivery = true;
let nextTick: (() => void) | undefined;
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...args: any[]) => any, ms: number, ...args: any[]) => {
  if (ms === 600_000) { nextTick = fn; return 0; }
  return nativeTimeout(fn, ms, ...args);
}) as typeof setTimeout;
class FakeClient {
  user = { tag: "SeatSniper-test" };
  users = { fetch: async (id: string) => ({ send: async (payload: any) => { if (failDelivery) throw Error("DM unavailable"); deliveries.push({ id, payload }); } }) };
  channels = { fetch: async () => { throw Error("channel unavailable"); } };
  on(event: string, fn: (...args: any[]) => any) { handlers.set(event, fn); }
  once(event: string, fn: (...args: any[]) => any) { handlers.set(event, fn); }
  async login() { return "test"; }
  async destroy() {}
}
mock.module("discord.js", () => ({ ...discord, Client: FakeClient }));
mock.module("node-tls-client", () => ({ ClientIdentifier: { safari_ios_18_0: "safari" }, initTLS: async () => {}, Session: class { async close() {} } }));
let live = false;
let eventLive = false;
const eventHtml = readFileSync(new URL("../fixtures/district/event-live.html", import.meta.url), "utf8");
const html = readFileSync(new URL("../fixtures/district/movie.html", import.meta.url), "utf8");
globalThis.fetch = (async (input: string | URL | Request) => new Response(String(input).includes("/events/") ? (eventLive ? eventHtml : eventHtml.replaceAll("BOOK_TICKETS", "LOGIN")) : (live ? html : html.replaceAll('"disableClick": false', '"disableClick": true')))) as unknown as typeof fetch;
Date.now = () => Date.parse("2026-11-14T12:00:00Z");
process.env.DISCORD_TOKEN = "fake-test-token";
process.env.DISTRICT_BOOKING_OWNER_ID = "12345";
process.env.DISTRICT_STATE_DIR = process.env.DB_PATH + ".district";
process.env.STAGGER_MS_MIN = "0";
process.env.STAGGER_MS_MAX = "0";
process.env.POLL_INTERVAL_SEC = "600";
delete process.env.UPTIME_KUMA_PUSH_URL;
await import("../index.ts");
const db = await import("../db.ts");
const command = async (user: string, date: string, event = false) => {
  const options: Record<string, string> = { link: "https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276", date, format: "3D", theatre: "PVR", after: "13:00", before: "14:00" };
  if (!event) { options.seats = "2"; options.budget = "400"; }
  if (event) {
    options.link = "https://www.district.in/events/samay-raina-live-delhi-yashobhoomi-6a9bfcb5d4d3d3abd96591c9-2026-buy-tickets";
    delete options.format; options.theatre = "Yashobhoomi"; options.after = "14:00"; options.before = "16:00";
  }
  const replies: any[] = [];
  await handlers.get("interactionCreate")!({ commandName: "watch", user: { id: user }, channelId: "c", options: { getString: (key: string) => options[key] ?? null, getInteger: (key: string) => options[key] ? Number(options[key]) : null, getNumber: (key: string) => options[key] ? Number(options[key]) : null }, isModalSubmit: () => false, isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true, deferReply: async () => {}, editReply: async (v: any) => replies.push(v) });
  assert.equal(db.listWatches(user).length, 1, JSON.stringify(replies));
};
await command("dated-user", "2026-11-15");
await command("subscriber", "any");
assert.equal(db.listWatches("dated-user")[0]!.provider, "district");
assert.equal(db.listWatches("dated-user")[0]!.seat_count, 2);
assert.equal(db.listWatches("dated-user")[0]!.seat_budget, 400);
live = true;
const waitForTick = async () => {
  for (let n = 0; n < 1000 && !nextTick; n++) await Bun.sleep(2);
  assert(nextTick, "poll did not finish");
};
handlers.get("clientReady")!({ user: { tag: "test" } });
await waitForTick();
// Failed DM + channel fallback must retain both watches and their pending alerts.
assert.equal(deliveries.length, 0);
assert.equal(db.listWatches("dated-user").length, 1);
assert.deepEqual(db.seenDates(db.listWatches("subscriber")[0]!.id), []);
failDelivery = false;
const tick = nextTick!; nextTick = undefined; tick();
await waitForTick();
assert.equal(deliveries.length, 2);
assert.equal(db.listWatches("dated-user").length, 0);
assert.deepEqual(db.seenDates(db.listWatches("subscriber")[0]!.id), ["20261115"]);
for (const delivery of deliveries) assert(delivery.payload.components[0].toJSON().components[0].url.startsWith("https://www.district.in/"));
const lastTick = nextTick!; nextTick = undefined; lastTick();
await waitForTick();
assert.equal(deliveries.length, 2, "repeat poll duplicated an alert");
await command("event-dated", "2027-02-05", true);
await command("event-subscriber", "any", true);
assert.equal(db.listWatches("event-dated")[0]!.city, "delhi");
assert(db.listWatches("event-dated")[0]!.event_code.startsWith("EV:"));
eventLive = true;
const eventTick = nextTick!; nextTick = undefined; eventTick(); await waitForTick();
assert.equal(deliveries.length, 4);
assert.equal(db.listWatches("event-dated").length, 0);
assert.deepEqual(db.seenDates(db.listWatches("event-subscriber")[0]!.id), ["20270205", "20270206", "20270207"]);
for (const delivery of deliveries.slice(2)) assert(delivery.payload.components[0].toJSON().components[0].url.includes("/events/"));
const repeatEventTick = nextTick!; nextTick = undefined; repeatEventTick(); await waitForTick();
assert.equal(deliveries.length, 4, "event subscription duplicated an alert");
const bookReplies: string[] = [];
const bookInteraction = (user: string, guildId: string | null) => ({ commandName: "book", user: { id: user }, guildId, options: { getString: () => "help" }, isModalSubmit: () => false, isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true, deferred: false, replied: false,
  reply: async (v: any) => bookReplies.push(v.content), deferReply: async () => {}, editReply: async (v: any) => bookReplies.push(v.content) });
await handlers.get("interactionCreate")!(bookInteraction("12345", "guild"));
assert(bookReplies.pop()!.includes("private DM"));
await handlers.get("interactionCreate")!(bookInteraction("67890", null));
assert(bookReplies.pop()!.includes("configured owner"));
await handlers.get("interactionCreate")!(bookInteraction("12345", null));
assert(bookReplies.pop()!.includes("District booking (private DMs only)"));
console.log("District bot flow passed: create, filter, retry, deliver, deduplicate");
