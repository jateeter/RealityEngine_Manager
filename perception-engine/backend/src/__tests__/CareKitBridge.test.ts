/**
 * CareKitBridge — unit + parity tests.
 *
 * Parity: all sensorId derivations and batch-merge semantics must produce
 * identical results to RealityEngine_CPP (build_carekit_signal / ingest_carekit)
 * and RealityEngine_LSP (ingest-carekit-one / render-sensor-template).
 */

import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadRegistry } from '../integrations/Registry.js';
import {
  buildCKSensorId,
  checkCareKitAuth,
  resolveCKBatch,
  resolveCKOne,
  buildCKStatusBody,
} from '../integrations/adapters/CareKitBridge.js';
import type { CKSample, CKIngestPayload } from '../integrations/adapters/CareKitBridge.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function registryWith(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
  const path = join(dir, 'r.json');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  const state = loadRegistry(path);
  rmSync(dir, { recursive: true, force: true });
  return state;
}

const TASK_MAPPING = {
  id: 'carekit-task',
  sensorIdTemplate: 'carekit.{taskId}.{sampleType}',
  region: { offset: 4310, length: 4 },
  normalize: { mode: 'passthrough', clamp: true },
  ttlMs: 900_000,
};

const OUTCOME_MAPPING = {
  id: 'carekit-outcome',
  region: { offset: 4314, length: 2 },
  normalize: { mode: 'passthrough', clamp: true },
  ttlMs: 900_000,
};

// ── buildCKSensorId ──────────────────────────────────────────────────────────

