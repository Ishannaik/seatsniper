import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "seatsniper-db-"));
const dbPath = join(tempDir, "test.db");

let addWatch: typeof import("./db.ts").addWatch;
let addSubscription: typeof import("./db.ts").addSubscription;
let findWatch: typeof import("./db.ts").findWatch;
let getWatchById: typeof import("./db.ts").getWatchById;
let listWatches: typeof import("./db.ts").listWatches;
let countWatches: typeof import("./db.ts").countWatches;
let seenVenues: typeof import("./db.ts").seenVenues;
let recordSeenVenues: typeof import("./db.ts").recordSeenVenues;
let recordSeenDates: typeof import("./db.ts").recordSeenDates;
let shouldSilentSeedVenues: typeof import("./db.ts").shouldSilentSeedVenues;
let removeWatch: typeof import("./db.ts").removeWatch;
let removeAllWatches: typeof import("./db.ts").removeAllWatches;
let seenDates: typeof import("./db.ts").seenDates;
let closeDb: typeof import("./db.ts").closeDb;

beforeAll(async () => {
  process.env.DB_PATH = dbPath;
  const mod = await import("./db.ts");
  addWatch = mod.addWatch;
  addSubscription = mod.addSubscription;
  findWatch = mod.findWatch;
  getWatchById = mod.getWatchById;
  listWatches = mod.listWatches;
  countWatches = mod.countWatches;
  seenVenues = mod.seenVenues;
  recordSeenVenues = mod.recordSeenVenues;
  recordSeenDates = mod.recordSeenDates;
  shouldSilentSeedVenues = mod.shouldSilentSeedVenues;
  removeWatch = mod.removeWatch;
  removeAllWatches = mod.removeAllWatches;
  seenDates = mod.seenDates;
  closeDb = mod.closeDb;
});

beforeEach(() => {
  const db = new Database(dbPath);
  db.run("DELETE FROM seen_venues");
  db.run("DELETE FROM seen_dates");
  db.run("DELETE FROM watches");
  db.close();
});

afterAll(() => {
  try {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
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

test("shouldSilentSeedVenues distinguishes legacy date-only subscriptions from seeded or empty ones", () => {
  const id = addSubscriptionWatch();
  expect(shouldSilentSeedVenues(id)).toBe(false);

  recordSeenDates(id, ["20260730"]);
  expect(shouldSilentSeedVenues(id)).toBe(true);

  recordSeenVenues(id, ["MCIW", "IMOB"]);
  expect([...seenVenues(id)].sort()).toEqual(["IMOB", "MCIW"]);
  expect(shouldSilentSeedVenues(id)).toBe(false);
});

test("removeWatch rejects cross-user deletes and cascades seen_dates and seen_venues on owner delete", () => {
  const id = addSubscriptionWatch();
  const otherId = addWatchFor("user-b", "EVENT-B1");
  recordSeenDates(id, ["20260730", "20260731"]);
  recordSeenVenues(id, ["MCIW"]);

  expect(removeWatch(id, "user-b")).toBe(false);
  expect(seenDates(id)).toHaveLength(2);
  expect(seenVenues(id)).toEqual(["MCIW"]);

  expect(removeWatch(id, "u1")).toBe(true);
  expect(seenDates(id)).toEqual([]);
  expect(seenVenues(id)).toEqual([]);
  expect(listWatches("user-b").map((w) => w.id)).toEqual([otherId]);
});

test("countWatches and listWatches isolate each user and preserve optional filter columns", () => {
  const a1 = addWatch({
    user_id: "user-a",
    channel_id: "c1",
    city: "mumbai",
    slug: "test-movie",
    event_code: "ET-THEATRE",
    date: "20260730",
    title: "Test Movie",
    theatre_filter: "PVR,INOX",
  });
  const a2 = addWatchFor("user-a", "EVENT-A2");
  addWatchFor("user-b", "EVENT-B1");

  expect(countWatches("user-a")).toBe(2);
  expect(countWatches("user-b")).toBe(1);
  expect(countWatches("missing-user")).toBe(0);

  const watches = listWatches("user-a");
  expect(watches.map((w) => w.id)).toEqual([a1!, a2]);
  expect(watches[0]?.theatre_filter).toBe("PVR,INOX");
  expect(watches[1]?.theatre_filter).toBeNull();
});

test("provider and city are part of watch identity", () => {
  const base = {
    user_id: "u",
    channel_id: "c",
    city: "mumbai",
    slug: "movie",
    event_code: "MV176276",
    date: "",
    title: "Movie",
  };
  const district = addWatch({ ...base, provider: "district" });
  expect(district).not.toBeNull();
  expect(addWatch({ ...base, provider: "district" })).toBeNull();
  expect(addWatch({ ...base, provider: "district", city: "pune" })).not.toBeNull();
  expect(addWatch({ ...base, provider: "bms" })).not.toBeNull();
  expect(listWatches("u").find((w) => w.id === district)?.provider).toBe("district");
});

test("addSubscription atomically creates watch and seeds baseline dates and venues", () => {
  const base = {
    user_id: "u-sub",
    channel_id: "c1",
    city: "mumbai",
    slug: "atomic-movie",
    event_code: "ET999001",
    date: "",
    title: "Atomic Movie",
  };
  const id = addSubscription(base, ["20261118", "20261119"], ["PVRM", "INOX"]);
  expect(id).not.toBeNull();
  expect([...seenDates(id!)].sort()).toEqual(["20261118", "20261119"]);
  expect([...seenVenues(id!)].sort()).toEqual(["INOX", "PVRM"]);

  expect(addSubscription(base, ["20261125"], ["OTHER"])).toBeNull();
  expect([...seenDates(id!)].sort()).toEqual(["20261118", "20261119"]);
  expect([...seenVenues(id!)].sort()).toEqual(["INOX", "PVRM"]);
});

test("findWatch, getWatchById, and removeAllWatches scope strictly by user and cascade ledgers", () => {
  const a1 = addSubscription(
    {
      user_id: "u-bulk",
      channel_id: "c1",
      city: "mumbai",
      slug: "m1",
      event_code: "ET100001",
      date: "",
      title: "Movie One",
      format_filter: "IMAX",
    },
    ["20261120"],
    ["PVRM"],
  );
  const a2 = addWatchFor("u-bulk", "ET100002");
  const other = addWatchFor("u-other", "ET100003");
  expect(a1).not.toBeNull();

  expect(findWatch("u-bulk", "bms", "mumbai", "ET100001", "")?.id).toBe(a1!);
  expect(findWatch("u-bulk", "district", "mumbai", "ET100001", "")).toBeNull();
  expect(getWatchById(a2)?.title).toBe("Movie ET100002");

  expect(removeAllWatches("u-bulk")).toBe(2);
  expect(listWatches("u-bulk")).toEqual([]);
  expect(seenDates(a1!)).toEqual([]);
  expect(seenVenues(a1!)).toEqual([]);
  expect(listWatches("u-other").map((w) => w.id)).toEqual([other]);
});
