import { sequenceEvents } from '../corpusEventKeys.js';

// RealityEngine_CI#220 layer 1. The PE builds one `test` source per input
// sequence, and an input sequence whose events it cannot find is silently
// skipped — no throw, no warning, just a machine that never drives the
// perception loop. These assertions are what stands between a corpus rename and
// that failure.
describe('sequenceEvents', () => {
  const rows = [[0.1, 0.2], [0.3, 0.4]];

  it('reads the canonical spelling', () => {
    expect(sequenceEvents({ name: 'seq', events: rows })).toEqual(rows);
  });

  it('reads the pre-#220 spelling, so an un-rewritten corpus still bootstraps', () => {
    expect(sequenceEvents({ name: 'seq', vectors: rows })).toEqual(rows);
  });

  it('prefers the canonical spelling when a machine carries both', () => {
    const legacy = [[9, 9]];
    expect(sequenceEvents({ name: 'seq', events: rows, vectors: legacy })).toEqual(rows);
  });

  it('returns an empty array for a sequence with neither', () => {
    expect(sequenceEvents({ name: 'seq' })).toEqual([]);
    expect(sequenceEvents(undefined)).toEqual([]);
    expect(sequenceEvents(null)).toEqual([]);
  });

  it('returns an empty array when the key is present but not an array', () => {
    // Guards the bootstrap loop's `.length` read: a malformed corpus entry
    // should skip the sequence, not throw partway through the machine list.
    expect(sequenceEvents({ events: 'nope' } as never)).toEqual([]);
    expect(sequenceEvents({ vectors: 42 } as never)).toEqual([]);
  });
});
