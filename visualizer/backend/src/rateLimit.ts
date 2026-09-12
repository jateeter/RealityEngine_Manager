/**
 * Per-IP request budgets, scoped so a per-route limit is actually per route.
 *
 * Extracted from server.ts so it can be tested. It was inline, and the defect
 * below shipped because a module that binds ports on import cannot be unit
 * tested — so nothing was.
 *
 * Every limiter used to key on the IP alone, so the global middleware and the
 * `/api/machines` limiter shared one counter. Replaying the real middleware
 * over a mixed stream (1-in-4 to /api/machines) before the fix:
 *
 *     requests issued            : 400
 *     machines-route count so far: 100   (well under its declared 120 cap)
 *     first 429 on /api/machines : request #97
 *     first 429 on other routes  : request #178   (not #200)
 *
 * Two things followed, neither intended:
 *
 *   - `/api/machines` was rejected once *total* traffic reached 120, not once
 *     it had served 120 itself.
 *   - each `/api/machines` request cost **two** against the global budget,
 *     because both limiters incremented the same bucket.
 *
 * So `VIZ_MACHINES_RATE_LIMIT_MAX` was not a per-route allowance but a second,
 * lower global ceiling that one route was measured against. `claude.md` and
 * `AGENTS.md` both advise raising the two env vars for high-volume e2e runs;
 * that advice worked by accident — raising the lower number moved a global
 * ceiling.
 *
 * Half of Manager#122: a 56-test Playwright suite arrives from one IP, so
 * whether a given test saw a 429 depended on where in the rolling window it
 * landed relative to the other workers — the suite's non-determinism, not a
 * separate problem. 11 of 22 saved failure artifacts carry a visible
 * `Failed to load machine graph (HTTP 429)`.
 */
export interface RateBucket { count: number; resetAt: number }

export const RATE_WINDOW_MS = 60_000;

export interface RateLimiter {
  /** 200 if the request is allowed, 429 if it is over budget. */
  check(ip: string): number;
}

export class RateLimitRegistry {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly windowMs: number = RATE_WINDOW_MS) {}

  limiter(max: number, scope = 'global'): RateLimiter {
    return {
      check: (ip: string): number => {
        // `|`, not `:` — an IPv6 remoteAddress is full of colons, while a
        // scope name is [a-z]+, so the separator cannot be ambiguous.
        const key = `${scope}|${ip}`;
        const now = Date.now();
        let bucket = this.buckets.get(key);
        if (!bucket || bucket.resetAt < now) {
          bucket = { count: 0, resetAt: now + this.windowMs };
          this.buckets.set(key, bucket);
        }
        if (bucket.count >= max) return 429;
        bucket.count++;
        return 200;
      },
    };
  }

  /** Drop expired buckets. Keys are `scope|ip`, not bare ips. */
  sweep(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt < now) this.buckets.delete(key);
    }
  }

  get size(): number { return this.buckets.size; }
}
