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
};

const db = new Database(process.env.DB_PATH ?? "seatsniper.db", { create: true });
db.exec("PRAGMA journal_mode = WAL");
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
`);

const now = () => Math.floor(Date.now() / 1000);

export const MAX_WATCHES_PER_USER = 5;

export function addWatch(w: Omit<Watch, "id" | "fail_count" | "last_ok_at" | "last_error" | "created_at">): number | null {
  try {
    const r = db
      .query(
        `INSERT INTO watches (user_id, channel_id, city, slug, event_code, date, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(w.user_id, w.channel_id, w.city, w.slug, w.event_code, w.date, w.title, now()) as { id: number };
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
