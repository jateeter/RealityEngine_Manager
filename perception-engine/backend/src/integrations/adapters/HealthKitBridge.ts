/**
 * HealthKitBridge — server-side intake for the device-resident HealthKit
 * bridge.
 *
 * Architectural rule: HealthKit authorization, anchored reads, and any
 * user-confirmed writes live on the device.  PE never speaks HealthKit
 * directly; it just receives authenticated batches of {@link HKSample}
 * values and maps each one onto a sensor source.
 *
 * **HKDataValues are unique sources in the PE.**  Each
 * `(typeIdentifier × source-name)` pair gets its own deterministic
 * `sensorId`, its own region in the perceptual vector, and its own
 * normalize block.  This is why one bridge POST routinely fans out into
 * many sensor-source updates (one per sample type the device emitted
 * during the anchored window).
 *
 * Resolution order for each sample:
 *
 *   1. Registry lookup by `healthkit:<typeIdentifier>` — declared source
 *      mapping wins (region, sensorIdTemplate, ttlMs, normalize).
 *   2. Registry lookup by `healthkit:<typeIdentifier>:<source-name>` —
 *      finer-grained mapping for one specific Apple Watch / iPhone.
 *   3. Fallback: auto-derive a sensorId from the type identifier; reject
 *      the sample (per-sample 400) when no region can be resolved.  The
 *      bridge MUST declare regions for new HK types; we deliberately
 *      don't allocate offsets at runtime.
 */

import type { RegistryState, SourceMapping } from '../types.js';
import { applyNormalize, type NormalizeSpec } from '../extractors.js';

// ── Bridge payload contract ───────────────────────────────────────────────

/**
 * One HealthKit reading the bridge has already de-anchored and converted
 * into a numeric (or coded-numeric) value.  Mirrors HKSample on the
 * device side, with a couple of HK-isms collapsed away:
 *
 *   • Quantity types: `value` is the numeric reading (units are recorded
 *     in `unit` for audit only — the registry's normalize block does the
 *     range conversion).
 *   • Category types: `value` is the integer category code (e.g.
 *     HKCategoryValueSleepAnalysis.inBed = 0).
 *   • Workout types: arrays of summary stats are expressed via repeated
 *     samples (one per stat) so the contract stays scalar.
 *
 * Optional fields are passed through to the source's metadata.
 */
export interface HKSample {
  /** HealthKit type identifier — e.g. "HKQuantityTypeIdentifierHeartRate". */
  type: string;
  /** Numeric reading.  Category codes use the integer enum value. */
  value: number;
  /** ISO-8601 timestamps.  `endDate` is what advances the source's lastUpdated. */
  startDate?: string;
  endDate?: string;
  /** HK unit string ("count/min", "mmHg", "kcal", …).  Audit only. */
  unit?: string;
  /** Distinguishes Apple Watch vs iPhone vs third-party — drives the sensorId suffix. */
  sourceName?: string;
  /** Free-form per-sample metadata. */
  metadata?: Record<string, unknown>;
}

export interface HKBridgePayload {
  /** Stable bridge identity (matches an integrations[].id of kind:"healthkit"). */
  bridgeId: string;
  /** Opaque device identifier — appears in derived sensorIds when set. */
  deviceId?: string;
  /** Bridge-managed anchor token (echoed back so the device can resume). */
  anchorToken?: string;
  /** ISO-8601 — when the bridge built this batch.  Audit only. */
  emittedAt?: string;
  /** One or more readings.  Each lands as its own sensor-source update. */
  samples: HKSample[];
}

