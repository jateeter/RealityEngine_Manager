import { describe, it, expect } from 'vitest';
import { arcEligibleSources, buildPeSourceGroups } from '../peSourceArcs';

const machine = (id: string, offset: number, length: number) => ({
  id,
  perceptualMapping: { input: { offset, length } },
});

describe('arcEligibleSources', () => {
  it('keeps only active sensor sources with a region', () => {
    const eligible = arcEligibleSources([
      { type: 'sensor', active: true, region: { offset: 0, length: 4 } },
      { type: 'sensor', active: false, region: { offset: 0, length: 4 } },
      { type: 'sensor', active: true },
      { type: 'test', active: true, region: { offset: 0, length: 4 } },
      { type: 'simulated', active: true, region: { offset: 0, length: 4 } },
    ]);
    expect(eligible).toHaveLength(1);
  });
});

describe('buildPeSourceGroups', () => {
  it('creates one group per origin with arcs to overlapping machines only', () => {
    const groups = buildPeSourceGroups(
      [
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 10, length: 4 } },
        { type: 'sensor', active: true, origin: 'openclaw', region: { offset: 30, length: 2 } },
        { type: 'sensor', active: true, origin: 'ollama', region: { offset: 900, length: 8 } },
      ],
      [machine('m1', 8, 8), machine('m2', 28, 8), machine('m3', 100, 8)],
    );

    expect([...groups.keys()].sort()).toEqual(['mqtt', 'openclaw']);
    expect(groups.get('mqtt')!.perTarget.has('m1')).toBe(true);
    expect(groups.get('mqtt')!.perTarget.has('m2')).toBe(false);
    expect(groups.get('openclaw')!.perTarget.has('m2')).toBe(true);
  });

  it('computes exact overlap sizes and per-target source counts', () => {
    const groups = buildPeSourceGroups(
      [
        // [10,14) vs input [8,16) → 4 elements
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 10, length: 4 } },
        // [14,18) vs input [8,16) → 2 elements
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 14, length: 4 } },
      ],
      [machine('m1', 8, 8)],
    );
    const t = groups.get('mqtt')!.perTarget.get('m1')!;
    expect(t.overlap).toBe(6);
    expect(t.count).toBe(2);
    expect(groups.get('mqtt')!.sourceCount).toBe(2);
  });

  it('grows the provenance envelope across contributing sources', () => {
    const groups = buildPeSourceGroups(
      [
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 10, length: 2 } },
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 20, length: 4 } },
      ],
      [machine('m1', 8, 20)],
    );
    expect(groups.get('mqtt')!.envelope).toEqual({ offset: 10, length: 14 });
  });

  it('falls back to origin "sensor" and skips machines without mappings', () => {
    const groups = buildPeSourceGroups(
      [{ type: 'sensor', active: true, region: { offset: 0, length: 4 } }],
      [{ id: 'unmapped' }, machine('m1', 2, 4)],
    );
    expect([...groups.keys()]).toEqual(['sensor']);
    expect([...groups.get('sensor')!.perTarget.keys()]).toEqual(['m1']);
  });

  it('does not count a source that overlaps no machine', () => {
    const groups = buildPeSourceGroups(
      [
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 0, length: 2 } },
        { type: 'sensor', active: true, origin: 'mqtt', region: { offset: 500, length: 2 } },
      ],
      [machine('m1', 0, 4)],
    );
    expect(groups.get('mqtt')!.sourceCount).toBe(1);
  });
});
