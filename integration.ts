/**
 * 3-Layer Live Production & Bot Contract E2E Suite (`bun integration.ts`).
 * Layer 1: Live BookMyShow (`safari_ios_17_0`) · Layer 2: Live District Movies + Events
 * Layer 3: Full Bot E2E (isolated temp SQLite + `last_cycle.json` + Discord `@me` check)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tls from "node-tls-client";
import { closeBms, initBms, parseMovieTitle, resolveClientIdentifier } from "./src/bms.ts";
import { buildCommands, commandSuggestions } from "./src/commands.ts";
import { fetchDistrictEvent } from "./src/district-events.ts";
import * as prov from "./src/providers.ts";
import { todayIST } from "./src/time-filter.ts";

type Item = { name: string; ok: boolean; detail: string };
type Btn = { label?: string; custom_id?: string; url?: string; components?: Btn[] };
type Emb = { title?: string; description?: string; fields?: { name: string; value: string }[] };
type Msg = { content?: string; embeds?: { toJSON(): Emb }[]; components?: { toJSON(): Btn }[] };
type AutoChoice = { name: string; value: string | number };

function validPayload(raw: unknown): boolean {
  if (typeof raw === "string") return raw.length <= 2000;
  if (!raw || typeof raw !== "object") return false;
  const p = raw as Msg;
  if ((p.content?.length ?? 0) > 2000 || (p.components?.length ?? 0) > 5) return false;
  for (const row of p.components ?? []) {
    const b = row.toJSON().components ?? [];
    if (b.length < 1 || b.length > 5 || b.some((x) => (x.label?.length ?? 0) > 80)) return false;
  }
  for (const emb of p.embeds ?? []) {
    const j = emb.toJSON();
    const f = j.fields ?? [];
    if ((j.title?.length ?? 0) > 256 || (j.description?.length ?? 0) > 4096) return false;
    if (f.length > 25 || f.some((x) => x.name.length > 256 || x.value.length > 1024)) return false;
  }
  return true;
}

async function errKind(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return e instanceof prov.BmsError ? e.kind : String(e);
  }
}

async function runLayer3Worker(): Promise<Item[]> {
  const out: Item[] = [];
  const rec = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const { mock } = await import("bun:test");
  const discord = await import("discord.js");
  const handlers = new Map<string, (arg: unknown) => Promise<void> | void>();
  const dms: Msg[] = [];
  const seen: unknown[] = [];
  const noop = async () => {};
  let nextTick: (() => void) | undefined;
  const origTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
    if (ms !== 600_000) return origTimeout(fn, ms, ...a);
    nextTick = () => fn(...a);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const sendDm = async (p: Msg) => void (seen.push(p) && dms.push(p));
  class FakeClient {
    user = { tag: "SeatSniper-e2e" };
    ws = { status: discord.Status.Ready };
    users = { fetch: async () => ({ send: sendDm }) };
    channels = { fetch: async () => null };
    on = (ev: string, fn: (arg: unknown) => Promise<void> | void) => void handlers.set(ev, fn);
    once = (ev: string, fn: (arg: unknown) => Promise<void> | void) => void handlers.set(ev, fn);
    login = async () => "ok";
    destroy = noop;
  }
  let imaxLive = false;
  let bmsCalls = 0;
  const chip =
    '{"type":"chip","title":"IMAX 3D","cta":{"type":"formatSelector","analytics":{"event_code":"ET00509999"},"additionalData":{"eventUrl":"sp-imax"}}}';
  const bmsHtml = (s: string, c = "{}", d: string[] = []) =>
    `<html><head><title>Spider-Man Movie Showtimes in Mumbai</title></head><body><script>window.__INITIAL_STATE__=${c}${d.map((x) => `,"dateCode":"${x}"`).join("")};</script>${s ? `showtimesSections "type":"venue-card","venueCode":"PVRM","venueName":"PVR Icon" ${s}` : ""}</body></html>`;
  const mkS = (id: string, dt: string, tm: string, lbl: string, fmt: string, pr: string) =>
    `"additionalData":{"sessionId":"${id}","availStatus":"3","showDateCode":"${dt}","showDateTime":"${dt}${tm}","showTimeCode":"${tm}","showTime":"${lbl}","attributes":"${fmt}"},"categories":[{"priceDesc":"STD","curPrice":"${pr}","availStatus":"3"}]`;
  const sBase = `${mkS("10", "20261114", "1000", "10:00 AM", "2D", "350")} ${mkS("11", "20261115", "1830", "06:30 PM", "2D", "350")}`;
  const sImax = mkS("12", "20261218", "2000", "08:00 PM", "IMAX 3D", "650");
  mock.module("discord.js", () => ({ ...discord, Client: FakeClient }));
  mock.module("node-tls-client", () => ({
    ClientIdentifier: { safari_ios_17_0: "safari_17" },
    initTLS: noop,
    destroyTLS: noop,
    Session: class {
      close = noop;
      async get(url: string) {
        bmsCalls++;
        let body = bmsHtml(sBase, "{}", ["20261114", "20261115"]);
        if (url.includes("/ET00440000/")) body = bmsHtml("", chip);
        else if (url.includes("/ET00509999/")) {
          body = bmsHtml(imaxLive ? sImax : "", "{}", imaxLive ? ["20261218"] : []);
        }
        return { status: 200, text: async () => body };
      }
    },
  }));
  let dmLive = false;
  let deLive = false;
  const fix = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const dmFix = fix("./src/fixtures/district/movie.html");
  const deFix = fix("./src/fixtures/district/event-live.html");
  const deBody = () => (deLive ? deFix : deFix.replaceAll("BOOK_TICKETS", "LOGIN"));
  const dmBody = () =>
    dmLive ? dmFix : dmFix.replaceAll('"disableClick": false', '"disableClick": true');
  globalThis.fetch = (async (u: string | URL | Request) =>
    new Response(String(u).includes("/events/") ? deBody() : dmBody())) as unknown as typeof fetch;
  Date.now = () => Date.parse("2026-11-14T12:00:00Z");
  Object.assign(process.env, { DISCORD_TOKEN: "e2e", POLL_INTERVAL_SEC: "600" });
  Object.assign(process.env, { STAGGER_MS_MIN: "0", STAGGER_MS_MAX: "0" });
  delete process.env.UPTIME_KUMA_PUSH_URL;
  await import("./src/index.ts");
  const db = await import("./src/db.ts");
  const onInt = handlers.get("interactionCreate")!;
  const falsy = () => false;
  const baseInt = { isAutocomplete: falsy, isButton: falsy, isChatInputCommand: falsy };
  const cmds = buildCommands();
  const cmdOk = cmds.length === 4 && cmds.every((c) => c.description.length <= 100);
  rec("Slash command schemas fit Discord limits", cmdOk, cmds.map((c) => c.name).join(","));
  const autos = ["date:", "date:fri", "format:im", "after:6pm"].map((q) => {
    const [name = "", value = ""] = q.split(":");
    return commandSuggestions("watch", { name, value });
  });
  const autoOk =
    autos.every((l) => l.length > 0 && l.length <= 25 && l.every((c) => c.name.length <= 100)) &&
    autos[3]!.some((c) => c.value === "18:00");
  rec("Autocomplete presets (date/format/6pm) valid", autoOk, "<=25 choices & <=100 chars");
  const runCmd = async (name: string, opts: Record<string, unknown>, u = "u1") => {
    const res: unknown[] = [];
    const push = async (v: unknown) => void (seen.push(v) && res.push(v));
    const str = (k: string) => (typeof opts[k] === "string" ? opts[k] : null);
    const num = (k: string) => (typeof opts[k] === "number" ? opts[k] : null);
    const bool = (k: string) => (typeof opts[k] === "boolean" ? opts[k] : null);
    const options = { getString: str, getInteger: num, getNumber: num, getBoolean: bool };
    const meta = { commandName: name, user: { id: u }, channelId: "ch", options };
    const io = { deferred: name === "watch", replied: false, deferReply: noop };
    const rw = { isChatInputCommand: () => true, reply: push, editReply: push };
    await onInt({ ...baseInt, ...meta, ...io, ...rw });
    return res;
  };
  const helpRes = await runCmd("help", {});
  rec("/help command & embed payload", validPayload(helpRes[0]), "ephemeral help embed");
  const bmsU = "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00400001";
  const saleOpts = { link: bmsU, date: "tomorrow", after: "6pm", budget: 500 };
  const sale = await runCmd("watch", saleOpts, "ub");
  const sErr = await runCmd("watch", { link: bmsU, date: "fri", seats: 2 }, "ub");
  await runCmd("watch", { link: bmsU, date: "today" }, "ub");
  await runCmd("watch", { link: bmsU, date: "fri", after: "6pm", budget: 300 }, "ub");
  const bw = db.listWatches("ub");
  const hasFri = bw.some((w) => w.date === "20261120" && w.seat_budget === 300);
  const saleOk = JSON.stringify(sale).includes("on sale") && String(sErr[0]).includes("District");
  const bmsOk = saleOk && bw.length === 2 && bw.some((w) => w.date === "20261114") && hasFri;
  rec("/watch natural dates + 6pm + BMS budget/seats", bmsOk, "today/tmrw/fri + ₹300 + guard");
  const pre = bmsCalls;
  const dup = (await runCmd("watch", { link: bmsU, date: "2026-11-20" }, "ub"))[0] as Msg;
  const dupId = dup.components?.[0]?.toJSON().components?.[0]?.custom_id ?? "";
  const dupOk = bmsCalls === pre && dupId.startsWith("seatsniper:stop:");
  rec("Duplicate /watch button reply", dupOk && validPayload(dup), dupId);
  const list = (await runCmd("list", {}, "ub"))[0] as Msg;
  const desc = list.embeds?.[0]?.toJSON().description ?? "";
  const btns = (list.components ?? []).flatMap((r) => r.toJSON().components ?? []);
  const listOk = desc.includes("](https://") && btns.some((b) => b.custom_id?.endsWith(":all"));
  rec("/list links + stop buttons", listOk && validPayload(list), `${btns.length} buttons`);
  const stopAuto: AutoChoice[] = [];
  const respond = async (items: AutoChoice[]) => void stopAuto.push(...items);
  const sOpt = { getFocused: () => ({ name: "id", value: "" }) };
  const sAuto = { isAutocomplete: () => true, commandName: "stop", user: { id: "ub" } };
  await onInt({ ...baseInt, ...sAuto, options: sOpt, respond });
  const btnLog: string[] = [];
  const onBtn = async (v: { content: string }) => void btnLog.push(v.content);
  const click = (customId: string, id: string) =>
    onInt({ ...baseInt, isButton: () => true, customId, user: { id }, reply: onBtn });
  await click(`seatsniper:stop:${bw[0]!.id}`, "intruder");
  const blocked =
    btnLog.at(-1)?.includes("isn't yours") === true && db.listWatches("ub").length === 2;
  await click(`seatsniper:stop:${bw[0]!.id}`, "ub");
  const oneLeft = db.listWatches("ub").length === 1;
  await click("seatsniper:stop:all", "ub");
  const stopOk = stopAuto.length === 2 && blocked && oneLeft && db.listWatches("ub").length === 0;
  rec("/stop autocomplete + owner check + stop:all", stopOk, "owner-only + stop:all");
  const dmU = "https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276";
  const deU =
    "https://www.district.in/events/samay-raina-live-delhi-yashobhoomi-6a9bfcb5d4d3d3abd96591c9-2026-buy-tickets";
  const ixU = "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00440000";
  const specs: [string, string, string, Record<string, string | number>][] = [
    ["dm1", dmU, "2026-11-15", { seats: 2, budget: 400 }],
    ["dms", dmU, "any", { seats: 2, budget: 400 }],
    ["de1", deU, "2027-02-05", { theatre: "Yashobhoomi" }],
    ["des", deU, "any", {}],
    ["ix1", ixU, "2026-12-18", { format: "IMAX" }],
    ["ixs", ixU, "any", { format: "IMAX" }],
  ];
  for (const [u, link, date, ex] of specs) await runCmd("watch", { link, date, ...ex }, u);
  dmLive = true;
  deLive = true;
  imaxLive = true;
  handlers.get("clientReady")!({ user: { tag: "e2e" } });
  for (let i = 0; i < 1000 && !nextTick; i++) await Bun.sleep(2);
  const live = JSON.parse(readFileSync(process.env.LIVENESS_PATH!, "utf8")) as { ok?: boolean };
  const pollOk =
    dms.length === 6 &&
    ["dm1", "de1", "ix1"].every((u) => db.listWatches(u).length === 0) &&
    db.seenDates(db.listWatches("ixs")[0]!.id).includes("20261218") &&
    live.ok === true &&
    seen.every(validPayload);
  rec("Poll cycle: District + child-IMAX + liveness", pollOk, `6 DMs, ${seen.length} valid`);
  db.closeDb();
  return out;
}

if (process.env.SEATSNIPER_E2E_WORKER === "1") {
  console.log(`__E2E_JSON__${JSON.stringify(await runLayer3Worker())}`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
let step = 0;
function check(name: string, ok: boolean, detail: string) {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${String(++step).padStart(2)}. ${tag}  ${name.padEnd(45)} ${detail}`);
  if (ok) pass++;
  else fail++;
}

console.log("=== Layer 1: Live BookMyShow Production E2E (safari_ios_17_0) ===");
await initBms();
const today = todayIST();
const explore = new tls.Session({ clientIdentifier: resolveClientIdentifier(), timeout: 30_000 });
const pool = new Map<string, string>();
for (const p of ["movies-mumbai", "upcoming-movies-mumbai"]) {
  const html = await (await explore.get(`https://in.bookmyshow.com/explore/${p}`)).text();
  for (const m of [...html.matchAll(/\/mumbai\/movies\/([a-z0-9-]+)\/(ET\d{6,})/gi)].slice(0, 6)) {
    const et = m[2]!.toUpperCase();
    if (!pool.has(et)) pool.set(et, m[1]!.toLowerCase());
  }
}
pool.set("ET00451914", "ramayana");
pool.set("ET00526285", "adrishyya");
await explore.close();
type BmsHit = { slug: string; eventCode: string; title: string; dates: string[] };
let openBms: BmsHit | null = null;
let soonBms: BmsHit | null = null;
for (const [eventCode, slug] of pool) {
  const r = await prov.fetchBookableDates({ city: "mumbai", slug, eventCode });
  if (!openBms && r.dates.length) openBms = { slug, eventCode, title: r.title, dates: r.dates };
  if (!soonBms && !r.dates.length) soonBms = { slug, eventCode, title: r.title, dates: r.dates };
  if (openBms && soonBms) break;
  await Bun.sleep(500);
}
const bmsOk = Boolean(openBms?.dates.every((d) => d >= today));
const bmsNote = openBms
  ? `${openBms.title} (${openBms.eventCode}) · ${openBms.dates.length}d`
  : "none";
check("BMS dynamic open movie & future IST dates", bmsOk, bmsNote);
if (openBms) {
  const d0 = openBms.dates[0]!;
  const base = { city: "mumbai", slug: openBms.slug, eventCode: openBms.eventCode };
  const countOn = async (t: prov.Target) =>
    prov.showsOnDate((await prov.fetchShowtimes(t)).shows, t.date).length;
  const mum = await countOn({ ...base, date: d0 });
  check("BMS fetchShowtimes on open date > 0", mum > 0, `${mum} Mumbai shows on ${d0}`);
  await Bun.sleep(600);
  const far = await countOn({ ...base, date: "20291231" });
  check("BMS far-future 20291231 returns 0 on date", far === 0, `${far} shows on 20291231`);
  await Bun.sleep(600);
  const counts: Record<string, number> = { mumbai: mum };
  for (const city of ["delhi", "bengaluru"]) {
    counts[city] = await countOn({ ...base, city, date: d0 });
    await Bun.sleep(600);
    if (counts[city] !== mum) break;
  }
  const multiCity = new Set(Object.values(counts)).size > 1;
  check("BMS city switch changes show count", multiCity, JSON.stringify(counts));
  const wrong = await countOn({ ...base, slug: "wrong-slug", date: d0 });
  check("BMS wrong slug returns identical show count", wrong === mum, `${wrong} vs ${mum}`);
  await Bun.sleep(600);
}
const bogus = await errKind(() =>
  prov.fetchShowtimes({ city: "mumbai", slug: "x", eventCode: "ET99999999", date: today }),
);
check('BMS ET99999999 throws BmsError("not_found")', bogus === "not_found", bogus || "no throw");
const soonNote = soonBms ? `${soonBms.title} (${soonBms.eventCode})` : "none";
check("BMS coming-soon returns [] (0 phantom today)", soonBms?.dates.length === 0, soonNote);
const pre = prov.parseWatchUrl("https://in.bookmyshow.com/mumbai/movies/doomsday/ET00439706");
const wrap = prov.parseWatchUrl(
  "<https://in.bookmyshow.com/movies/mumbai/x/buytickets/ET00451914/20261120?ref=20991231>",
);
const badKind = await errKind(() =>
  prov.parseWatchUrl("https://in.bookmyshow.com/buytickets/cinema/ET00451914/20261120"),
);
const titleOk =
  parseMovieTitle("<title>Tom &amp; Jerry Movie Showtimes in Mumbai</title>") === "Tom & Jerry";
const urlOk =
  pre.city === "mumbai" && !pre.date && wrap.date === "20261120" && badKind === "bad_url";
check("BMS pre-sale URL + <url> + title/host guards", urlOk && titleOk, "pre-sale, <url>, bad_url");

console.log("\n=== Layer 2: Live District Production E2E (Movies + Events) ===");
const dmHtml = await (await fetch("https://www.district.in/movies/")).text();
const dmRe = /\/movies\/[a-z0-9-]+-movie-tickets-in-[a-z0-9-]+-MV\d+/gi;
const dmFallback = "https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276";
const dmUrls = new Set([...dmHtml.matchAll(dmRe)].map((m) => `https://www.district.in${m[0]}`));
dmUrls.add(dmFallback);
type DmHit = { parsed: Omit<prov.Target, "date">; title: string; dates: string[]; v: number };
let liveDm: DmHit | null = null;
for (const u of [...dmUrls].slice(0, 8)) {
  try {
    const parsed = prov.parseWatchUrl(u);
    const d = await prov.fetchBookableDates(parsed);
    if (d.dates.length > 0) {
      liveDm = { parsed, title: d.title, dates: d.dates, v: d.venues?.length ?? 0 };
      break;
    }
  } catch {}
}
const dmOk = Boolean(liveDm?.dates.every((d) => d >= today) && liveDm.v > 0);
const dmNote = liveDm ? `${liveDm.title} (${liveDm.dates.length}d, ${liveDm.v}v)` : "none";
check("District live movie fetchBookableDates", dmOk, dmNote);
if (liveDm) {
  const sh = await prov.fetchShowtimes({ ...liveDm.parsed, date: liveDm.dates[0]! });
  const hasCat = (s: prov.Show) =>
    Boolean(s.ticketCategories?.length && s.ticketCategories.every((c) => c.price > 0));
  const cats = sh.shows.filter(hasCat);
  const dmShNote = `${sh.shows.length} shows, ₹${cats[0]?.ticketCategories?.[0]?.price ?? 0}`;
  check("District live movie fetchShowtimes + prices", cats.length > 0, dmShNote);
}
const deHtml = await (await fetch("https://www.district.in/events/")).text();
const deSlugs = new Set(
  [...deHtml.matchAll(/\/events\/([a-z0-9-]+)-buy-tickets/gi)].map((m) => m[1]!.toLowerCase()),
);
deSlugs.add("rolling-loud-india-2026");
deSlugs.add("gorillaz-the-mountain-tour-mumbai-2027");
let liveDe: { slug: string; title: string; city: string; shows: number } | null = null;
for (const slug of [...deSlugs].slice(0, 12)) {
  try {
    const ev = await fetchDistrictEvent({ slug });
    if (ev.dates.length > 0 && ev.shows.length > 0) {
      liveDe = { slug, title: ev.title, city: ev.city, shows: ev.shows.length };
      break;
    }
  } catch {}
}
const evSlug = liveDe?.slug ?? "rolling-loud-india-2026";
const evCode = prov.parseWatchUrl(`https://www.district.in/events/${evSlug}-buy-tickets`).eventCode;
const deNote = liveDe ? `${liveDe.title} (${liveDe.city}, ${liveDe.shows} shows)` : "none";
check(
  "District live event fetchDistrictEvent",
  Boolean(liveDe && evCode.startsWith("EV:")),
  deNote,
);

console.log("\n=== Layer 3: Full Bot Feature & Discord Contract E2E ===");
const tempDir = mkdtempSync(join(tmpdir(), "seatsniper-live-e2e-"));
try {
  const env = {
    ...process.env,
    SEATSNIPER_E2E_WORKER: "1",
    DB_PATH: join(tempDir, "e.db"),
    LIVENESS_PATH: join(tempDir, "l.json"),
  };
  const self = [process.execPath, fileURLToPath(import.meta.url)];
  const proc = Bun.spawn(self, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const line =
    (await proc.exited) === 0 ? out.split("\n").find((l) => l.startsWith("__E2E_JSON__")) : "";
  if (!line) check("Bot isolated worker execution", false, err.trim().slice(0, 160));
  else for (const it of JSON.parse(line.slice(12)) as Item[]) check(it.name, it.ok, it.detail);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
check("Temp SQLite & last_cycle.json cleaned up", !existsSync(tempDir), "0 temp files left");
const tok = process.env.DISCORD_TOKEN?.trim();
if (tok) {
  const me = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
    headers: { Authorization: `Bot ${tok}` },
    signal: AbortSignal.timeout(15_000),
  });
  const app = (await me.json()) as { id?: string; name?: string };
  const meNote = `HTTP ${me.status} · ${app.name ?? "?"} (${app.id ?? "?"})`;
  check("Discord GET /oauth2/applications/@me", me.status === 200 && Boolean(app.id), meNote);
} else {
  check("Discord GET /oauth2/applications/@me (skipped)", true, "DISCORD_TOKEN unset");
}
console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
await closeBms();
process.exit(fail > 0 ? 1 : 0);
