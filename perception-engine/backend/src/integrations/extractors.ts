/**
 * Payload extractors and normalizers used by the registry's sourceMapping
 * `extract` / `normalize` blocks.
 *
 * `POST /api/integrations/completions` accepts values directly and does
 * **not** call into this module (matching C++ `ingest_completion`).  These
 * helpers exist for the Phase 4 provider adapters (HealthKit / Ollama /
 * OpenAI) whose raw provider payloads need to be turned into a numeric
 * vector before they can be committed through the SourceMapper.
 *
 * Schema mirrors `config/integrations.example.json`:
 *
 *   "extract":   { "type": "json", "pointers": ["/completed", ...] }
 *   "normalize": { "mode": "passthrough", "clamp": true }
 *                | { "mode": "minmax", "min": 0, "max": 100, "clamp": true }
 *                | { "mode": "linear", "scale": 0.5, "offset": 0 }
 */

// ── Extract ──────────────────────────────────────────────────────────────

export type ExtractSpec =
  | { type: 'json'; pointers: string[] }
  | { type: 'json'; pointer: string }
  | { type: 'passthrough' };

/**
 * RFC 6901 JSON Pointer evaluation, scoped to plain JSON values.  Returns
 * `undefined` when the pointer doesn't resolve.
 */
export function evalJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  const parts = pointer.slice(1).split('/').map(unescapePointerSegment);
  let cursor: unknown = doc;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function unescapePointerSegment(s: string): string {
  // RFC 6901: ~1 → '/', ~0 → '~' (in that order).
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Coerce a JSON value into a finite number; falsy/non-numeric → 0. */
export function coerceNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Apply an extract spec to a raw JSON payload and return a numeric vector.
 * For `{type:"json",pointers:[...]}` every pointer becomes one cell.  For
 * `{type:"json",pointer:"/x"}` the single pointer is evaluated — if it
 * resolves to an array, all elements are taken; otherwise a one-cell vector.
 * `passthrough` expects the document to already be a numeric array.
 */
export function applyExtract(doc: unknown, spec: ExtractSpec): number[] {
  if (spec.type === 'passthrough') {
    return Array.isArray(doc) ? doc.map(coerceNumber) : [coerceNumber(doc)];
  }
  if ('pointers' in spec) {
    return spec.pointers.map((p) => coerceNumber(evalJsonPointer(doc, p)));
  }
  const value = evalJsonPointer(doc, spec.pointer);
  if (Array.isArray(value)) return value.map(coerceNumber);
  return [coerceNumber(value)];
}

// ── Normalize ────────────────────────────────────────────────────────────

export type NormalizeSpec =
  | { mode: 'passthrough'; clamp?: boolean }
  | { mode: 'minmax'; min: number; max: number; clamp?: boolean }
  | { mode: 'linear'; scale: number; offset?: number; clamp?: boolean };

/**
 * Apply a normalization spec to a numeric vector, returning a new array.
 * Pass `clamp:true` to constrain the output to `[0,1]` (passthrough/minmax)
 * or to a configured band for `linear` (here just `[0,1]` for parity).
 */
export function applyNormalize(values: number[], spec: NormalizeSpec | undefined): number[] {
  if (!spec || spec.mode === 'passthrough') {
    return spec?.clamp ? values.map((v) => clamp01(v)) : values.slice();
  }
  if (spec.mode === 'minmax') {
    const { min, max } = spec;
    const span = max - min;
    if (!Number.isFinite(span) || span === 0) {
      return values.map(() => 0);
    }
    return values.map((v) => {
      const norm = (v - min) / span;
      return spec.clamp ? clamp01(norm) : norm;
    });
  }
  // linear
  const scale = spec.scale;
  const offset = spec.offset ?? 0;
  return values.map((v) => {
    const out = v * scale + offset;
    return spec.clamp ? clamp01(out) : out;
  });
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
