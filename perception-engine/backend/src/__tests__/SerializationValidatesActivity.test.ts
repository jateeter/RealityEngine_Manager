import { PerceptionEngine } from '../PerceptionEngine.js';
import type { SensorSourceConfig, SimulatedSourceConfig, SourceConfig, TestSourceConfig } from '../types.js';

/**
 * Activity expiry is continuous, not evaluated only at reset
 * (contract RealityEngine_CI#175).
 *
 * Reset validating the stored flag (#63) fixed the flag at one instant and left
 * it to rot until the next one. Nothing runs when a sensor's TTL lapses — no
 * timer, no callback — so between resets `/api/sources` and `/api/state` went
 * on advertising `active: true` for a source assembly was already zeroing. The
 * reported value is now derived at every read:
 *
 *     reported_active = stored_active AND validated_active(kind)
 *
 * Both halves matter. The stored flag keeps a paused source and a finished
 * non-looping test source reported inactive; validation stops a stale flag
 * reading as live. Validation can only take activity away, never grant it.
 *
 * LSP is the reference (source-json); C++ and Scala carry the same rule.
 */

const NO_AUTO = { running: false, intervalMs: 1000 };

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

/** The `active` a client is told about, from the list a client is given. */
const reported = (engine: PerceptionEngine, id: string): boolean | undefined =>
  engine.serializeSources().find(s => s.id === id)?.active;

/** The same field from the /api/state snapshot, which the WS broadcast carries. */
const reportedInState = (engine: PerceptionEngine, id: string): boolean | undefined =>
  engine.getState(null, NO_AUTO).sources.find(s => s.id === id)?.active;

describe('a sensor whose TTL lapsed reads inactive with no reset', () => {
  it('reports inactive as soon as the window closes', () => {
    const engine = new PerceptionEngine(64);
    // Fed a minute ago under a 30s TTL: stored active, long since stale.
    const src = engine.addSource(sensor({
      lastValue: [0.9, 0.9],
      lastUpdated: Date.now() - 60_000,
      ttlMs: 30_000,
    }));

    // No reset() anywhere in this test — that is the point.
    expect(reported(engine, src.id)).toBe(false);
    expect(reportedInState(engine, src.id)).toBe(false);
  });

  it('reports inactive the moment a live sensor goes stale, mid-run', async () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ ttlMs: 20 }));
    engine.updateSensorValue('temp-probe', [0.9, 0.9]);
    expect(reported(engine, src.id)).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(reported(engine, src.id)).toBe(false);
  });

  it('agrees with the vector: reported inactive, contributes zeros', () => {
    const engine = new PerceptionEngine(64);
    engine.addSource(sensor({
      lastValue: [0.9, 0.9],
      lastUpdated: Date.now() - 60_000,
      ttlMs: 30_000,
    }));

    const state = engine.getState(null, NO_AUTO);

    expect(state.sources[0].active).toBe(false);
    expect(state.assembledVector.slice(8, 10)).toEqual([0, 0]);
  });

  it('reports a sensor that has never been fed as inactive, however it was registered', () => {
    // The ingress invariant: activity is earned by a value. Registering with
    // `active: true` does not manufacture one.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ active: true }));

    expect(reported(engine, src.id)).toBe(false);
  });
});

describe('a sensor inside its TTL reads active', () => {
  it('reports active and contributes its value', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ ttlMs: 30_000 }));
    engine.updateSensorValue('temp-probe', [0.4, 0.6]);

    expect(reported(engine, src.id)).toBe(true);
    expect(reportedInState(engine, src.id)).toBe(true);
    expect(engine.assembleVector().slice(8, 10)).toEqual([0.4, 0.6]);
  });

  it('reads active again once a fresh value arrives after going stale', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({
      lastValue: [0.9, 0.9],
      lastUpdated: Date.now() - 60_000,
      ttlMs: 30_000,
    }));
    expect(reported(engine, src.id)).toBe(false);

    engine.updateSensorValue('temp-probe', [0.1, 0.2]);

    expect(reported(engine, src.id)).toBe(true);
  });
});

describe('the stored flag still gates — validation only ever takes away', () => {
  it('keeps a paused sensor inactive even while it holds a fresh value', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());
    engine.updateSensorValue('temp-probe', [0.4, 0.6]);
    engine.updateSource(src.id, { active: false });

    // Validation says "could supply a value"; the operator says no.
    expect(reported(engine, src.id)).toBe(false);
    expect(reportedInState(engine, src.id)).toBe(false);
  });

  it('keeps a paused simulated source inactive, though it always validates active', () => {
    // The conjunct that would be lost if serialization reported validation alone.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(simulated({ active: false }));

    expect(reported(engine, src.id)).toBe(false);
  });

  it('keeps a paused test source inactive though its sequence is non-empty', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(testSource({ active: false }));

    expect(reported(engine, src.id)).toBe(false);
  });

  it('reports an exhausted non-looping test source inactive', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(testSource({ loop: false }));
    expect(reported(engine, src.id)).toBe(true);

    engine.advance();
    engine.advance(); // past the end of a two-step sequence

    expect(reported(engine, src.id)).toBe(false);
    expect(reportedInState(engine, src.id)).toBe(false);
  });

  it('keeps a looping test source active across the sequence boundary', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(testSource({ loop: true }));

    engine.advance();
    engine.advance();
    engine.advance();

    expect(reported(engine, src.id)).toBe(true);
  });

  it('reports a test source with no interned steps inactive', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(testSource({ inputs: [] }));

    expect(reported(engine, src.id)).toBe(false);
  });

  it('leaves a simulated source active', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(simulated());

    expect(reported(engine, src.id)).toBe(true);
  });
});

