/**
 * CareKitBridge — server-side intake for the device-resident CareKit bridge.
 *
 * Architectural rule: the native Apple app owns the CareKit store, care plans,
 * tasks, outcomes, contacts, UI, consent, and any device-resident writeback.
 * PE never speaks CareKit directly; it receives pre-normalised task/outcome
 * payloads and maps each one onto a sensor source.
 *
 * Wire-compatible with:
 *   RealityEngine_CPP  `ingest_carekit()` / `build_carekit_signal()` — C++
 *   RealityEngine_LSP  `ingest-carekit` / `ingest-carekit-one` — Common Lisp
 *
 * Auth: optional shared token.  When `CAREKIT_BRIDGE_TOKEN` is set (or the
 * matching `integrations[].bridgeToken` in the registry), every ingest
 * request must carry the same token in `body.bridgeToken` or `body.token`.
 * When the token is absent the bridge is open (dev / private-network use).
 *
 * sensorId resolution order for each sample:
 *   1. `body.sensorId` — explicit caller-supplied id wins.
 *   2. `mapping.sensorId` — declared mapping id (rare).
 *   3. `mapping.sensorIdTemplate` with four substitution tokens:
 *        {bridgeId}    effective bridge id
 *        {sampleType}  (or {type}) — kebab-case sample type
 *        {taskId}      task identifier (falls back to sampleType)
 *        {carePlanId}  care-plan identifier (falls back to "care-plan")
 *   4. Fallback: `"carekit." + source_id_part(sampleType)`
 *
 * Mapping lookup order for each sample:
 *   1. `body.sourceMappingId` — explicit caller override.
 *   2. `defaultSourceMappingId` arg (from `CAREKIT_DEFAULT_SOURCE_MAPPING_ID`
 *      env or registry `integrations[].defaultSourceMappingId`).
 */

import type { RegistryState, SourceMapping } from '../types.js';
import { applyNormalize, type NormalizeSpec } from '../extractors.js';

// ── Payload contract ──────────────────────────────────────────────────────────

