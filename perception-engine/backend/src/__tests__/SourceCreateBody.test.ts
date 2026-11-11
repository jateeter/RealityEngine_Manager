// The POST /api/sources create body (RealityEngine_CI#755; SURFACE_SPEC
// "POST /api/sources: the create body"): `kind` for `type`, `region` and a
// sensor's `sensorId` required, declared defaults for the rest.
import { describe, expect, it } from 'vitest';
import { createKind, normalizeCreateBody } from '../sourceCreateBody.js';

describe('the POST /api/sources create body', () => {
  it('reads a sparse sensor body with kind and the declared defaults', () => {
    const s = normalizeCreateBody({
      id: 's1', kind: 'sensor', name: 'lifecycle/x', sensorId: 'x',
      region: { offset: 10, length: 2 }, ttlMs: 60000, origin: 'lifecycle', active: false,
    });
    expect(s).toEqual({
      id: 's1', type: 'sensor', name: 'lifecycle/x', sensorId: 'x', region: { offset: 10, length: 2 },
      active: false, origin: 'lifecycle', lastValue: [], lastUpdated: null, ttlMs: 60000,
    });
  });

  it('defaults name, active and ttlMs, and leaves origin absent', () => {
    const s = normalizeCreateBody({ type: 'sensor', sensorId: 'y', region: { offset: 0, length: 1 } });
    expect(s).toMatchObject({ name: 'source', active: true, ttlMs: 5000 });
    expect('origin' in s).toBe(false);
    expect('id' in s).toBe(false);
  });

  it('lets type win over kind, and makes a body naming neither simulated', () => {
    expect(createKind({ type: 'sensor', kind: 'test' })).toBe('sensor');
    expect(normalizeCreateBody({ region: { offset: 0, length: 1 } })).toMatchObject({
      type: 'simulated', pattern: 'constant', frequency: 1, amplitude: 1, dcOffset: 0,
    });
  });

  it('defaults a sparse test source', () => {
    expect(normalizeCreateBody({ type: 'test', region: { offset: 0, length: 1 } })).toMatchObject({
      type: 'test', machineId: '', machineName: '', sequenceName: '', inputs: [], loop: true,
    });
  });

  it('refuses a body without region, a sensor without sensorId, and an unknown kind', () => {
    expect(() => normalizeCreateBody({ type: 'sensor', sensorId: 'x' })).toThrow(/region/);
    expect(() => normalizeCreateBody({ type: 'sensor', region: { offset: 0, length: 1 } })).toThrow(/sensorId/);
    expect(() => normalizeCreateBody({ type: 'nope', region: { offset: 0, length: 1 } })).toThrow(/Unknown source type/);
  });

  it('keeps the full serialized shape', () => {
    const full = {
      type: 'sensor', id: 'f', name: 'n', region: { offset: 3, length: 1 }, active: true,
      sensorId: 'f', lastValue: [0.5], lastUpdated: 1700000000000, ttlMs: 100,
    };
    expect(normalizeCreateBody(full)).toEqual(full);
  });
});
