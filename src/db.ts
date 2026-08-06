/** Storage. bun:sqlite ships with the runtime — no dependency, no native build. */
import { Database } from "bun:sqlite";

export type Watch = {
  id: number;
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
};

const db = new Database(process.env.DB_PATH ?? "seatsniper.db", { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
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
  );

  -- Which dates a subscription watch (date = '') has already reported. Without
  -- this it would re-announce the same dates every poll.
  CREATE TABLE IF NOT EXISTS seen_dates (
    watch_id  INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    date_code TEXT    NOT NULL,
    PRIMARY KEY (watch_id, date_code)
  );

  CREATE TABLE IF NOT EXISTS seen_venues (
    watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    venue_code  TEXT    NOT NULL,
    PRIMARY KEY (watch_id, venue_code)
  );
`);

// Migration: add filter columns if the table predates them.
try { db.exec("ALTER TABLE watches ADD COLUMN format_filter TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE watches ADD COLUMN day_filter TEXT"); } catch { /* already exists */ }

const now = () => Math.floor(Date.now() / 1000);

export const MAX_WATCHES_PER_USER = 5;

export function addWatch(w: Omit<Watch, "id" | "fail_count" | "last_ok_at" | "last_error" | "created_at" | "format_filter" | "day_filter"> & { format_filter?: string | null; day_filter?: string | null }): number | null {
  try {
    const r = db
      .query(
        `INSERT INTO watches (user_id, channel_id, city, slug, event_code, date, title, created_at, format_filter, day_filter)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(w.user_id, w.channel_id, w.city, w.slug, w.event_code, w.date, w.title, now(), w.format_filter ?? null, w.day_filter ?? null) as { id: number };
    return r.id;
  } catch {
    return null; // UNIQUE violation == already watching this
  }
}

export const listWatches = (userId: string) =>
  db.query("SELECT * FROM watches WHERE user_id = ? ORDER BY id").all(userId) as Watch[];

export const allWatches = () => db.query("SELECT * FROM watches ORDER BY id").all() as Watch[];

export const countWatches = (userId: string) =>
  (db.query("SELECT COUNT(*) n FROM watches WHERE user_id = ?").get(userId) as { n: number }).n;

export const removeWatch = (id: number, userId: string) =>
  db.query("DELETE FROM watches WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;

export const markOk = (id: number) =>
  db.query("UPDATE watches SET fail_count = 0, last_ok_at = ?, last_error = NULL WHERE id = ?").run(now(), id);

export const markFail = (id: number, err: string) =>
  db.query("UPDATE watches SET fail_count = fail_count + 1, last_error = ? WHERE id = ?").run(err, id);

/** A watch with an empty date is a subscription: tell me whenever a NEW date opens. */
export const SUBSCRIPTION = "";
export const isSubscription = (w: Watch) => w.date === SUBSCRIPTION;

export const seenDates = (watchId: number) =>
  (db.query("SELECT date_code FROM seen_dates WHERE watch_id = ?").all(watchId) as { date_code: string }[])
    .map((r) => r.date_code);

export function recordSeenDates(watchId: number, dates: string[]): void {
  const q = db.query("INSERT OR IGNORE INTO seen_dates (watch_id, date_code) VALUES (?, ?)");
  for (const d of dates) q.run(watchId, d);
}

export const seenVenues = (watchId: number) =>
  (db.query("SELECT venue_code FROM seen_venues WHERE watch_id = ?").all(watchId) as { venue_code: string }[])
    .map((r) => r.venue_code);

export function recordSeenVenues(watchId: number, codes: string[]): void {
  const q = db.query("INSERT OR IGNORE INTO seen_venues (watch_id, venue_code) VALUES (?, ?)");
  for (const c of codes) q.run(watchId, c);
}

export function shouldSilentSeedVenues(watchId: number): boolean {
  const venues = seenVenues(watchId);
  if (venues.length) return false;
  return seenDates(watchId).length > 0;
}
