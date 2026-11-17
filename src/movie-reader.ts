import { initBms, closeBms } from './bms.ts';
import { fetchShowtimes, fetchBookableDates, providerOf } from './providers.ts';
import type { Target, Show } from './movie-model.ts';
import { matchesFormat } from './filters.ts';
import { ReadCycle } from './read-cycle.ts';

export type MovieQuery = { target: Target; format?: string };
export type MovieSnapshot = { title: string; shows: Show[] };
export interface MovieReader {
  snapshot(query: MovieQuery, cycle?: ReadCycle): Promise<MovieSnapshot>;
  close(): Promise<void>;
}

/** Native transport lifetime belongs to the runtime, not an individual watch/user. */
export class PublicMovieReader implements MovieReader {
  private ready?: Promise<void>;
  private closing?: Promise<void>;
  constructor(
    private shows = fetchShowtimes,
    private dates = fetchBookableDates,
    private initialize = initBms,
    private shutdown = closeBms,
  ) {}
  async snapshot(query: MovieQuery, cycle = new ReadCycle()): Promise<MovieSnapshot> {
    const { target, format } = query;
    const bms = providerOf(target) === 'bms';
    if (bms) {
      this.ready ??= this.initialize().catch(error => { this.ready = undefined; throw error; });
      await this.ready;
    }
    const key = JSON.stringify([providerOf(target), target.city, target.eventCode, target.date]);
    const first = await cycle.once('shows:' + key, () => this.shows(target));
    const result = { title: first.title, shows: [...first.shows] };
    if (bms && format) {
      const listing = await cycle.once('dates:' + JSON.stringify([target.city, target.eventCode]), () => this.dates(target));
      for (const chip of listing.chips.filter(chip => matchesFormat(chip.title, format))) {
        const child = { ...target, slug: chip.slug, eventCode: chip.eventCode };
        const childKey = JSON.stringify([providerOf(child), child.city, child.eventCode, child.date]);
        const snapshot = await cycle.once('shows:' + childKey, () => this.shows(child));
        result.shows.push(...snapshot.shows);
      }
    }
    return result;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      const ready = this.ready;
      if (!ready) return;
      try { await ready; } catch { return; }
      await this.shutdown();
    })();
    return this.closing;
  }
}
export const publicMovieReader = new PublicMovieReader();

/** Complete in-memory reader for tests/embedders that supply their own listings. */
export function listingReader(read: typeof fetchShowtimes): MovieReader {
  return {
    snapshot: query => read(query.target),
    close: async () => {},
  };
}
