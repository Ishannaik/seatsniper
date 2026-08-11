import { expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";

const dbPath = `test-${Date.now()}.db`;

let addWatch: typeof import("./db.ts").addWatch;
let listWatches: typeof import("./db.ts").listWatches;
let countWatches: typeof import("./db.ts").countWatches;
let seenVenues: typeof import("./db.ts").seenVenues;
let recordSeenVenues: typeof import("./db.ts").recordSeenVenues;
let recordSeenDates: typeof import("./db.ts").recordSeenDates;
let shouldSilentSeedVenues: typeof import("./db.ts").shouldSilentSeedVenues;
let removeWatch: typeof import("./db.ts").removeWatch;
let seenDates: typeof import("./db.ts").seenDates;

beforeAll(async () => {
  process.env.DB_PATH = dbPath;
  const mod = await import("./db.ts");
  addWatch = mod.addWatch;
  listWatches = mod.listWatches;
  countWatches = mod.countWatches;
  seenVenues = mod.seenVenues;
  recordSeenVenues = mod.recordSeenVenues;
  recordSeenDates = mod.recordSeenDates;
  shouldSilentSeedVenues = mod.shouldSilentSeedVenues;
  removeWatch = mod.removeWatch;
  seenDates = mod.seenDates;
});

beforeEach(() => {
  const db = new Database(dbPath);
  db.exec("DELETE FROM seen_venues");
  db.exec("DELETE FROM seen_dates");
  db.exec("DELETE FROM watches");
  db.close();
});

afterAll(() => {
  try {
    unlinkSync(dbPath);
    unlinkSync(`${dbPath}-wal`);
    unlinkSync(`${dbPath}-shm`);
  } catch {
    // temp file may already be gone
  }
});

function addSubscriptionWatch(): number {
  const id = addWatch({
    user_id: "u1",
    channel_id: "c1",
    city: "mumbai",
    slug: "test-movie",
    event_code: "ET00480917",
    date: "",
    title: "Test Movie",
  });
  if (id === null) throw new Error("addWatch failed");
  return id;
}

function addWatchFor(userId: string, eventCode: string): number {
  const id = addWatch({
    user_id: userId,
    channel_id: `channel-${userId}`,
    city: "mumbai",
    slug: `movie-${eventCode}`,
    event_code: eventCode,
    date: "20260730",
    title: `Movie ${eventCode}`,
  });
  if (id === null) throw new Error("addWatch failed");
  return id;
}

test("recordSeenVenues then seenVenues round-trips", () => {
  const id = addSubscriptionWatch();
  recordSeenVenues(id, ["MCIW", "IMOB"]);
  expect([...seenVenues(id)].sort()).toEqual(["IMOB", "MCIW"]);
});

test("shouldSilentSeedVenues is true when dates exist but venues empty", () => {
  const id = addSubscriptionWatch();
  recordSeenDates(id, ["20260730"]);
  expect(shouldSilentSeedVenues(id)).toBe(true);
});

test("shouldSilentSeedVenues is false after venues recorded", () => {
  const id = addSubscriptionWatch();
  recordSeenDates(id, ["20260730"]);
  recordSeenVenues(id, ["MCIW"]);
  expect(shouldSilentSeedVenues(id)).toBe(false);
});

test("shouldSilentSeedVenues is false for brand-new sub with no dates yet", () => {
  const id = addSubscriptionWatch();
  expect(shouldSilentSeedVenues(id)).toBe(false);
});

test("removeWatch cascades its seen_dates and seen_venues ledgers", () => {
  const id = addSubscriptionWatch();
  recordSeenDates(id, ["20260730", "20260731"]);
  recordSeenVenues(id, ["MCIW"]);
  expect(seenDates(id)).toHaveLength(2);
  expect(seenVenues(id)).toHaveLength(1);

  expect(removeWatch(id, "u1")).toBe(true);

  // ON DELETE CASCADE only fires with PRAGMA foreign_keys = ON; without it
  // these rows are orphaned and /stop leaks a row per date and venue.
  expect(seenDates(id)).toEqual([]);
  expect(seenVenues(id)).toEqual([]);
});

test("a rejected removeWatch leaves the ledgers intact", () => {
  // removeWatch is scoped by user_id; another user's /stop must not delete
  // anything, cascade included.
  const id = addSubscriptionWatch();
  recordSeenDates(id, ["20260730"]);
  recordSeenVenues(id, ["MCIW"]);

  expect(removeWatch(id, "someone-else")).toBe(false);

  expect(seenDates(id)).toEqual(["20260730"]);
  expect(seenVenues(id)).toEqual(["MCIW"]);
});

test("countWatches counts each user independently", () => {
  addWatchFor("user-a", "EVENT-A1");
  addWatchFor("user-a", "EVENT-A2");
  addWatchFor("user-b", "EVENT-B1");

  expect(countWatches("user-a")).toBe(2);
  expect(countWatches("user-b")).toBe(1);
  expect(countWatches("missing-user")).toBe(0);
});

test("listWatches never returns another user's watches", () => {
  const aId = addWatchFor("user-a", "EVENT-A1");
  addWatchFor("user-b", "EVENT-B1");

  const watches = listWatches("user-a");
  expect(watches).toHaveLength(1);
  expect(watches[0].id).toBe(aId);
  expect(watches[0].user_id).toBe("user-a");
});

test("removeWatch rejects cross-user deletes and allows the owner", () => {
  const aId = addWatchFor("user-a", "EVENT-A1");
  const bId = addWatchFor("user-b", "EVENT-B1");

  expect(removeWatch(bId, "user-a")).toBe(false);
  expect(listWatches("user-b").map((watch) => watch.id)).toEqual([bId]);

  expect(removeWatch(aId, "user-a")).toBe(true);
  expect(listWatches("user-a")).toEqual([]);
});
