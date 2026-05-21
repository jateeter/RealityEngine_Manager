/**
 * SourceMapper — resolves a provider-neutral completion request into a
 * concrete signal body that `POST /api/signals` (or its in-process
 * equivalent) can commit.
 *
 * Wire-compatible with `RealityEngine_CPP::ingest_completion` in
 * src/perception_engine_server.cpp.  The contract:
 *
 *   1. Look up `body.sourceMappingId` (or legacy alias `mappingId`) in the
 *      registry.  An unknown id is a 404 — `Unknown sourceMappingId "<id>"`.
 *   2. If `body.sourceMapping` is supplied inline, merge it on top of the
 *      registry mapping (inline wins per key).
 *   3. Pick `sensorId` from, in order: body.sensorId → mapping.sensorId →
 *      mapping.sensorIdTemplate with `{provider}/{agent}/{correlationId}/
 *      {envelopeId}` substituted → fallback `agent.<agent>.completion`.
 *   4. Build a signal body { sensorId, name, region, values, active, ttlMs,
 *      triggerPush, compactPush } using mapping + body defaults.
 *
 * The Phase-1 default for `triggerPush` is `false` (commit-only) so a
 * provider can land a completion without driving the perception cycle.
 */

import type { RegistryState, SourceMapping } from './types.js';

// ── Public request / result shapes ──────────────────────────────────────────

export interface CompletionRequest {
  // Identity / correlation
  provider?: string;
  agent?: string;
  agentId?: string;            // alias accepted; agent wins
  correlationId?: string;
  envelopeId?: string;
  completionId?: string;
  id?: string;                 // alias accepted; completionId wins

  // Mapping resolution
  sourceMappingId?: string;
  mappingId?: string;          // alias accepted; sourceMappingId wins
  sourceMapping?: Partial<SourceMapping>; // inline override / merge