export interface HKBridgeAuth {
  /** Shared secret expected on the Authorization header (Bearer scheme). */
  apiKey?: string;
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolved per-sample payload — ready to feed into the PE's
 * `ingestSignal()`.  `region` is required (unmapped samples fall into
 * the `unmapped` bucket of the result).
 */
export interface ResolvedHKSample {
  sensorId: string;
  name: string;
  region: { offset: number; length: number };
  values: number[];
  ttlMs: number;
  /** Echoes the originating sample, plus the mapping id used. */
  origin: {
    type: string;
    sourceName?: string;
    sourceMappingId?: string;
    unit?: string;
    startDate?: string;
    endDate?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface HKResolution {
  resolved: ResolvedHKSample[];
  /** Samples we couldn't map — reported back in the HTTP response. */
  unmapped: Array<{ type: string; sourceName?: string; reason: string }>;
}

const DEFAULT_TTL_MS = 60 * 60_000;       // one hour — most HK reads back-fill on a coarse cadence.
const HK_PREFIX = 'healthkit:';

/**
 * Build a stable, deterministic sensorId for one HK sample.  Each
 * (type, sourceName) pair maps to a distinct sensorId.  Operators can
 * override via mapping.sensorIdTemplate using the standard
 * `{provider}/{agent}/{type}/{source}` tokens.
 */
export function deriveHKSensorId(sample: HKSample, mapping?: Partial<SourceMapping>): string {
  if (typeof mapping?.sensorId === 'string' && mapping.sensorId !== '') return mapping.sensorId;
  const tpl = typeof mapping?.sensorIdTemplate === 'string' ? mapping.sensorIdTemplate : '';
  if (tpl !== '') {
    return tpl
      .replace(/\{type\}/g, sourceIdPart(sample.type))
      .replace(/\{source\}/g, sourceIdPart(sample.sourceName))
      .replace(/\{provider\}/g, 'healthkit')
      .replace(/\{agent\}/g, sourceIdPart(sample.sourceName));
  }
  // Fallback: collapse "HKQuantityTypeIdentifierHeartRate" → "heartrate",
  // then suffix the source name (so per-device sources stay distinct).
  const slug = compactHKIdentifier(sample.type);
  const suffix = sample.sourceName ? `.${sourceIdPart(sample.sourceName)}` : '';
  return `hk.${slug}${suffix}`;
}

/**
 * Resolve every sample against the registry.  Mappings are keyed by
 * `healthkit:<typeIdentifier>` (broad) or
 * `healthkit:<typeIdentifier>:<sourceName>` (specific).  Specific wins.
 *
 * Throws nothing — unresolved samples land in `unmapped` so the caller
 * can return a 207-style mixed result without losing the good rows.
 */
export function resolveHKBatch(payload: HKBridgePayload, registry: RegistryState): HKResolution {
  const out: HKResolution = { resolved: [], unmapped: [] };
  for (const sample of payload.samples ?? []) {
    if (!sample || typeof sample.type !== 'string' || sample.type === '') {
      out.unmapped.push({ type: String(sample?.type ?? ''), reason: 'sample.type is required' });
      continue;
    }
    if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) {
      out.unmapped.push({ type: sample.type, sourceName: sample.sourceName, reason: 'sample.value must be a finite number' });
      continue;
    }
    const mapping = lookupMapping(registry, sample);
    if (!mapping) {
      out.unmapped.push({ type: sample.type, sourceName: sample.sourceName, reason: 'no registry mapping (declare healthkit:<type>[:<sourceName>])' });
      continue;
    }
    const region = mapping.region;
    if (!region || typeof region.offset !== 'number' || typeof region.length !== 'number') {
      out.unmapped.push({ type: sample.type, sourceName: sample.sourceName, reason: 'mapping is missing region.offset/region.length' });
      continue;
    }
    const sensorId = deriveHKSensorId(sample, mapping);
    const normalize = mapping['normalize'] as NormalizeSpec | undefined;
    const raw = [sample.value];
    // Per-sample length expansion — operators can declare length>1 for
    // category types whose code we want to one-hot, but for now we
    // commit a length-1 region as the single raw value (normalize block
    // can broadcast/clamp).  When length>1 and the registry declares a
    // multi-cell normalize, downstream operators should adjust the
    // mapping; we don't fabricate extra cells here.
    const values = applyNormalize(raw, normalize);
    const padded = values.length >= region.length
      ? values.slice(0, region.length)
      : padRight(values, region.length, 0);
    const ttlMs = typeof mapping.ttlMs === 'number' && Number.isFinite(mapping.ttlMs)
      ? mapping.ttlMs
      : DEFAULT_TTL_MS;

    out.resolved.push({
      sensorId,
      name: typeof mapping['name'] === 'string' ? mapping['name'] as string : `healthkit:${sample.type}`,
      region: { offset: region.offset, length: region.length },
      values: padded,
      ttlMs,
      origin: {
        type: sample.type,
        sourceName: sample.sourceName,
        sourceMappingId: mapping.id,
        unit: sample.unit,
        startDate: sample.startDate,
        endDate: sample.endDate,
        metadata: sample.metadata,
      },
    });
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function lookupMapping(registry: RegistryState, sample: HKSample): SourceMapping | undefined {
  const idx = registry.sourceMappingIndex;
  if (sample.sourceName) {
    const specific = idx.get(`${HK_PREFIX}${sample.type}:${sample.sourceName}`);
    if (specific) return specific;
  }
  return idx.get(`${HK_PREFIX}${sample.type}`);
}

/**
 * Strip the `HK…TypeIdentifier` prefix from an HK type and lowercase
 * what remains, so "HKQuantityTypeIdentifierHeartRate" becomes
 * "heartrate" for use inside derived sensorIds.
 */
function compactHKIdentifier(type: string): string {
  return type
    .replace(/^HK(Quantity|Category|Workout|Correlation|Document|Clinical|Series)?TypeIdentifier/, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase() || 'unknown';
}

function sourceIdPart(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function padRight(arr: number[], len: number, fill: number): number[] {
  if (arr.length >= len) return arr;
  return arr.concat(new Array(len - arr.length).fill(fill));
}

// ── Auth check ────────────────────────────────────────────────────────────

/**
 * Bridge auth is the single shared secret declared on the
 * `integrations[].apiKey` field for the matching `kind:"healthkit"`
 * entry.  When the integration omits an API key, the bridge is treated
 * as open (handy for local dev — production should always set one).
 */
export function checkBridgeAuth(
  registry: RegistryState,
  bridgeId: string,
  presentedKey: string | undefined,
): { ok: true; integration: Record<string, unknown> } | { ok: false; status: 401 | 404; error: string } {
  const integrations = Array.isArray(registry.config.integrations) ? registry.config.integrations : [];
  const entry = (integrations as Array<Record<string, unknown>>).find(
    (i) => i && i['kind'] === 'healthkit' && i['id'] === bridgeId,
  );
  if (!entry) {
    return { ok: false, status: 404, error: `Unknown healthkit bridgeId "${bridgeId}"` };
  }
  const expected = typeof entry['apiKey'] === 'string' ? (entry['apiKey'] as string) : '';
  if (expected !== '' && presentedKey !== expected) {
    return { ok: false, status: 401, error: 'HealthKit bridge auth failed' };
  }
  return { ok: true, integration: entry };
}
