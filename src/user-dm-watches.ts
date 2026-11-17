/** Private watch namespaces. Actor IDs come from Discord, never message options. */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DmWatches } from './dm-watches.ts';
import type { Json } from './json.ts';
import { ReadCycle } from './read-cycle.ts';
const validId = (id: string) => /^\d{17,20}$/.test(id);
export class UserDmWatches {
  private managers = new Map<string, DmWatches>();
  private usersPath: string;
  constructor(
    private directory = process.env.MONITOR_STATE_DIR ?? '.runtime/doomsday-monitor',
    private legacyOwner = process.env.DISTRICT_BOOKING_OWNER_ID,
    private factory = (path: string) => new DmWatches(path),
  ) {
    this.usersPath = join(directory, 'users');
    mkdirSync(this.usersPath, { recursive: true, mode: 0o700 });
    // Keep the original owner's state in place; never assign it to another user.
    if (legacyOwner) {
      if (!validId(legacyOwner)) throw Error('Invalid legacy watch owner ID');
      this.managers.set(legacyOwner, factory(directory));
    }
    for (const entry of readdirSync(this.usersPath, { withFileTypes: true })) {
      if (entry.isDirectory() && validId(entry.name) && entry.name !== legacyOwner)
        this.managers.set(entry.name, factory(join(this.usersPath, entry.name)));
    }
  }
  command(userId: string, text: string) {
    if (!validId(userId)) throw Error('Invalid Discord user ID');
    let manager = this.managers.get(userId);
    if (!manager) {
      manager = this.factory(join(this.usersPath, userId));
      this.managers.set(userId, manager);
    }
    return manager.command(text);
  }
  async step(send: (userId: string, content: string, components?: Json[]) => Promise<unknown>) {
    const cycle = new ReadCycle();
    for (const [userId, manager] of this.managers) {
      try { await manager.step((content, components) => send(userId, content, components), cycle); }
      catch { console.error('Private watch cycle failed; other users continue.'); }
    }
  }
  async close() { await Promise.all([...this.managers.values()].map(manager => manager.close())); }
}