describe('serializing is a read: it does not mutate stored state', () => {
  const storedFlags = (engine: PerceptionEngine): Array<[string, boolean]> =>
    engine.getSources().map(s => [s.id, s.active]);

  const activeSet = (engine: PerceptionEngine): string[] =>
    [...(engine as unknown as { activeSources: Set<string> }).activeSources].sort();

  const populate = (engine: PerceptionEngine): void => {
    engine.addSource(sensor({
      name: 'stale', sensorId: 'stale',
      lastValue: [0.9, 0.9], lastUpdated: Date.now() - 60_000, ttlMs: 30_000,
    }));
    engine.addSource(sensor({ name: 'never-fed', sensorId: 'never-fed', region: { offset: 10, length: 2 } }));
    engine.addSource(testSource({ name: 'empty', inputs: [] }));
    engine.addSource(simulated({ name: 'paused', active: false }));
  };

  it('leaves the stored flags untouched — including the ones it reports differently', () => {
    const engine = new PerceptionEngine(64);
    populate(engine);
    const before = storedFlags(engine);

    engine.serializeSources();
    engine.serializeSources();
    engine.getState(null, NO_AUTO);

    expect(storedFlags(engine)).toEqual(before);
    // And the reported view really does differ from the stored one, so the
    // assertion above is not vacuous.
    expect(engine.serializeSources().map(s => s.active))
      .not.toEqual(before.map(([, active]) => active));
  });

  it('leaves activeSources untouched — the set assembly and advance() iterate', () => {
    const engine = new PerceptionEngine(64);
    populate(engine);
    const before = activeSet(engine);

    engine.serializeSources();
    engine.getState(null, NO_AUTO);

    expect(activeSet(engine)).toEqual(before);
  });

  it('does not deactivate a stale sensor that a later value would revive', () => {
    // If serialization retired the source, this reading would land on a source
    // excluded from activeSources and contribute zeros forever.
    const engine = new PerceptionEngine(64);
    engine.addSource(sensor({
      lastValue: [0.9, 0.9], lastUpdated: Date.now() - 60_000, ttlMs: 30_000,
    }));

    engine.serializeSources();
    engine.updateSensorValue('temp-probe', [0.3, 0.7]);

    expect(engine.assembleVector().slice(8, 10)).toEqual([0.3, 0.7]);
  });

  it('returns copies, so a caller cannot write through to the stored source', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({
      lastValue: [0.9, 0.9], lastUpdated: Date.now() - 60_000, ttlMs: 30_000,
    }));

    const serialized = engine.serializeSources()[0];
    expect(serialized).not.toBe(engine.getSource(src.id));
    expect(engine.getSource(src.id)?.active).toBe(true);
  });
});

describe('the clock is read once per serialization pass', () => {
  it('serializes identically configured sensors identically across a TTL boundary', () => {
    const engine = new PerceptionEngine(64);
    const fedAt = 1_000_000;
    // Three sensors, same lastUpdated, same TTL — one answer between them.
    for (let i = 0; i < 3; i++) {
      engine.addSource(sensor({
        name: `probe-${i}`,
        sensorId: `probe-${i}`,
        region: { offset: i * 2, length: 2 },
        lastValue: [1, 1],
        lastUpdated: fedAt,
        ttlMs: 10,
      }));
    }

    // A clock that advances a millisecond per reading, positioned so the TTL
    // expires between the first reading and the second. Read once, all three
    // are live; read per source, the first is live and the rest are not.
    const realNow = Date.now;
    let tick = 0;
    let flags: boolean[];
    try {
      Date.now = () => fedAt + 10 + tick++;
      flags = engine.serializeSources().map(s => s.active);
    } finally {
      Date.now = realNow;
    }

    expect(flags).toEqual([true, true, true]);
    expect(new Set(flags).size).toBe(1);
  });
});

describe('every reported view agrees', () => {
  it('gives /api/sources, /api/state and the state-update broadcast the same flags', () => {
    // getState() is the single snapshot behind both the HTTP endpoint and the
    // WebSocket payload, so this pins them to the /api/sources list.
    const engine = new PerceptionEngine(64);
    engine.addSource(sensor({
      name: 'stale', sensorId: 'stale',
      lastValue: [0.9, 0.9], lastUpdated: Date.now() - 60_000, ttlMs: 30_000,
    }));
    engine.addSource(testSource({ name: 'live' }));
    engine.addSource(simulated({ name: 'paused', active: false }));

    const asList = engine.serializeSources().map(s => [s.name, s.active]);
    const asState = engine.getState(null, NO_AUTO).sources.map((s: SourceConfig) => [s.name, s.active]);

    expect(asState).toEqual(asList);
    expect(asList).toEqual([['live', true], ['paused', false], ['stale', false]]);
  });
});
