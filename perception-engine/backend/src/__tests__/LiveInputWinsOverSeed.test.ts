import { describe, it, expect } from 'vitest';
import { PerceptionEngine } from '../PerceptionEngine.js';
import type { SensorSourceConfig, TestSourceConfig } from '../types.js';

/**
 * Live inputs always win over the seed on a shared lane (owner decision,
 * 2026-10-02, RealityEngine_CPP#146).
 *
 * A machine's interned test source writes its machine's input region. When that
 * region is a service lane, a live source (HealthKit, a sensor, MQTT…) writes it
 * too. The seed is ISRESeed(n), the base every live input folds over, so the live
 * value must land — whatever the names, whatever the magnitudes. The C++, LSP and
 * Scala PEs compose the seed tier first; this PE drops seed contributions from any
 * cell a live source contends before the arbiter resolves it.
 */
const lane = { offset: 4, length: 4 };

const seed = (over: Partial<TestSourceConfig> = {}) =>
  ({
    // Sorts after the sensor by name, and its values are larger: either alone
    // was enough to beat the live reading before the rule existed.
    name: 'Zz Vitals Monitor / 2 sequences',
    type: 'test',
    region: lane,
    active: true,
    machineId: 'machine-vitals',
    machineName: 'Zz Vitals Monitor',
    sequenceName: 'seq',
    inputs: [[1, 1, 1, 1]],
    loop: false,
    ...over,
  }) as unknown as Omit<TestSourceConfig, 'id'>;

const live = () =>
  ({
    name: 'HealthKit Blood Pressure',
    type: 'sensor',
    region: lane,
    active: true,
    sensorId: 'healthkit.blood-pressure',
    lastValue: [],
    lastUpdated: null,
    ttlMs: 300_000,
  }) as Omit<SensorSourceConfig, 'id'>;

describe('live inputs win over the seed on a shared lane', () => {
  it('lands the live reading, not the seed, on every contended cell', () => {
    const engine = new PerceptionEngine(16);
    engine.addSource(seed());
    engine.addSource(live());
    engine.updateSensorValue('healthkit.blood-pressure', [0.72, 0.48, 0.24, 0.99]);

    const v = engine.assembleVector();
    expect(v.slice(4, 8).map((x) => +x.toFixed(2))).toEqual([0.72, 0.48, 0.24, 0.99]);
  });

  it('wins regardless of registration order', () => {
    const engine = new PerceptionEngine(16);
    engine.addSource(live());
    engine.addSource(seed());
    engine.updateSensorValue('healthkit.blood-pressure', [0.1, 0.2, 0.3, 0.4]);

    expect(engine.assembleVector().slice(4, 8).map((x) => +x.toFixed(2))).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('leaves a seed-only lane to the seed', () => {
    const engine = new PerceptionEngine(16);
    engine.addSource(seed({ region: { offset: 10, length: 4 } }));
    engine.addSource(live());
    engine.updateSensorValue('healthkit.blood-pressure', [0.5, 0.5, 0.5, 0.5]);

    expect(engine.assembleVector().slice(10, 14)).toEqual([1, 1, 1, 1]);
  });

  it('keeps the seed where the live source has not reported (inactive live source)', () => {
    const engine = new PerceptionEngine(16);
    engine.addSource(seed());
    engine.addSource(live()); // never fed: activity is earned, so it does not contend

    expect(engine.assembleVector().slice(4, 8)).toEqual([1, 1, 1, 1]);
  });
});
