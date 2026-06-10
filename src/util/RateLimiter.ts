export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Token-bucket rate limiter. `capacity` tokens, refilled at `refillPerSec`.
 * acquire() resolves when a token is available, sleeping otherwise.
 *
 * Node is single-threaded, so refill→check→decrement runs as one synchronous
 * block with no interleaving — concurrent acquire() callers can't double-spend a
 * token. Waiters sleep and re-check, so ordering is roughly FIFO under low load,
 * which is all we need for a handful of Recall calls per meeting.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(50, ((1 - this.tokens) / this.refillPerSec) * 1000);
      await sleep(waitMs);
    }
  }
}

/**
 * Serializes async jobs and guarantees a minimum gap between them. Used for
 * outbound chat so we never flood the meeting (or trip Recall's limits) even if
 * several "Mex, ..." replies fire close together.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastRun = 0;

  constructor(private readonly minGapMs: number) {}

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const gap = this.lastRun + this.minGapMs - Date.now();
      if (gap > 0) await sleep(gap);
      try {
        return await job();
      } finally {
        this.lastRun = Date.now();
      }
    });
    // Keep the chain alive even if a job rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
