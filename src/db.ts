/** Storage. bun:sqlite ships with the runtime — no dependency, no native build. */
import { Database } from "bun:sqlite";

export type Watch = {
  id: number;
  provider: "bms" | "district";
  user_id: string;
  channel_id: string;
  city: string;
  slug: string;
  event_code: string;
  date: string; // YYYYMMDD
  title: string; // display name, best-effort from the slug
  fail_count: number;
  last_ok_at: number | null;
  last_error: string | null;
  created_at: number;
  format_filter: string | null;
  day_filter: string | null;
  after_filter: string | null;
  before_filter: string | null;
  theatre_filter: string | null;
  seat_count?: number | null;
  seat_budget?: number | null;
};

export type NewWatch = Omit<
  Watch,
  | "provider"
  | "id"
  | "fail_count"
  | "last_ok_at"
  | "last_error"
  | "created_at"
  | "format_filter"
  | "day_filter"
  | "after_filter"
  | "before_filter"
  | "theatre_filter"
> & {
  provider?: "bms" | "district";
  format_filter?: string | null;
  day_filter?: string | null;
  after_filter?: string | null;
  before_filter?: string | null;
  theatre_filter?: string | null;
};

export const DB_PATH = process.env.DB_PATH?.trim() || "seatsniper.db";

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
// SQLite ignores REFERENCES clauses unless enabled per connection; without it,
// deleting a watch leaves its seen_dates and seen_venues rows orphaned.
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA synchronous = NORMAL");

db.run(`
  CREATE TABLE IF NOT EXISTS watches (
    id          INTEGER PRIMARY KEY,
    user_id     TEXT    NOT NULL,
    channel_id  TEXT    NOT NULL,
    city        TEXT    NOT NULL,
    slug        TEXT    NOT NULL,
    event_code  TEXT    NOT NULL,
    date        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    fail_count  INTEGER NOT NULL DEFAULT 0,
    last_ok_at  INTEGER,
    last_error  TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (user_id, event_code, date)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS seen_dates (
    watch_id  INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    date_code TEXT    NOT NULL,
    PRIMARY KEY (watch_id, date_code)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS seen_venues (
    watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    venue_code  TEXT    NOT NULL,
    PRIMARY KEY (watch_id, venue_code)
  )
`);

function addWatchColumnsIfMissing(columns: readonly string[]): void {
  for (const col of columns) {
    try {
      db.run(`ALTER TABLE watches ADD COLUMN ${col}`);
    } catch {}
  }
}

addWatchColumnsIfMissing([
  "format_filter TEXT",
  "day_filter TEXT",
  "after_filter TEXT",
  "before_filter TEXT",
  "theatre_filter TEXT",
]);

// Preserve existing IDs and notification ledgers while making provider/city part of identity.
const schemaRow = db.query("SELECT sql FROM sqlite_master WHERE name = 'watches'").get() as {
  sql: string;
} | null;
const schema = schemaRow?.sql ?? "";
if (schema && !schema.includes("provider")) {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const migratedSql = schema
        .replace(/CREATE TABLE watches/i, "CREATE TABLE watches_provider_migration")
        .replace(
          "UNIQUE (user_id, event_code, date)",
          "provider TEXT NOT NULL DEFAULT 'bms' CHECK(provider IN ('bms', 'district')), UNIQUE (user_id, provider, city, event_code, date)",
        );
      db.run(migratedSql);
      db.run("INSERT INTO watches_provider_migration SELECT *, 'bms' FROM watches");
      db.run("DROP TABLE watches");
      db.run("ALTER TABLE watches_provider_migration RENAME TO watches");
    }).immediate();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

addWatchColumnsIfMissing([
  "seat_count INTEGER",
  "seat_budget REAL",
  "venues_seeded INTEGER NOT NULL DEFAULT 0",
]);

const now = () => Math.floor(Date.now() / 1000);

export const MAX_WATCHES_PER_USER = 5;

