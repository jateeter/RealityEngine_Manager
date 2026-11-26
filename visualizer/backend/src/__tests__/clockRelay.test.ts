/**
 * The Manager relays RE-Clock unchanged and never ticks (Manager#293, RealityEngine_CI#600).
 * Pure functions, no socket: the proxy helpers in server.ts call them on every hop.
 */

import { describe, expect, it } from 'vitest';
import { clockRequestHeaders, presentsClock, relayClock } from '../clockRelay.js';

const ENGINE = 'instance=01a2151c-7a87-7c06-9491-54dc94e61ad7; lamport=7000000';

describe('clockRelay', () => {
  it('passes the caller\'s RE-Clock through unchanged, and nothing when absent', () => {
    expect(clockRequestHeaders({ headers: { 're-clock': ENGINE } })).toEqual({ 'RE-Clock': ENGINE });
    expect(clockRequestHeaders({ headers: {} })).toEqual({});
    expect(presentsClock({ headers: { 're-clock': ENGINE } })).toBe(true);
    expect(presentsClock({ headers: {} })).toBe(false);
  });

  it('keeps a repeated header repeated, for the engine to refuse', () => {
    expect(clockRequestHeaders({ headers: { 're-clock': [ENGINE, ENGINE] as unknown as string } }))
      .toEqual({ 'RE-Clock': `${ENGINE}, ${ENGINE}` });
  });

  it('copies the engine\'s RE-Clock onto the reply, and nothing when the engine sent none', () => {
    const set: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { set[k] = v; } } as never;
    relayClock(res, { 're-clock': ENGINE });
    expect(set).toEqual({ 'RE-Clock': ENGINE });
    const none: Record<string, string> = {};
    relayClock({ setHeader: (k: string, v: string) => { none[k] = v; } } as never, {});
    relayClock({ setHeader: (k: string, v: string) => { none[k] = v; } } as never, undefined);
    expect(none).toEqual({});
  });
});
