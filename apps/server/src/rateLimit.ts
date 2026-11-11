/**
 * Fixed-window, in-memory rate limiter (e.g. "30 per hour per IP").
 *
 * Deliberately simple: state lives in this process and is lost on restart, and a client can spend
 * up to twice the limit across a window boundary. It exists to stop casual abuse of the
 * unauthenticated endpoints, not to replace a limiter at the reverse proxy.
 */
const SWEEP_INTERVAL_MS = 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Count one request for `key`. Returns `0` if it is allowed, otherwise the number of seconds
   * until the key's window resets (suitable for `Retry-After`).
   */
  consume(key: string, now = Date.now()): number {
    if (now >= this.nextSweep) this.sweep(now);
    let entry = this.windows.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, entry);
    }
    if (entry.count >= this.limit) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count++;
    return 0;
  }

  /** Forget expired windows so the map only ever holds keys seen during the last window. */
  private sweep(now: number): void {
    this.nextSweep = now + SWEEP_INTERVAL_MS;
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) this.windows.delete(key);
    }
  }
}

/** Caps how many things one key (e.g. a client address) holds open at the same time. */
export class ConcurrencyLimiter {
  private readonly held = new Map<string, number>();

  constructor(private readonly limit: number) {}

  /** Take a slot for `key`. Returns `false` if all are taken; every `true` needs one `release(key)`. */
  acquire(key: string): boolean {
    const count = this.held.get(key) ?? 0;
    if (count >= this.limit) return false;
    this.held.set(key, count + 1);
    return true;
  }

  release(key: string): void {
    const count = this.held.get(key) ?? 0;
    if (count > 1) this.held.set(key, count - 1);
    else this.held.delete(key);
  }
}
