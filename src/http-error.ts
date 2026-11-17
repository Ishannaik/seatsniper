/** HTTP status and server cooldown, independent of any provider or retry policy. */
export class HttpError extends Error {
  readonly retryAfterMs: number;
  constructor(readonly status: number, headers: Headers, context = 'HTTP request', now = Date.now()) {
    super(`${context} HTTP ${status}. No action was retried.`);
    this.name = 'HttpError';
    const value = headers.get('retry-after')?.trim();
    const delay = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - now : 0;
    this.retryAfterMs = Number.isFinite(delay) ? Math.max(0, delay) : 0;
  }
}
