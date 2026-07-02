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

import { routeArcsToBuses, type ArcTargetInfo, type PeArcTarget } from '../peSourceArcs';

const target = (overlap: number, offset = 0, length = 4): PeArcTarget =>
  ({ overlap, count: 1, targetRegion: { offset, length } });

describe('routeArcsToBuses', () => {
  const info = (domain: string, busId?: string, portalId?: string): ArcTargetInfo =>
    ({ domain, busId, portalId });

  it('keeps direct arcs below the fan-in threshold', () => {
    const routed = routeArcsToBuses(
      new Map([['m1', target(2)], ['m2', target(3)]]),
      new Map([['m1', info('dc', 'bus-dc')], ['m2', info('dc', 'bus-dc')]]),
      'mqtt',
    );
    expect(routed.map(r => r.terminatorId).sort()).toEqual(['m1', 'm2']);
  });

  it('aggregates >=3 same-domain targets onto the domain bus', () => {
    const routed = routeArcsToBuses(
      new Map([
        ['m1', target(2, 0, 4)], ['m2', target(3, 8, 4)], ['m3', target(1, 20, 4)],
      ]),
      new Map([
        ['m1', info('dc', 'bus-dc')], ['m2', info('dc', 'bus-dc')], ['m3', info('dc', 'bus-dc')],
      ]),
      'mqtt',
    );
    expect(routed).toHaveLength(1);
    const arc = routed[0];
    expect(arc.terminatorId).toBe('bus-dc');
    expect(arc.overlap).toBe(6);
    expect(arc.machineIds.sort()).toEqual(['m1', 'm2', 'm3']);
    expect(arc.targetRegion).toEqual({ offset: 0, length: 24 });
  });

  it('routes openclaw-fed arcs to the domain portal regardless of fan-in', () => {
    const routed = routeArcsToBuses(
      new Map([['m1', target(2)]]),
      new Map([['m1', info('dc', 'bus-dc', 'portal-dc')]]),
      'openclaw',
    );
    expect(routed).toHaveLength(1);
    expect(routed[0].terminatorId).toBe('portal-dc');
  });

  it('keeps a stimulated bus machine direct even when aggregating', () => {
    const routed = routeArcsToBuses(
      new Map([
        ['bus-dc', target(1)], ['m2', target(2)], ['m3', target(3)], ['m4', target(4)],
      ]),
      new Map([
        ['bus-dc', info('dc', 'bus-dc')], ['m2', info('dc', 'bus-dc')],
        ['m3', info('dc', 'bus-dc')], ['m4', info('dc', 'bus-dc')],
      ]),
      'mqtt',
    );
    const busArcs = routed.filter(r => r.terminatorId === 'bus-dc');
    expect(busArcs).toHaveLength(2); // aggregate arc + the bus's own direct arc
    expect(busArcs.some(r => r.machineIds.length === 3)).toBe(true);
    expect(busArcs.some(r => r.machineIds.length === 1)).toBe(true);
  });

  it('falls back to direct when no bus exists in the domain', () => {
    const routed = routeArcsToBuses(
      new Map([['m1', target(1)], ['m2', target(1)], ['m3', target(1)]]),
      new Map([['m1', info('dc')], ['m2', info('dc')], ['m3', info('dc')]]),
      'mqtt',
    );
    expect(routed).toHaveLength(3);
  });

  it('treats machines without target info as direct', () => {
    const routed = routeArcsToBuses(
      new Map([['mystery', target(1)]]),
      new Map(),
      'mqtt',
    );
    expect(routed).toHaveLength(1);
    expect(routed[0].terminatorId).toBe('mystery');
  });
});
