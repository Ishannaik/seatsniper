import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("upgrades legacy BMS watches without losing IDs or notification ledgers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seatsniper-migration-"));
  try {
    const path = join(dir, "old.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE watches (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      city TEXT NOT NULL, slug TEXT NOT NULL, event_code TEXT NOT NULL, date TEXT NOT NULL,
      title TEXT NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, UNIQUE (user_id, event_code, date));
      CREATE TABLE seen_dates (watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE, date_code TEXT NOT NULL, PRIMARY KEY(watch_id,date_code));
      CREATE TABLE seen_venues (watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE, venue_code TEXT NOT NULL, PRIMARY KEY(watch_id,venue_code));
      INSERT INTO watches VALUES(42,'u','c','mumbai','movie','ET123456','','Movie',2,123,'error',1);
      INSERT INTO seen_dates VALUES(42,'20261115');
      INSERT INTO seen_venues VALUES(42,'PVR');`);
    db.close();
    // Separate process exercises startup, then a second startup verifies idempotence.
    const moduleUrl = new URL("./db.ts", import.meta.url).href;
    const script = `const d = await import(${JSON.stringify(moduleUrl)}); const w=d.listWatches('u')[0]; if(w.id!==42||w.provider!=='bms'||w.fail_count!==2||d.seenDates(42)[0]!=='20261115'||d.seenVenues(42)[0]!=='PVR') throw Error('migration lost data');`;
    for (let n = 0; n < 2; n++) {
      const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, DB_PATH: path }, stdout: "pipe", stderr: "pipe" });
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
    }
    const migrated = new Database(path);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.exec("PRAGMA foreign_keys=ON; DELETE FROM watches WHERE id=42;");
    expect(migrated.query("SELECT * FROM seen_dates").all()).toEqual([]);
    expect(migrated.query("SELECT * FROM seen_venues").all()).toEqual([]);
    migrated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