/** One CareKit task/outcome sample the native bridge has already normalised. */
export interface CKSample {
  /** Primary type identifier, e.g. "task-adherence", "task-completion". */
  sampleType?: string;
  /** Deprecated alias for sampleType (backward compat with CPP v1 clients). */
  type?: string;
  /** CK task identifier, e.g. "morning-medication". */
  taskId?: string;
  /** CK care-plan identifier, e.g. "care-plan-a". */
  carePlanId?: string;
  /** Source mapping id — overrides the bridge default. */
  sourceMappingId?: string;
  /** Explicit sensor id — skips template substitution entirely. */
  sensorId?: string;
  /** Human-readable name for the resulting sensor source. */
  name?: string;
  /** Pre-normalised values, expected in [0, 1].  Alias `vector` accepted (LSP compat). */
  values?: number[];
  /** Singular value alias when only one cell is emitted. */
  value?: number;
  /** LSP-compatibility alias for `values`. */
  vector?: number[];
  /** Perceptual region override — usually declared in the source mapping. */
  region?: { offset: number; length: number };
  active?: boolean;
  ttlMs?: number;
  triggerPush?: boolean;
  compactPush?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CKIngestPayload {
  /** Bridge identity, used in template substitution and broadcast events. */
  bridgeId?: string;
  /** Shared secret (body-field auth — matches CPP / LSP pattern). */
  bridgeToken?: string;
  /** LSP alias for bridgeToken (both accepted). */
  token?: string;
  /** Batch path: when present, each entry is merged with top-level fields. */
  samples?: CKSample[];
  /** All CKSample fields may appear inline for the single-sample path. */
  [key: string]: unknown;
}

// ── Per-sample result ────────────────────────────────────────────────────────

export interface CKSampleResult {
  success: true;
  sampleType: string;
  taskId: string | null;
  carePlanId: string | null;
  sourceMappingId: string;
  sensorId: string;
  region: { offset: number; length: number };
  values: number[];
  ttlMs: number;
}

export interface CKSampleError {
  success: false;
  sampleType: string;
  taskId?: string;
  carePlanId?: string;
  reason: string;
}

export interface CKResolution {
  results: Array<CKSampleResult | CKSampleError>;
}

// ── Constants matching CPP / LSP defaults ─────────────────────────────────────

const DEFAULT_BRIDGE_ID = 'carekit-ios-bridge';
const DEFAULT_SOURCE_MAPPING_ID = 'carekit-task';
const DEFAULT_TTL_MS = 900_000;          // 15 min — matches LSP default
const FALLBACK_SAMPLE_TYPE = 'task-event';
const FALLBACK_CARE_PLAN_ID = 'care-plan';

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Validate the optional bridge token.  Wire-compatible with CPP (checks
 * `body.bridgeToken`) and LSP (also accepts `body.token`).
 *
 * Returns `true` when auth passes (no token required, or presented token
 * matches the expected value).
 */
export function checkCareKitAuth(
  expectedToken: string | undefined,
  body: CKIngestPayload,
): boolean {
  if (!expectedToken) return true;
  const presented = typeof body.bridgeToken === 'string'
    ? body.bridgeToken
    : typeof body.token === 'string' ? body.token : '';
  return presented === expectedToken;
}

// ── sensorId derivation ───────────────────────────────────────────────────────

/**
 * Build a sensorId for one CareKit sample.
 * Token substitution order matches CPP `build_carekit_signal` and LSP
 * `render-sensor-template`.
 */
export function buildCKSensorId(
  sample: CKSample,
  mapping: Partial<SourceMapping>,
  bridgeId: string,
): string {
  const sampleType = sampleTypeOf(sample);

  if (typeof sample.sensorId === 'string' && sample.sensorId !== '') return sample.sensorId;
  if (typeof mapping.sensorId === 'string' && mapping.sensorId !== '') return mapping.sensorId;

  const tpl = typeof mapping.sensorIdTemplate === 'string' ? mapping.sensorIdTemplate : '';
  if (tpl !== '') {
    return tpl
      .replace(/\{bridgeId\}/g, sourceIdPart(bridgeId))
      .replace(/\{sampleType\}/g, sourceIdPart(sampleType))
      .replace(/\{type\}/g, sourceIdPart(sampleType))
      .replace(/\{taskId\}/g, sourceIdPart(sample.taskId ?? sampleType))
      .replace(/\{carePlanId\}/g, sourceIdPart(sample.carePlanId ?? FALLBACK_CARE_PLAN_ID));
  }

  // Fallback — matches CPP: "carekit." + source_id_part(sampleType)
  return `carekit.${sourceIdPart(sampleType)}`;
}

// ── Batch resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a single CK sample against the registry.
 * Wire-compatible with CPP `ingest_carekit_one` and LSP `ingest-carekit-one`.
 */
export function resolveCKOne(
  sample: CKSample,
  registry: RegistryState,
  bridgeId: string,
  defaultMappingId: string,
): CKSampleResult | CKSampleError {
  const sampleType = sampleTypeOf(sample);

  // Values: body.values → body.vector → [body.value] → []
  const rawValues = Array.isArray(sample.values) ? sample.values
    : Array.isArray(sample.vector) ? sample.vector
    : typeof sample.value === 'number' && Number.isFinite(sample.value) ? [sample.value]
    : [];

  if (rawValues.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return { success: false, sampleType, taskId: sample.taskId, carePlanId: sample.carePlanId, reason: 'values must be finite numbers' };
  }

  const mappingId = typeof sample.sourceMappingId === 'string' && sample.sourceMappingId !== ''
    ? sample.sourceMappingId
    : defaultMappingId;

  const mapping = registry.sourceMappingIndex.get(mappingId);
  if (!mapping) {
    return { success: false, sampleType, taskId: sample.taskId, carePlanId: sample.carePlanId, reason: `no registry mapping for sourceMappingId "${mappingId}"` };
  }

  const region = (sample.region && typeof sample.region.offset === 'number' && typeof sample.region.length === 'number')
    ? sample.region
    : (mapping.region && typeof mapping.region.offset === 'number' && typeof mapping.region.length === 'number')
      ? mapping.region
      : undefined;

  if (!region) {
    return { success: false, sampleType, taskId: sample.taskId, carePlanId: sample.carePlanId, reason: `mapping "${mappingId}" is missing region.offset / region.length` };
  }

  const sensorId = buildCKSensorId(sample, mapping, bridgeId);

  // Apply normalize pipeline if configured; CareKit default is passthrough+clamp.
  const normalize = (mapping['normalize'] ?? { mode: 'passthrough', clamp: true }) as NormalizeSpec;
  const normalized = applyNormalize(rawValues, normalize);
  const values = normalized.length >= region.length
    ? normalized.slice(0, region.length)
    : padRight(normalized, region.length, 0);

  const ttlMs = typeof sample.ttlMs === 'number' && Number.isFinite(sample.ttlMs)
    ? sample.ttlMs
    : typeof mapping.ttlMs === 'number' && Number.isFinite(mapping.ttlMs)
      ? mapping.ttlMs
      : DEFAULT_TTL_MS;

  return {
    success: true,
    sampleType,
    taskId: sample.taskId ?? null,
    carePlanId: sample.carePlanId ?? null,
    sourceMappingId: mappingId,
    sensorId,
    region,
    values,
    ttlMs,
  };
}

/**
 * Resolve a full CareKit ingest payload (single-sample or batch).
 * Merges top-level fields into each batch sample (CPP / LSP semantics).
 */
export function resolveCKBatch(
  payload: CKIngestPayload,
  registry: RegistryState,
  bridgeId: string = DEFAULT_BRIDGE_ID,
  defaultMappingId: string = DEFAULT_SOURCE_MAPPING_ID,
): CKResolution {
  const results: Array<CKSampleResult | CKSampleError> = [];

  const samples = Array.isArray(payload.samples) ? payload.samples : null;
  if (samples) {
    for (const rawSample of samples) {
      // Merge parent payload fields into each sample (CPP: merge_objects).
      // samples[] and bridgeToken/token are stripped from the merge.
      const merged: CKSample = { ...toSampleFields(payload), ...rawSample };
      results.push(resolveCKOne(merged, registry, bridgeId, defaultMappingId));
    }
  } else {
    // Single-sample inline path.
    results.push(resolveCKOne(toSampleFields(payload), registry, bridgeId, defaultMappingId));
  }

  return { results };
}

// ── Status contract ───────────────────────────────────────────────────────────

/** Wire-compatible with CPP `carekit_status()` and LSP `carekit-status-json`. */
export interface CKStatusBody {
  bridgeId: string;
  defaultSourceMappingId: string;
  /** CPP field name — true when a token is configured. */
  tokenConfigured: boolean;
  /** LSP field name — same semantic, kept for cross-impl compatibility. */
  tokenRequired: boolean;
  nativeAppRequired: true;
  nativeWorkOutsideRepo: true;
  statusEndpoint: '/api/integrations/carekit/status';
  ingestEndpoint: '/api/integrations/carekit/ingest';
  contract: {
    transport: 'https';
    singleSample: string[];
    batchSamples: string[];
    auth: 'external-transport' | 'bridgeToken';
  };
}

export function buildCKStatusBody(
  bridgeId: string,
  defaultSourceMappingId: string,
  tokenConfigured: boolean,
): CKStatusBody {
  return {
    bridgeId,
    defaultSourceMappingId,
    tokenConfigured,
    tokenRequired: tokenConfigured,
    nativeAppRequired: true,
    nativeWorkOutsideRepo: true,
    statusEndpoint: '/api/integrations/carekit/status',
    ingestEndpoint: '/api/integrations/carekit/ingest',
    contract: {
      transport: 'https',
      singleSample: ['bridgeId', 'sampleType', 'sourceMappingId', 'values'],
      batchSamples: ['bridgeId', 'samples[]'],
      auth: tokenConfigured ? 'bridgeToken' : 'external-transport',
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sampleTypeOf(s: CKSample): string {
  return (typeof s.sampleType === 'string' && s.sampleType !== '') ? s.sampleType
    : (typeof s.type === 'string' && s.type !== '') ? s.type
    : FALLBACK_SAMPLE_TYPE;
}

function sourceIdPart(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function padRight(arr: number[], len: number, fill: number): number[] {
  if (arr.length >= len) return arr;
  return arr.concat(new Array(len - arr.length).fill(fill));
}

/** Strip batch-only / auth fields from a payload to produce a sample-shaped object. */
function toSampleFields(payload: CKIngestPayload): CKSample {
  const { samples: _s, bridgeToken: _bt, token: _t, bridgeId: _bid, ...rest } = payload;
  return rest as CKSample;
}
