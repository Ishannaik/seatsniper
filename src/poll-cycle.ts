import type { Watch } from "./db.ts";

export interface WatchCycleDeps {
  expireStale(w: Watch): Promise<boolean>;
  checkWatch(w: Watch): Promise<void>;
}

/**
 * Run one watch without letting its failure abort the rest of the cycle.
 *
 * `expireStale` and the post-network work in `checkWatch` are the paths that
 * can throw after a successful network response (SQLite busy, a row removed
 * by `/stop`, a delivery failure). Each is isolated here so a bad watch is
 * reported and skipped while every other watch still gets its turn.
 */
export async function runWatchCycle(w: Watch, deps: WatchCycleDeps): Promise<void> {
  try {
    if (await deps.expireStale(w)) return;
  } catch (error) {
    console.error(`[poll] watch ${w.id} failed to expire: ${errorMessage(error)}`);
    return;
  }

  try {
    await deps.checkWatch(w);
  } catch (error) {
    console.error(`[poll] watch ${w.id} failed to check: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
