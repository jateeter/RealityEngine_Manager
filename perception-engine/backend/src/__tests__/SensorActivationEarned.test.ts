import { PerceptionEngine } from '../PerceptionEngine';
import type { SensorSourceConfig } from '../types';

/**
 * A caller may not assert a sensor into activity it has not earned
 * (RealityEngine_CI#199).
 *
 * Registration declares a source completely and inactive (#163 point 2a);
 * activity is earned by the first value (point 2b). This runtime has no
 * separate declare path — addSource IS registration — so the rule is enforced
 * there, where every construction funnels through.
 */
const sensor = (over: Partial<SensorSourceConfig> = {}) =>
  ({
    name: 'probe',
    type: 'sensor',
    region: { offset: 0, length: 2 },
    active: true,
    sensorId: 'probe',
    lastValue: [],
    lastUpdated: null,
    ttlMs: 30_000,
    ...over,
  }) as Omit<SensorSourceConfig, 'id'>;

describe('activity is earned, never asserted', () => {
  it('refuses a sensor that asks to be active without ever having reported', () => {
    // The exact shape #199 describes:
    //   POST /api/sources {"type":"sensor","active":true,...}  ->  active, never fed
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());
    expect(engine.getSource(src.id)?.active).toBe(false);
  });

  it('grants it once a value arrives', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());
    engine.updateSensorValue('probe', [0.5, 0.5]);
    expect(engine.getSource(src.id)?.active).toBe(true);
  });

  it('accepts activity from a path that constructs the source with a value', () => {
    // The MQTT auto-provision and signal-ingest shape: the value is in hand
    // before the source is stored, so the flag is earned at construction.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ lastValue: [1, 1], lastUpdated: Date.now() }));
    expect(engine.getSource(src.id)?.active).toBe(true);
  });

  it('refuses activity on a PATCH too — it is a registration path like any other', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor({ active: false }));
    engine.updateSource(src.id, { active: true });
    expect(engine.getSource(src.id)?.active).toBe(false);
  });

  it('leaves a non-sensor source alone', () => {
    // The rule is about integration sources whose activity is traceable to an
    // ingress event. A simulated source generates unconditionally.
    const engine = new PerceptionEngine(64);
    const src = engine.addSource({
      name: 'sim', type: 'simulated', region: { offset: 8, length: 2 },
      active: true, pattern: 'constant', frequency: 1, amplitude: 1, dcOffset: 0,
    } as any);
    expect(engine.getSource(src.id)?.active).toBe(true);
  });
});

describe('deactivation is not earned', () => {
  it('honours a pause on a sensor holding a live value', () => {
    // Activation is earned; deactivation is not. Clearing asserts nothing about
    // ingress — the source keeps its value and TTL, and the next value re-earns
    // activity. Derivation applied to both directions would leave a live sensor
    // with no way to be paused (RealityEngine_CPP#43).
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());
    engine.updateSensorValue('probe', [1, 1]);
    expect(engine.getSource(src.id)?.active).toBe(true);

    expect(engine.deactivateSource(src.id)).toBe(true);
    expect(engine.getSource(src.id)?.active).toBe(false);
    // Paused, not withdrawn: still declared, still holding its reading.
    expect(engine.getSource(src.id)).toBeDefined();
    expect((engine.getSource(src.id) as SensorSourceConfig).lastValue).toEqual([1, 1]);
  });

  it('lets the next value re-earn activity after a pause', () => {
    const engine = new PerceptionEngine(64);
    const src = engine.addSource(sensor());
    engine.updateSensorValue('probe', [1, 1]);
    engine.deactivateSource(src.id);
    engine.updateSensorValue('probe', [0.25, 0.75]);
    expect(engine.getSource(src.id)?.active).toBe(true);
  });

  it('reports false for an unknown id rather than pretending', () => {
    expect(new PerceptionEngine(64).deactivateSource('nope')).toBe(false);
  });
});