describe('buildCKSensorId', () => {
  it('uses sample.sensorId directly when provided (highest priority)', () => {
    const sample: CKSample = { sampleType: 'task-adherence', sensorId: 'my.explicit.sensor' };
    expect(buildCKSensorId(sample, TASK_MAPPING, 'carekit-ios-bridge')).toBe('my.explicit.sensor');
  });

  it('uses mapping.sensorId when sample has none', () => {
    const sample: CKSample = { sampleType: 'task-adherence' };
    const mapping = { id: 'x', sensorId: 'mapping.level.sensor' };
    expect(buildCKSensorId(sample, mapping, 'carekit-ios-bridge')).toBe('mapping.level.sensor');
  });

  it('expands {sampleType} in template', () => {
    const sample: CKSample = { sampleType: 'task-adherence', taskId: 'morning-medication' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{sampleType}' }, 'b');
    expect(id).toBe('ck.task-adherence');
  });

  it('expands {type} as alias for {sampleType} (LSP compat)', () => {
    const sample: CKSample = { sampleType: 'task-completion' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{type}' }, 'b');
    expect(id).toBe('ck.task-completion');
  });

  it('expands {taskId} in template', () => {
    const sample: CKSample = { sampleType: 'task-adherence', taskId: 'morning-medication' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{taskId}' }, 'b');
    expect(id).toBe('ck.morning-medication');
  });

  it('falls back {taskId} to sampleType when taskId is absent', () => {
    const sample: CKSample = { sampleType: 'task-adherence' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{taskId}' }, 'b');
    expect(id).toBe('ck.task-adherence');
  });

  it('expands {carePlanId} in template', () => {
    const sample: CKSample = { sampleType: 'task-adherence', carePlanId: 'plan-alpha' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{carePlanId}' }, 'b');
    expect(id).toBe('ck.plan-alpha');
  });

  it('falls back {carePlanId} to "care-plan" when absent', () => {
    const sample: CKSample = { sampleType: 'task-adherence' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{carePlanId}' }, 'b');
    expect(id).toBe('ck.care-plan');
  });

  it('expands {bridgeId} in template', () => {
    const sample: CKSample = { sampleType: 'task-adherence' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: '{bridgeId}.sensor' }, 'my-bridge');
    expect(id).toBe('my-bridge.sensor');
  });

  it('sanitises special characters in template tokens', () => {
    const sample: CKSample = { sampleType: 'task/adherence!' };
    const id = buildCKSensorId(sample, { id: 'x', sensorIdTemplate: 'ck.{sampleType}' }, 'b');
    // sourceIdPart replaces non-alphanumeric (except . _ -) with _ and strips leading/trailing _
    expect(id).toBe('ck.task_adherence');
  });

  // ── Parity assertions — results must match CPP build_carekit_signal and
  //    LSP render-sensor-template for the same inputs ──────────────────────

  it('[parity] fallback path: "carekit." + source_id_part(sampleType)', () => {
    // No sensorId, no template — CPP fallback: "carekit." + source_id_part(sampleType)
    // LSP fallback: same formula. TypeScript: same.
    const sample: CKSample = { sampleType: 'task-adherence' };
    const id = buildCKSensorId(sample, { id: 'x' }, 'carekit-ios-bridge');
    expect(id).toBe('carekit.task-adherence');
  });

  it('[parity] type alias resolves to sampleType value (CPP / LSP compat)', () => {
    // When sampleType is absent but `type` is present — all three impls use `type`
    const sample: CKSample = { type: 'task-completion' };
    const id = buildCKSensorId(sample, { id: 'x' }, 'b');
    expect(id).toBe('carekit.task-completion');
  });

  it('[parity] FALLBACK_SAMPLE_TYPE when no sampleType or type provided', () => {
    // CPP / LSP both default to "task-event" when no type field present
    const sample: CKSample = {};
    const id = buildCKSensorId(sample, { id: 'x' }, 'b');
    expect(id).toBe('carekit.task-event');
  });
});

// ── checkCareKitAuth ─────────────────────────────────────────────────────────

describe('checkCareKitAuth', () => {
  it('returns true when no token is expected (open / dev mode)', () => {
    expect(checkCareKitAuth(undefined, {})).toBe(true);
  });

  it('returns true when bridgeToken matches expected token', () => {
    expect(checkCareKitAuth('secret', { bridgeToken: 'secret' })).toBe(true);
  });

  it('returns true when token (LSP alias) matches expected token', () => {
    expect(checkCareKitAuth('secret', { token: 'secret' })).toBe(true);
  });

  it('prefers bridgeToken over token when both present', () => {
    expect(checkCareKitAuth('correct', { bridgeToken: 'correct', token: 'wrong' })).toBe(true);
  });

  it('returns false when token does not match', () => {
    expect(checkCareKitAuth('secret', { bridgeToken: 'wrong' })).toBe(false);
  });

  it('returns false when token is required but absent', () => {
    expect(checkCareKitAuth('secret', {})).toBe(false);
  });
});

// ── resolveCKOne ─────────────────────────────────────────────────────────────

describe('resolveCKOne — happy path', () => {
  it('resolves a valid task-adherence sample', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = {
      sampleType: 'task-adherence',
      taskId: 'morning-medication',
      carePlanId: 'plan-a',
      values: [0.85, 0, 0.9, 0],
    };
    const result = resolveCKOne(sample, registry, 'carekit-ios-bridge', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.sampleType).toBe('task-adherence');
    expect(result.taskId).toBe('morning-medication');
    expect(result.carePlanId).toBe('plan-a');
    expect(result.sourceMappingId).toBe('carekit-task');
    expect(result.sensorId).toBe('carekit.morning-medication.task-adherence');
    expect(result.region).toEqual({ offset: 4310, length: 4 });
    expect(result.values).toHaveLength(4);
    expect(result.ttlMs).toBe(900_000);
  });

  it('accepts singular value alias', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', value: 0.75 };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.values[0]).toBeCloseTo(0.75);
  });

  it('accepts vector alias for values (LSP compat)', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', vector: [0.5, 0.6, 0.7, 0.8] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.values[0]).toBeCloseTo(0.5);
  });

  it('pads values when fewer than region.length supplied', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', values: [0.5] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.values).toHaveLength(4);
    expect(result.values[1]).toBe(0);
  });

  it('truncates values when more than region.length supplied', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.values).toHaveLength(4);
  });

  it('uses sample.region over mapping.region when both present', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = {
      sampleType: 'task-adherence',
      values: [0.5, 0.5],
      region: { offset: 9000, length: 2 },
    };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.region).toEqual({ offset: 9000, length: 2 });
  });

  it('uses mapping.ttlMs as fallback when sample.ttlMs absent', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', values: [0.5] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.ttlMs).toBe(900_000);
  });

  it('uses sample.ttlMs when provided', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', values: [0.5], ttlMs: 60_000 };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.ttlMs).toBe(60_000);
  });

  it('resolves with explicit sourceMappingId overriding the default', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [TASK_MAPPING, OUTCOME_MAPPING],
    });
    const sample: CKSample = {
      sampleType: 'task-outcome',
      values: [0.8, 0.9],
      sourceMappingId: 'carekit-outcome',
    };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.sourceMappingId).toBe('carekit-outcome');
    expect(result.region).toEqual({ offset: 4314, length: 2 });
  });
});

describe('resolveCKOne — errors', () => {
  it('returns error when mapping is not in registry', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [] });
    const sample: CKSample = { sampleType: 'task-adherence', values: [0.5] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected error');
    expect(result.reason).toMatch(/no registry mapping/);
  });

  it('returns error when mapping lacks region', () => {
    const registry = registryWith({
      integrations: [],
      sourceMappings: [{ id: 'carekit-task' }],
    });
    const sample: CKSample = { sampleType: 'task-adherence', values: [0.5] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected error');
    expect(result.reason).toMatch(/region/);
  });

  it('returns error when values contain non-finite numbers', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const sample: CKSample = { sampleType: 'task-adherence', values: [NaN] };
    const result = resolveCKOne(sample, registry, 'b', 'carekit-task');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected error');
    expect(result.reason).toMatch(/finite/);
  });
});

// ── resolveCKBatch ────────────────────────────────────────────────────────────

describe('resolveCKBatch — single-sample inline path', () => {
  it('resolves a single inline sample (no samples[] array)', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const payload: CKIngestPayload = {
      bridgeId: 'carekit-ios-bridge',
      sampleType: 'task-adherence',
      values: [0.9, 0, 0.8, 0],
    };
    const { results } = resolveCKBatch(payload, registry, 'carekit-ios-bridge', 'carekit-task');
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });
});

