/**
 * HealthKitBridge — unit tests for the server-side intake layer.
 *
 * Covers:
 *   • deriveHKSensorId  — template, fallback, per-device suffix
 *   • resolveHKBatch    — happy path, unmapped samples, auth bypass
 *   • checkBridgeAuth   — 404/401/open cases
 *   • compactHKIdentifier (via deriveHKSensorId fallback)
 */

import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadRegistry } from '../integrations/Registry.js';
import {
  deriveHKSensorId,
  resolveHKBatch,
  checkBridgeAuth,
} from '../integrations/adapters/HealthKitBridge.js';
import type { HKBridgePayload, HKSample } from '../integrations/adapters/HealthKitBridge.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function registryWith(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'hk-test-'));
  const path = join(dir, 'r.json');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  const state = loadRegistry(path);
  rmSync(dir, { recursive: true, force: true });
  return state;
}

const heartRateMapping = {
  id: 'healthkit:HKQuantityTypeIdentifierHeartRate',
  name: 'Heart Rate',
  region: { offset: 302, length: 1 },
  ttlMs: 300_000,
  normalize: { mode: 'minmax', min: 60, max: 100 },
};

const spO2Mapping = {
  id: 'healthkit:HKQuantityTypeIdentifierOxygenSaturation',
  name: 'SpO2',
  region: { offset: 305, length: 1 },
  ttlMs: 300_000,
  normalize: { mode: 'minmax', min: 0.95, max: 1.0 },
};

// Specific per-device mapping overrides the broad type mapping.
const heartRateWatchMapping = {
  id: 'healthkit:HKQuantityTypeIdentifierHeartRate:Apple Watch',
  name: 'Heart Rate (Watch)',
  region: { offset: 302, length: 1 },
  ttlMs: 300_000,
  normalize: { mode: 'minmax', min: 55, max: 105 },
};

// ── deriveHKSensorId ────────────────────────────────────────────────────────

describe('deriveHKSensorId', () => {
  it('uses sensorId directly when the mapping has one', () => {
    const sample: HKSample = { type: 'HKQuantityTypeIdentifierHeartRate', value: 72 };
    expect(deriveHKSensorId(sample, { id: 'm', sensorId: 'home.heartrate' })).toBe('home.heartrate');
  });

  it('expands sensorIdTemplate tokens', () => {
    const sample: HKSample = { type: 'HKQuantityTypeIdentifierHeartRate', value: 72, sourceName: 'Apple Watch' };
    const id = deriveHKSensorId(sample, { id: 'm', sensorIdTemplate: '{provider}.{type}.{source}' });
    // {type} expands to the raw sanitised type string; compaction only happens in the fallback path
    expect(id).toBe('healthkit.HKQuantityTypeIdentifierHeartRate.Apple_Watch');
  });

  it('falls back to hk.<compact-type> with no sourceName', () => {
    const sample: HKSample = { type: 'HKQuantityTypeIdentifierHeartRate', value: 72 };
    expect(deriveHKSensorId(sample)).toBe('hk.heartrate');
  });

  it('appends a sanitised sourceName suffix in the fallback path', () => {
    const sample: HKSample = { type: 'HKQuantityTypeIdentifierHeartRate', value: 72, sourceName: 'Apple Watch' };
    expect(deriveHKSensorId(sample)).toBe('hk.heartrate.Apple_Watch');
  });

  it('compacts category type identifiers correctly', () => {
    const sample: HKSample = { type: 'HKCategoryTypeIdentifierSleepAnalysis', value: 0 };
    expect(deriveHKSensorId(sample)).toBe('hk.sleepanalysis');
  });

  it('compacts workout type identifiers correctly', () => {
    const sample: HKSample = { type: 'HKWorkoutTypeIdentifier', value: 0 };
    expect(deriveHKSensorId(sample)).toBe('hk.unknown');
  });
});

// ── resolveHKBatch ──────────────────────────────────────────────────────────

