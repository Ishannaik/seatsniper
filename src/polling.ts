import {HttpError} from './http-error.ts';

export type PollState = { failureCount: number; nextCheckAt: number; lastError?: string; lastSuccessAt?: number };
/** Sequential polls, persisted cooldowns, exponential backoff and positive jitter. */
export class MonitorPoller {
  private pending?: Promise<number>;
  readonly state: PollState;
  constructor(private run: () => Promise<void>, readonly intervalMs = 30_000,
    state: Partial<PollState> = {}, private persist: (state: PollState) => void = () => {},
    private now = Date.now, private random = Math.random) {
    if (!Number.isFinite(intervalMs) || intervalMs < 30_000) throw Error('Monitor interval must be at least 30 seconds');
    this.state = { ...state, failureCount: Number.isSafeInteger(state.failureCount) && state.failureCount! >= 0 ? state.failureCount! : 0,
      nextCheckAt: Number.isFinite(state.nextCheckAt) && state.nextCheckAt! >= 0 ? state.nextCheckAt! : 0 };
  }
  step(): Promise<number> {
    if (!this.pending) this.pending = this.tick().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async tick(): Promise<number> {
    if (this.state.nextCheckAt > this.now()) return Math.min(2_147_483_647, this.state.nextCheckAt - this.now());
    let delay = this.intervalMs;
    try {
      await this.run();
      this.state.failureCount = 0; delete this.state.lastError;
      this.state.lastSuccessAt = this.now();
    } catch (error) {
      this.state.failureCount = Math.min(1000, this.state.failureCount + 1);
      const exponential = this.intervalMs * 2 ** Math.min(10, this.state.failureCount);
      delay = Math.max(Math.min(900_000, exponential * (1 + this.random() * 0.1)),
        error instanceof HttpError ? error.retryAfterMs : 0);
      this.state.lastError = error instanceof Error ? error.message : 'Monitor check failed';
      console.error(`Monitor check failed; next check in ${Math.ceil(delay / 1000)}s: ${this.state.lastError}`);
    }
    this.state.nextCheckAt = this.now() + delay;
    this.persist({ ...this.state });
    return Math.min(2_147_483_647, delay);
  }
}