describe('resolveCKBatch — batch path', () => {
  it('resolves all valid samples in samples[]', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING, OUTCOME_MAPPING] });
    const payload: CKIngestPayload = {
      bridgeId: 'carekit-ios-bridge',
      samples: [
        { sampleType: 'task-adherence', values: [0.8, 0, 0.9, 0] },
        { sampleType: 'task-outcome', values: [0.7, 0.8], sourceMappingId: 'carekit-outcome' },
      ],
    };
    const { results } = resolveCKBatch(payload, registry, 'carekit-ios-bridge', 'carekit-task');
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(true);
  });

  it('[parity CPP] merges top-level payload fields into each sample', () => {
    // CPP semantics: parent fields (minus samples/bridgeToken) merged into each sample.
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const payload: CKIngestPayload = {
      bridgeId: 'carekit-ios-bridge',
      carePlanId: 'plan-parent',       // top-level field to be merged
      samples: [
        { sampleType: 'task-adherence', values: [0.8, 0, 0.9, 0] },
      ],
    };
    const { results } = resolveCKBatch(payload, registry, 'carekit-ios-bridge', 'carekit-task');
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    if (!results[0]!.success) throw new Error();
    // carePlanId from top-level should appear in the result
    expect(results[0]!.carePlanId).toBe('plan-parent');
  });

  it('[parity CPP] sample-level fields override top-level fields', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const payload: CKIngestPayload = {
      bridgeId: 'carekit-ios-bridge',
      carePlanId: 'plan-parent',
      samples: [
        { sampleType: 'task-adherence', values: [0.8, 0, 0.9, 0], carePlanId: 'plan-override' },
      ],
    };
    const { results } = resolveCKBatch(payload, registry, 'carekit-ios-bridge', 'carekit-task');
    expect(results[0]!.success).toBe(true);
    if (!results[0]!.success) throw new Error();
    expect(results[0]!.carePlanId).toBe('plan-override');
  });

  it('produces an error entry when one sample fails and success for others (207-style)', () => {
    const registry = registryWith({ integrations: [], sourceMappings: [TASK_MAPPING] });
    const payload: CKIngestPayload = {
      bridgeId: 'carekit-ios-bridge',
      samples: [
        { sampleType: 'task-adherence', values: [0.8, 0, 0.9, 0] },
        { sampleType: 'task-outcome', values: [0.5], sourceMappingId: 'missing-mapping' },
      ],
    };
    const { results } = resolveCKBatch(payload, registry, 'carekit-ios-bridge', 'carekit-task');
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
  });

  it('uses provided bridgeId / defaultMappingId defaults when not specified', () => {
    // Called with no bridgeId / defaultMappingId — should not throw
    const registry = registryWith({ integrations: [], sourceMappings: [
      { ...TASK_MAPPING, id: 'carekit-task' },
    ] });
    const payload: CKIngestPayload = {
      sampleType: 'task-adherence',
      values: [0.5, 0, 0.5, 0],
    };
    // Use defaults (no 3rd/4th arg)
    const { results } = resolveCKBatch(payload, registry);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });
});

// ── buildCKStatusBody ─────────────────────────────────────────────────────────

describe('buildCKStatusBody', () => {
  it('includes both tokenConfigured (CPP) and tokenRequired (LSP) fields', () => {
    const body = buildCKStatusBody('carekit-ios-bridge', 'carekit-task', true);
    expect(body.tokenConfigured).toBe(true);
    expect(body.tokenRequired).toBe(true);
  });

  it('reflects tokenConfigured=false in auth contract', () => {
    const body = buildCKStatusBody('carekit-ios-bridge', 'carekit-task', false);
    expect(body.tokenConfigured).toBe(false);
    expect(body.tokenRequired).toBe(false);
    expect(body.contract.auth).toBe('external-transport');
  });

  it('sets auth to bridgeToken when token is configured', () => {
    const body = buildCKStatusBody('carekit-ios-bridge', 'carekit-task', true);
    expect(body.contract.auth).toBe('bridgeToken');
  });

  it('carries required identity and endpoint fields', () => {
    const body = buildCKStatusBody('carekit-ios-bridge', 'carekit-task', false);
    expect(body.bridgeId).toBe('carekit-ios-bridge');
    expect(body.defaultSourceMappingId).toBe('carekit-task');
    expect(body.nativeAppRequired).toBe(true);
    expect(body.nativeWorkOutsideRepo).toBe(true);
    expect(body.statusEndpoint).toBe('/api/integrations/carekit/status');
    expect(body.ingestEndpoint).toBe('/api/integrations/carekit/ingest');
  });

  it('includes singleSample and batchSamples in contract', () => {
    const body = buildCKStatusBody('carekit-ios-bridge', 'carekit-task', false);
    expect(body.contract.singleSample).toContain('sampleType');
    expect(body.contract.batchSamples).toContain('samples[]');
  });
});