describe('resolveHKBatch — happy path', () => {
  it('resolves a valid heart-rate sample to a ResolvedHKSample', () => {
    const registry = registryWith({
      integrations: [{ id: 'hk-home', kind: 'healthkit', enabled: true }],
      sourceMappings: [heartRateMapping],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'hk-home',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: 80, sourceName: 'Apple Watch', unit: 'count/min' }],
    };
    const { resolved, unmapped } = resolveHKBatch(payload, registry);
    expect(unmapped).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    const r = resolved[0]!;
    expect(r.sensorId).toBe('hk.heartrate.Apple_Watch');
    expect(r.name).toBe('Heart Rate');
    expect(r.region).toEqual({ offset: 302, length: 1 });
    expect(r.ttlMs).toBe(300_000);
    expect(r.values).toHaveLength(1);
    expect(r.values[0]).toBeGreaterThanOrEqual(0);
    expect(r.values[0]).toBeLessThanOrEqual(1);
    expect(r.origin.type).toBe('HKQuantityTypeIdentifierHeartRate');
    expect(r.origin.sourceName).toBe('Apple Watch');
    expect(r.origin.unit).toBe('count/min');
  });

  it('resolves multiple sample types in one batch', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [heartRateMapping, spO2Mapping],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [
        { type: 'HKQuantityTypeIdentifierHeartRate', value: 72 },
        { type: 'HKQuantityTypeIdentifierOxygenSaturation', value: 0.97 },
      ],
    };
    const { resolved, unmapped } = resolveHKBatch(payload, registry);
    expect(unmapped).toHaveLength(0);
    expect(resolved).toHaveLength(2);
  });

  it('prefers the specific <type>:<sourceName> mapping over the broad <type> mapping', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [heartRateMapping, heartRateWatchMapping],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: 72, sourceName: 'Apple Watch' }],
    };
    const { resolved } = resolveHKBatch(payload, registry);
    expect(resolved).toHaveLength(1);
    // The Watch-specific mapping was applied — id proves it via origin.
    expect(resolved[0]!.origin.sourceMappingId).toBe('healthkit:HKQuantityTypeIdentifierHeartRate:Apple Watch');
  });

  it('falls back to broad mapping when sourceName has no specific entry', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [heartRateMapping, heartRateWatchMapping],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: 72, sourceName: 'iPhone' }],
    };
    const { resolved } = resolveHKBatch(payload, registry);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.origin.sourceMappingId).toBe('healthkit:HKQuantityTypeIdentifierHeartRate');
  });

  it('pads values to match region.length', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [{ ...heartRateMapping, region: { offset: 302, length: 4 }, normalize: { mode: 'passthrough', clamp: true } }],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: 72 }],
    };
    const { resolved } = resolveHKBatch(payload, registry);
    expect(resolved[0]!.values).toHaveLength(4);
    expect(resolved[0]!.values[1]).toBe(0);
  });
});

describe('resolveHKBatch — unmapped samples', () => {
  it('puts samples with missing type into unmapped', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [] });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: '', value: 1 }],
    };
    const { resolved, unmapped } = resolveHKBatch(payload, registry);
    expect(resolved).toHaveLength(0);
    expect(unmapped[0]!.reason).toMatch(/required/);
  });

  it('puts non-finite values into unmapped', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [heartRateMapping] });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: NaN }],
    };
    const { unmapped } = resolveHKBatch(payload, registry);
    expect(unmapped[0]!.reason).toMatch(/finite/);
  });

  it('puts unmapped types into unmapped with a clear reason', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [] });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: 72 }],
    };
    const { unmapped } = resolveHKBatch(payload, registry);
    expect(unmapped[0]!.reason).toMatch(/no registry mapping/);
  });

  it('puts samples whose mapping lacks region into unmapped', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [{ id: 'healthkit:HKQuantityTypeIdentifierHeartRate' }],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [{ type: 'HKQuantityTypeIdentifierHeartRate', value: 72 }],
    };
    const { unmapped } = resolveHKBatch(payload, registry);
    expect(unmapped[0]!.reason).toMatch(/region/);
  });

  it('resolves good samples and unmaps bad ones in the same batch (207 style)', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [heartRateMapping],
    });
    const payload: HKBridgePayload = {
      bridgeId: 'x',
      samples: [
        { type: 'HKQuantityTypeIdentifierHeartRate', value: 72 },
        { type: 'HKQuantityTypeIdentifierStepCount', value: 8000 },
      ],
    };
    const { resolved, unmapped } = resolveHKBatch(payload, registry);
    expect(resolved).toHaveLength(1);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]!.type).toBe('HKQuantityTypeIdentifierStepCount');
  });
});

// ── checkBridgeAuth ─────────────────────────────────────────────────────────

describe('checkBridgeAuth', () => {
  it('returns 404 when bridgeId is not in the registry', () => {
    const registry = registryWith({
      integrations: [{ id: 'other', kind: 'healthkit', enabled: true }],
      sourceMappings: [],
    });
    const result = checkBridgeAuth(registry, 'missing', 'key');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('returns 401 when the key does not match', () => {
    const registry = registryWith({
      integrations: [{ id: 'hk', kind: 'healthkit', enabled: true, apiKey: 'correct' }],
      sourceMappings: [],
    });
    const result = checkBridgeAuth(registry, 'hk', 'wrong');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('returns ok when the key matches', () => {
    const registry = registryWith({
      integrations: [{ id: 'hk', kind: 'healthkit', enabled: true, apiKey: 'secret' }],
      sourceMappings: [],
    });
    const result = checkBridgeAuth(registry, 'hk', 'secret');
    expect(result.ok).toBe(true);
  });

  it('returns ok when no apiKey is configured (open / dev mode)', () => {
    const registry = registryWith({
      integrations: [{ id: 'hk', kind: 'healthkit', enabled: true }],
      sourceMappings: [],
    });
    const result = checkBridgeAuth(registry, 'hk', undefined);
    expect(result.ok).toBe(true);
  });

  it('ignores non-healthkit integrations with the same id', () => {
    const registry = registryWith({
      integrations: [{ id: 'hk', kind: 'mqtt', enabled: true }],
      sourceMappings: [],
    });
    const result = checkBridgeAuth(registry, 'hk', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});
