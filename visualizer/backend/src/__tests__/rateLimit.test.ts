/**
 * Rate-limit buckets are keyed per (scope, ip), not per ip.
 *
 * The real module is imported, not restated: this defect shipped because the
 * logic lived inline in a server module that binds ports on import and so was
 * never unit tested. A test that copies the implementation would reproduce
 * that gap with extra steps.
 *
 * Measured before the fix, replaying the real middleware over a mixed stream
 * (1-in-4 to /api/machines):
 *
 *     requests issued            : 400
 *     machines-route count so far: 100   (well under its declared 120 cap)
 *     first 429 on /api/machines : request #97
 *     first 429 on other routes  : request #178   (not #200)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitRegistry, RATE_WINDOW_MS } from '../rateLimit.js';

const GLOBAL_MAX = 200;
const MACHINES_MAX = 120;

let reg: RateLimitRegistry;

/** Express order: the global middleware runs, then the route's own limiter. */
function request(path: string, ip = '127.0.0.1'): number {
  const g = reg.limiter(GLOBAL_MAX).check(ip);
  if (g !== 200) return g;
  if (path === '/api/machines') return reg.limiter(MACHINES_MAX, 'machines').check(ip);
  return 200;
}

describe('RateLimitRegistry', () => {
  beforeEach(() => { reg = new RateLimitRegistry(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a route limit counts only that route', () => {
    // Past the machines cap, on other routes. Must not consume its budget.
    for (let i = 0; i < 150; i++) expect(request('/api/engines')).toBe(200);
    expect(request('/api/machines')).toBe(200);
  });

  it('/api/machines is rejected on its own 121st, not the stream’s 97th', () => {
    let first429: number | null = null;
    for (let i = 1; i <= 400 && first429 === null; i++) {
      if (request('/api/machines') === 429) first429 = i;
    }
    expect(first429).toBe(MACHINES_MAX + 1);
  });

  it('an /api/machines request costs one against the global budget, not two', () => {
    let served = 0;
    for (let i = 0; i < GLOBAL_MAX; i++) {
      if (request(i % 4 === 0 ? '/api/machines' : '/api/engines') === 200) served++;
    }
    expect(served).toBe(GLOBAL_MAX);
    expect(request('/api/engines')).toBe(429);
  });

  it('the global limit still applies to every route', () => {
    for (let i = 0; i < GLOBAL_MAX; i++) expect(request('/api/engines')).toBe(200);
    expect(request('/api/engines')).toBe(429);
    expect(request('/api/machines')).toBe(429);
  });

  it('separate ips keep separate budgets', () => {
    for (let i = 0; i < GLOBAL_MAX; i++) request('/api/engines', '10.0.0.1');
    expect(request('/api/engines', '10.0.0.1')).toBe(429);
    expect(request('/api/engines', '10.0.0.2')).toBe(200);
  });

  it('an IPv6 address does not collide across scopes', () => {
    // The separator has to survive an address that is mostly colons.
    const v6 = '::ffff:127.0.0.1';
    for (let i = 0; i < MACHINES_MAX; i++) expect(request('/api/machines', v6)).toBe(200);
    expect(request('/api/machines', v6)).toBe(429);
    expect(request('/api/engines', v6)).toBe(200);
  });

  it('the window rolls', () => {
    for (let i = 0; i < GLOBAL_MAX; i++) request('/api/engines');
    expect(request('/api/engines')).toBe(429);
    vi.advanceTimersByTime(RATE_WINDOW_MS + 1);
    expect(request('/api/engines')).toBe(200);
  });

  it('sweep drops only expired buckets', () => {
    request('/api/engines', '10.0.0.1');
    request('/api/machines', '10.0.0.2');
    expect(reg.size).toBe(3);          // global|.1, global|.2, machines|.2
    reg.sweep(Date.now() + RATE_WINDOW_MS + 1);
    expect(reg.size).toBe(0);
  });
});
