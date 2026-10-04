import { describe, it, expect } from 'vitest';
import { PerceptionEngine, type ContendedCell } from '../PerceptionEngine.js';
import type { SensorSourceConfig, TestSourceConfig } from '../types.js';

/**
 * Two sources on one cell: the incumbent writer keeps it (ARBITER_CONTRACT.md
 * §4.4b, owner decision 2026-10-02). Two sources writing a cell in one
 * transition violates the single transition time constraint. Within a tier the
 * source activated earliest keeps the cell; equal instants — every seed
 * interned at boot — fall back to canonical (name, id), first winning.
 */
const seed = (id: string, name: string, offset: number, length: number, value: number) =>
  ({
    id, name, type: 'test', region: { offset, length }, active: true,
    machineId: `machine-${id}`, machineName: name, sequenceName: 'seq',
    inputs: [new Array(length).fill(value)], loop: true,
  }) as unknown as Omit<TestSourceConfig, 'id'>;

const sensor = (id: string, sensorId: string, offset: number) =>
  ({
    id, name: id, type: 'sensor', region: { offset, length: 1 }, active: true,
    sensorId, lastValue: [], ttlMs: 300000,
  }) as unknown as Omit<SensorSourceConfig, 'id'>;

const cell = (cells: ContendedCell[], n: number) => cells.find((c) => c.cell === n)!;

describe('STT: the incumbent source keeps a contended cell', () => {
  it('gives equal instants to the first in (name, id), not the last', () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(seed('seed-b', 'Beta seed', 10, 2, 0.25));
    engine.addSource(seed('seed-a', 'Alpha seed', 10, 2, 0.75));
    expect(engine.assembleVector()[10]).toBe(0.75);
    const cells = engine.sourceContention();
    expect(cells.map((c) => c.cell)).toEqual([10, 11]);
    const c = cell(cells, 10);
    expect(c.resolution).toBe('incumbent');
    expect(c.winner.id).toBe('seed-a');
    expect(c.suppressed.map((s) => s.id)).toEqual(['seed-b']);
  });

  it('lets a newcomer lose however its name sorts, and forfeits a cell given up', () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(seed('seed-m', 'Middle seed', 20, 1, 0.5));
    engine.advance(); // transition 1
    engine.addSource(seed('seed-z', 'Aardvark seed', 20, 1, 1.0));
    expect(engine.assembleVector()[20]).toBe(0.5);

    expect(engine.deactivateSource('seed-m')).toBe(true);
    engine.advance(); // transition 2
    engine.updateSource('seed-m', { active: true });
    expect(engine.assembleVector()[20]).toBe(1.0);
    expect(cell(engine.sourceContention(), 20).winner.activatedAt).toBe(1);

    // A patch of a source that stays active keeps its claim.
    engine.updateSource('seed-z', { name: 'Renamed' });
    expect(cell(engine.sourceContention(), 20).winner).toMatchObject({ id: 'seed-z', activatedAt: 1 });
  });

  it('decides live over seed by tier, and live against live by incumbency', () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(seed('seed-hk', 'Zz HealthKit seed', 30, 1, 1.0));
    engine.advance(); // transition 1
    engine.addSource(sensor('live-early', 'hk.early', 30));
    engine.updateSensorValue('hk.early', [0.25]);
    engine.advance(); // transition 2
    engine.addSource(sensor('live-late', 'hk.late', 30));
    engine.updateSensorValue('hk.late', [0.75]);
    expect(engine.assembleVector()[30]).toBe(0.25);
    const c = cell(engine.sourceContention(), 30);
    expect(c.resolution).toBe('incumbent');
    expect(c.winner).toMatchObject({ id: 'live-early', activatedAt: 1 });
    expect(new Set(c.suppressed.map((s) => s.id))).toEqual(new Set(['live-late', 'seed-hk']));

    engine.deactivateSource('live-late');
    const t = cell(engine.sourceContention(), 30);
    expect(t.resolution).toBe('live-over-seed');
    expect(t.winner.id).toBe('live-early');
  });

  it('is counted only by the push, and cleared by reset', () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(seed('seed-a', 'Alpha seed', 40, 1, 1.0));
    engine.advance();
    engine.addSource(seed('seed-b', 'Beta seed', 40, 1, 0.5));
    engine.sourceContention();
    engine.assembleVector();
    expect(engine.getContention().counters).toEqual([]);

    engine.recordContention();
    engine.recordContention();
    const j = engine.getContention();
    expect(j.cells).toHaveLength(1);
    expect(j.counters).toEqual([
      { id: 'seed-a', name: 'Alpha seed', contended: 2, suppressed: 0 },
      { id: 'seed-b', name: 'Beta seed', contended: 2, suppressed: 2 },
    ]);

    engine.reset();
    expect(cell(engine.sourceContention(), 40).suppressed[0]!.activatedAt).toBe(0);
    expect(engine.getContention()).toEqual({ transition: 0, cells: [], folds: [], counters: [] });

    engine.recordContention();
    expect(engine.removeSource('seed-b')).toBe(true);
    expect(engine.getContention().counters).toHaveLength(1);
  });
});
