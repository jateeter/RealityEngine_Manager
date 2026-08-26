import { PerceptionEngine } from '../PerceptionEngine.js';
import type { SensorSourceConfig, SimulatedSourceConfig, TestSourceConfig } from '../types.js';

/**
 * Reset validates activity; it does not assign it
 * (contract RealityEngine_CI#163 §3, jateeter/RealityEngine_Manager#63).
 *
 * `reset()` used to force `active: true` on every test source and leave every
 * other kind's flag exactly as it found it. A sensor whose TTL expired before
 * the reset was therefore still reported `active: true` after it — on
 * GET /api/sources and GET /api/state, both byte-compared across the four PE
 * runtimes. The assembled vector was never wrong: an expired sensor already
 * contributes zeros at assembly. The reported state was.
 */

const sensor = (over: Partial<SensorSourceConfig> = {}): Omit<SensorSourceConfig, 'id'> => ({
  type: 'sensor',
  name: 'temp-probe',
  region: { offset: 8, length: 2 },
  active: true,
  sensorId: 'temp-probe',
  lastValue: [],
  lastUpdated: null,
  ttlMs: 30_000,
  ...over,
});

const testSource = (over: Partial<TestSourceConfig> = {}): Omit<TestSourceConfig, 'id'> => ({
  type: 'test',
  name: 'seq',
  region: { offset: 0, length: 2 },
  active: true,
  machineId: 'm-1',
  machineName: 'Machine One',
  sequenceName: 'seq',
  inputs: [[1, 1], [0, 1]],
  loop: false,
  ...over,
});

const simulated = (over: Partial<SimulatedSourceConfig> = {}): Omit<SimulatedSourceConfig, 'id'> => ({
  type: 'simulated',
  name: 'sine',
  region: { offset: 16, length: 2 },
  active: true,
  pattern: 'sine',
  frequency: 0.1,
  amplitude: 0.5,
  dcOffset: 0.5,
  ...over,
});

describe('reset validates sensor activity against the TTL', () => {
  // The acceptance case from the issue.
  it('reports a sensor whose TTL expired before the reset as inactive', async () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ ttlMs: 20 }));

    expect(engine.updateSensorValue('temp-probe', [0.9, 0.9])).toBe(true);
    expect(engine.getSource(src.id)?.active).toBe(true);

    // Wait out the TTL.
    await new Promise(resolve => setTimeout(resolve, 60));

    engine.reset();

    expect(engine.getSource(src.id)?.active).toBe(false);
  });

  it('leaves a sensor still inside its TTL active', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ ttlMs: 30_000 }));
    engine.updateSensorValue('temp-probe', [0.9, 0.9]);

    engine.reset();

    expect(engine.getSource(src.id)?.active).toBe(true);
    // And still contributes, so flag and vector agree.
    expect(engine.assembleVector().slice(8, 10)).toEqual([0.9, 0.9]);
  });

  it('reports a sensor that has never received a value as inactive', () => {
    // Registered active but never fed: activity is earned by the first value.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());

    engine.reset();

    expect(engine.getSource(src.id)?.active).toBe(false);
  });

  it('keeps the expired sensor out of the assembled vector after the reset', async () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(sensor({ ttlMs: 20 }));
    engine.updateSensorValue('temp-probe', [0.9, 0.9]);
    await new Promise(resolve => setTimeout(resolve, 60));

    engine.reset();

    expect(engine.assembleVector().slice(8, 10)).toEqual([0, 0]);
  });

  it('re-activates a validated-inactive sensor when a new value arrives', () => {
    // Deactivation must not be a trap door: the flag comes back with the value,
    // and so does membership of the set assembleVector() iterates.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());
    engine.reset();
    expect(engine.getSource(src.id)?.active).toBe(false);

    expect(engine.updateSensorValue('temp-probe', [0.4, 0.6])).toBe(true);

    expect(engine.getSource(src.id)?.active).toBe(true);
    expect(engine.assembleVector().slice(8, 10)).toEqual([0.4, 0.6]);
  });
});

describe('reset validates the other kinds too', () => {
  it('re-arms an exhausted test source and rewinds it to step 0', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(testSource());

    engine.advance();
    engine.advance(); // past the end of a two-step non-looping sequence
    expect(engine.getSource(src.id)?.active).toBe(false);

    engine.reset();

    expect(engine.getSource(src.id)?.active).toBe(true);
    expect(engine.getTestProgress(src.id)).toEqual({ current: 0, total: 2 });
    expect(engine.assembleVector().slice(0, 2)).toEqual([1, 1]);
  });

  it('reports a test source with no interned steps as inactive', () => {
    // It can supply nothing, so it is not active — forcing the flag true was
    // exactly the assignment this contract replaces.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(testSource({ inputs: [] }));

    engine.reset();

    expect(engine.getSource(src.id)?.active).toBe(false);
  });

  it('keeps a simulated source active — it generates from the zeroed step', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(simulated());

    engine.reset();

    expect(engine.getSource(src.id)?.active).toBe(true);
    expect(engine.globalStep).toBe(0);
  });
});

describe('reset is membership-neutral', () => {
  it('never adds or removes a source', () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(sensor({ ttlMs: 20 }));
    engine.addSource(testSource());
    engine.addSource(simulated());

    const before = engine.getSources().map(s => s.id).sort();
    engine.reset();
    const after = engine.getSources().map(s => s.id).sort();

    expect(after).toEqual(before);
  });

  it('rewinds globalStep and the persistent vector', () => {
    const engine = new PerceptionEngine(64);
    engine.updateFromPerceptualSpace(new Array(64).fill(0.7));
    engine.advance();
    expect(engine.globalStep).toBe(1);

    engine.reset();

    expect(engine.globalStep).toBe(0);
    expect(engine.assembleVector().every(v => v === 0)).toBe(true);
  });
});