  // Direct signal payload (overrides resolved mapping when present)
  sensorId?: string;
  name?: string;
  region?: { offset: number; length: number };
  values?: number[];
  active?: boolean;
  ttlMs?: number;
  triggerPush?: boolean;
  compactPush?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ResolvedSignal {
  sensorId: string;
  name?: string;
  region?: { offset: number; length: number };
  values: number[];
  active: boolean;
  ttlMs: number;
  triggerPush: boolean;
  compactPush: boolean;
}

export interface CompletionContext {
  provider: string;
  agent: string;
  correlationId: string;
  envelopeId: string;
  completionId: string;
  sourceMappingId: string;
  metadata?: Record<string, unknown>;
  /** Effective mapping (after registry lookup + inline merge). */
  mapping: Partial<SourceMapping>;
}

export interface ResolveSuccess {
  ok: true;
  signal: ResolvedSignal;
  ctx: CompletionContext;
}

export interface ResolveError {
  ok: false;
  status: number;
  error: string;
}

export type ResolveResult = ResolveSuccess | ResolveError;

// ── Defaults (match C++ defaults) ───────────────────────────────────────────

const DEFAULT_PROVIDER = 'external';
const DEFAULT_AGENT = 'agent';
const DEFAULT_TTL_MS = 300_000;
const DEFAULT_TRIGGER_PUSH = false;   // commit-only — matches C++
const DEFAULT_COMPACT_PUSH = true;    // matches C++

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip a string down to characters safe to embed in a sensorId.  C++ uses
 * `source_id_part()`; we mirror by collapsing anything outside
 * `[A-Za-z0-9._-]` into `_`, and trimming leading/trailing underscores.
 */
export function sourceIdPart(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Substitute the four standard template tokens into a sensorIdTemplate. */
export function substituteSensorIdTemplate(
  template: string,
  parts: { provider: string; agent: string; correlationId: string; envelopeId: string },
): string {
  return template
    .replace(/\{provider\}/g, sourceIdPart(parts.provider))
    .replace(/\{agent\}/g, sourceIdPart(parts.agent))
    .replace(/\{correlationId\}/g, sourceIdPart(parts.correlationId))
    .replace(/\{envelopeId\}/g, sourceIdPart(parts.envelopeId));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

function asNumber(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function asNumberArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return null;
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return v as number[];
}

function asRegion(v: unknown): { offset: number; length: number } | null {
  if (!isPlainObject(v)) return null;
  const offset = (v as Record<string, unknown>).offset;
  const length = (v as Record<string, unknown>).length;
  if (typeof offset !== 'number' || typeof length !== 'number') return null;
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return null;
  return { offset, length };
}

// ── resolveCompletion ───────────────────────────────────────────────────────

/**
 * Resolve a CompletionRequest against the registry.  Returns either an
 * actionable {signal, ctx} pair or a typed error matching the C++ status
 * codes and message format.
 */
export function resolveCompletion(
  body: CompletionRequest,
  registry: RegistryState,
): ResolveResult {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: 'completion body must be a JSON object' };
  }

  const sourceMappingId = asString(body.sourceMappingId, asString(body.mappingId, ''));
  let mapping: Partial<SourceMapping> = {};
  if (sourceMappingId !== '') {
    const found = registry.sourceMappingIndex.get(sourceMappingId);
    if (!found) {
      return {
        ok: false,
        status: 404,
        error: `Unknown sourceMappingId "${sourceMappingId}"`,
      };
    }
    mapping = found;
  }

  // Inline `sourceMapping` is merged on top of the registry entry, key-by-key.
  if (isPlainObject(body.sourceMapping)) {
    mapping = { ...mapping, ...body.sourceMapping } as Partial<SourceMapping>;
  }

  const provider = asString(body.provider, DEFAULT_PROVIDER);
  const agent = asString(body.agent, asString(body.agentId, DEFAULT_AGENT));
  const correlationId = asString(body.correlationId, '');
  const envelopeId = asString(body.envelopeId, '');
  const completionId = asString(body.completionId, asString(body.id, ''));

  // Resolve sensorId:
  //   1. body.sensorId  2. mapping.sensorId
  //   3. substitute mapping.sensorIdTemplate  4. agent.<agent>.completion
  let sensorId = asString(body.sensorId, '');
  if (sensorId === '') sensorId = asString(mapping.sensorId, '');
  if (sensorId === '' && typeof mapping.sensorIdTemplate === 'string') {
    sensorId = substituteSensorIdTemplate(mapping.sensorIdTemplate, {
      provider, agent, correlationId, envelopeId,
    });
  }
  if (sensorId === '') sensorId = `agent.${sourceIdPart(agent)}.completion`;

  // Values: body.values (preferred) → mapping.values (registry-declared canary).
  let values = asNumberArray(body.values);
  if (!values) values = asNumberArray((mapping as Record<string, unknown>).values);
  if (!values) {
    return { ok: false, status: 400, error: 'values must be a non-empty array of numbers' };
  }

  // Region: body.region overrides mapping.region (matches C++ — inline wins).
  const region = asRegion(body.region) ?? asRegion(mapping.region);

  // name: explicit > mapping > derived "agent:<provider>/<agent>/completion".
  let name = asString(body.name, '');
  if (name === '') name = asString((mapping as Record<string, unknown>).name, '');
  if (name === '') name = `agent:${provider}/${agent}/completion`;

  const active = asBool(body.active, asBool((mapping as Record<string, unknown>).active, true));
  const ttlMs = asNumber(body.ttlMs, asNumber((mapping as Record<string, unknown>).ttlMs, DEFAULT_TTL_MS));
  const triggerPush = asBool(body.triggerPush, DEFAULT_TRIGGER_PUSH);
  const compactPush = asBool(body.compactPush, DEFAULT_COMPACT_PUSH);

  const signal: ResolvedSignal = {
    sensorId,
    name,
    region: region ?? undefined,
    values,
    active,
    ttlMs,
    triggerPush,
    compactPush,
  };

  const ctx: CompletionContext = {
    provider,
    agent,
    correlationId,
    envelopeId,
    completionId,
    sourceMappingId,
    mapping,
    metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
  };

  return { ok: true, signal, ctx };
}
