/** Promise coalescing lasts only as long as the caller's read cycle. */
export class ReadCycle {
  private reads = new Map<string, Promise<unknown>>();
  hits = 0;
  once<T>(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.reads.get(key);
    if (existing) { this.hits++; return existing as Promise<T>; }
    const pending = (async () => read())();
    this.reads.set(key, pending);
    return pending;
  }
}
