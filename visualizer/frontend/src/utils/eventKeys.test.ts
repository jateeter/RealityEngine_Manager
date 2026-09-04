import { describe, it, expect } from 'vitest';
import {
  readInputEvent,
  readMatchedEvents,
  readActivatedEvents,
  readTotalEvents,
  readActiveEvents,
  readEventDimension,
  readInitialEventIds,
} from './eventKeys';

/**
 * RealityEngine_CI#220 layer 2. The engines migrate one runtime at a time, so
 * this frontend can be pointed at any mixture of migrated and unmigrated ones
 * and must read both spellings identically.
 *
 * The failure these guard against is quiet: a read that misses returns
 * `undefined` and a panel renders blank, with nothing in the parity gate to
 * catch it.
 */
describe('Reality Event key reads, mid-rename', () => {
  it('reads the legacy spelling', () => {
    expect(readInputEvent({ inputVector: [1, 0] })).toEqual([1, 0]);
    expect(readMatchedEvents({ matchedVectors: ['a'] })).toEqual(['a']);
    expect(readActivatedEvents({ activatedVectors: ['b'] })).toEqual(['b']);
    expect(readTotalEvents({ totalVectors: 7 })).toBe(7);
    expect(readActiveEvents({ activeVectors: 3 })).toBe(3);
    expect(readEventDimension({ vectorDimension: 7680 })).toBe(7680);
    expect(readInitialEventIds({ initialVectorIds: ['i'] })).toEqual(['i']);
  });

  it('reads the canonical spelling', () => {
    expect(readInputEvent({ inputEvent: [1, 0] })).toEqual([1, 0]);
    expect(readMatchedEvents({ matchedEvents: ['a'] })).toEqual(['a']);
    expect(readActivatedEvents({ activatedEvents: ['b'] })).toEqual(['b']);
    expect(readTotalEvents({ totalEvents: 7 })).toBe(7);
    expect(readActiveEvents({ activeEvents: 3 })).toBe(3);
    expect(readEventDimension({ eventDimension: 7680 })).toBe(7680);
    expect(readInitialEventIds({ initialEventIds: ['i'] })).toEqual(['i']);
  });

  // What a runtime emits during its own transition. The canonical value is the
  // one migrated consumers will read, so it has to win.
  it('prefers the canonical spelling when a payload carries both', () => {
    expect(readInputEvent({ inputEvent: [9], inputVector: [1] })).toEqual([9]);
    expect(readTotalEvents({ totalEvents: 9, totalVectors: 1 })).toBe(9);
    expect(readMatchedEvents({ matchedEvents: ['new'], matchedVectors: ['old'] })).toEqual(['new']);
  });

  // A blank panel is the quiet failure; an empty list is a safe render, and
  // `undefined` for a scalar is distinguishable from a real zero.
  it('degrades safely when neither spelling is present', () => {
    expect(readMatchedEvents({})).toEqual([]);
    expect(readActivatedEvents({})).toEqual([]);
    expect(readInitialEventIds({})).toEqual([]);
    expect(readInputEvent({})).toBeUndefined();
    expect(readTotalEvents({})).toBeUndefined();
  });

  it('tolerates null and undefined payloads', () => {
    expect(readMatchedEvents(null)).toEqual([]);
    expect(readActivatedEvents(undefined)).toEqual([]);
    expect(readInputEvent(null)).toBeUndefined();
    expect(readTotalEvents(undefined)).toBeUndefined();
  });

  // Zero is a real reading and must survive: `??` is correct here where `||`
  // would report an engine holding no active events as "unknown".
  it('does not mistake zero for absent', () => {
    expect(readTotalEvents({ totalEvents: 0 })).toBe(0);
    expect(readActiveEvents({ activeVectors: 0 })).toBe(0);
    expect(readEventDimension({ eventDimension: 0 })).toBe(0);
  });
});