function insertWatch(w: NewWatch, venuesSeeded = 0): number {
  const r = db
    .query(
      `INSERT INTO watches (
         user_id, channel_id, city, slug, event_code, date, title, created_at,
         format_filter, day_filter, after_filter, before_filter, theatre_filter,
         provider, seat_count, seat_budget, venues_seeded
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      w.user_id,
      w.channel_id,
      w.city,
      w.slug,
      w.event_code,
      w.date,
      w.title,
      now(),
      w.format_filter ?? null,
      w.day_filter ?? null,
      w.after_filter ?? null,
      w.before_filter ?? null,
      w.theatre_filter ?? null,
      w.provider ?? "bms",
      w.seat_count ?? null,
      w.seat_budget ?? null,
      venuesSeeded,
    ) as { id: number };
  return r.id;
}

function insertSeenDatesRows(watchId: number, dates: string[]): void {
  if (!dates.length) return;
  const q = db.query("INSERT OR IGNORE INTO seen_dates (watch_id, date_code) VALUES (?, ?)");
  for (const d of dates) q.run(watchId, d);
}

function insertSeenVenuesRows(watchId: number, codes: string[]): void {
  if (!codes.length) return;
  const q = db.query("INSERT OR IGNORE INTO seen_venues (watch_id, venue_code) VALUES (?, ?)");
  for (const c of codes) q.run(watchId, c);
}

export function addWatch(w: NewWatch): number | null {
  try {
    return insertWatch(w);
  } catch {
    return null;
  }
}

const addSubscriptionTx = db.transaction(
  (w: NewWatch, dates: string[], venues: string[] | null): number => {
    const id = insertWatch({ ...w, date: SUBSCRIPTION }, venues !== null ? 1 : 0);
    insertSeenDatesRows(id, dates);
    if (venues) insertSeenVenuesRows(id, venues);
    return id;
  },
);

/** Atomically create a subscription watch and seed its baseline dates and venues. */
export function addSubscription(
  w: NewWatch,
  dates: string[],
  venues: string[] | null,
): number | null {
  try {
    return addSubscriptionTx.immediate(w, dates, venues);
  } catch {
    return null;
  }
}

export const findWatch = (
  userId: string,
  provider: "bms" | "district",
  city: string,
  eventCode: string,
  date: string,
): Watch | null =>
  (db
    .query(
      "SELECT * FROM watches WHERE user_id = ? AND provider = ? AND city = ? AND event_code = ? AND date = ?",
    )
    .get(userId, provider, city, eventCode, date) as Watch | null) ?? null;

export const getWatchById = (id: number): Watch | null =>
  (db.query("SELECT * FROM watches WHERE id = ?").get(id) as Watch | null) ?? null;

export const listWatches = (userId: string) =>
  db.query("SELECT * FROM watches WHERE user_id = ? ORDER BY id").all(userId) as Watch[];

export const allWatches = () => db.query("SELECT * FROM watches ORDER BY id").all() as Watch[];

export const countWatches = (userId: string) =>
  (db.query("SELECT COUNT(*) n FROM watches WHERE user_id = ?").get(userId) as { n: number }).n;

export const removeWatch = (id: number, userId: string) =>
  db.query("DELETE FROM watches WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;

export const removeAllWatches = (userId: string): number =>
  (db.query("DELETE FROM watches WHERE user_id = ? RETURNING id").all(userId) as { id: number }[])
    .length;

export const markOk = (id: number) =>
  db
    .query("UPDATE watches SET fail_count = 0, last_ok_at = ?, last_error = NULL WHERE id = ?")
    .run(now(), id);

export const markFail = (id: number, err: string) =>
  db
    .query("UPDATE watches SET fail_count = fail_count + 1, last_error = ? WHERE id = ?")
    .run(err, id);

/** A watch with an empty date is a subscription: tell me whenever a NEW date opens. */
export const SUBSCRIPTION = "";
export const isSubscription = (w: Watch) => w.date === SUBSCRIPTION;

export const seenDates = (watchId: number) =>
  (
    db.query("SELECT date_code FROM seen_dates WHERE watch_id = ?").all(watchId) as {
      date_code: string;
    }[]
  ).map((r) => r.date_code);

const recordSeenDatesTx = db.transaction((watchId: number, dates: string[]) => {
  insertSeenDatesRows(watchId, dates);
});

export function recordSeenDates(watchId: number, dates: string[]): void {
  if (!dates.length) return;
  recordSeenDatesTx.immediate(watchId, dates);
}

export const seenVenues = (watchId: number) =>
  (
    db.query("SELECT venue_code FROM seen_venues WHERE watch_id = ?").all(watchId) as {
      venue_code: string;
    }[]
  ).map((r) => r.venue_code);

const recordSeenVenuesTx = db.transaction((watchId: number, codes: string[]) => {
  insertSeenVenuesRows(watchId, codes);
  db.query("UPDATE watches SET venues_seeded = 1 WHERE id = ?").run(watchId);
});

export function recordSeenVenues(watchId: number, codes: string[]): void {
  if (!codes.length) return;
  recordSeenVenuesTx.immediate(watchId, codes);
}

export function shouldSilentSeedVenues(watchId: number): boolean {
  const row = db.query("SELECT venues_seeded FROM watches WHERE id = ?").get(watchId) as {
    venues_seeded: number;
  } | null;
  if (!row || row.venues_seeded === 1) return false;
  if (seenVenues(watchId).length) return false;
  return seenDates(watchId).length > 0;
}

/** Checkpoint WAL and release SQLite connection cleanly on shutdown. */
export function closeDb(): void {
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {}
  db.close(false);
}
