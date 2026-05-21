/**
 * MQTT mapping registry — the authoritative bridge between broker topics
 * and Perception Engine perceptual-space regions.
 *
 * Design rule (per roadmap): MQTT topics describe the outside world; this
 * registry decides how that world projects into perceptual space.  Topic
 * strings never embed offsets; offsets live exclusively in mapping rules.
 *
 * Twin of RealityEngine_CPP/include/reality/mqtt_mapping.hpp and
 * RealityEngine_LSP/src/mqtt-mapping.lisp — identical schema, identical
 * topic-filter semantics, identical normalization math.
 */

import type { Region } from './types.js';

export type ExtractType  = 'raw' | 'csv-float' | 'json' | 'single-float';
export type NormalizeMode = 'passthrough' | 'minmax' | 'linear' | 'band';
export type PushMode     = 'debounced' | 'manual' | 'immediate';

export interface ExtractRule {
  type: ExtractType;
  /** JSON pointer (RFC 6901 lite) — only meaningful when type === 'json' */
  pointer?: string;
  /** CSV value index to extract — when set, only that one float is taken */
  index?: number;
}

export interface NormalizeRule {
  mode: NormalizeMode;
  min:   number;
  max:   number;
  scale: number;
  offset: number;
  clamp: boolean;
}

export interface MappingRule {
  id: string;
  topicFilter: string;
  sensorIdTemplate: string;
  region: Region;
  extract: ExtractRule;
  normalize: NormalizeRule;
  ttlMs: number;
  qos: number;
  acceptRetained: boolean;
  pushMode: PushMode;
  debounceMs: number;
}

/**
 * Per-mapping runtime counters surfaced by /api/mqtt/mappings.  Counters
 * are mutated under the registry's normal single-threaded execution model
 * — Node's event loop guarantees the writes never overlap with reads from
 * the route handler.
 */
export interface MappingMetrics {
  received: number;
  mapped:   number;
  rejected: number;
  stale:    number;
  lastMessageAtMs: number;
  lastError: string;
  lastErrorAtMs: number;
}

export interface MatchResult {
  ruleIndex: number;
  captures: string[];
}

export interface DecodeResult {
  valid: boolean;
  values: number[];
  error: string;
}

const DEFAULT_NORMALIZE: NormalizeRule = {
  mode: 'passthrough', min: 0, max: 1, scale: 1, offset: 0, clamp: true,
};

function parseExtractType(s: string): ExtractType {
  if (s === 'json' || s === 'csv-float' || s === 'raw' || s === 'single-float') return s;
  throw new Error(`unknown extract.type: ${s}`);
}

function parseNormalizeMode(s: string): NormalizeMode {
  if (!s) return 'passthrough';
  if (s === 'passthrough' || s === 'minmax' || s === 'linear' || s === 'band') return s;
  throw new Error(`unknown normalize.mode: ${s}`);
}

function parsePushMode(s: string): PushMode {
  if (!s) return 'debounced';
  if (s === 'debounced' || s === 'manual' || s === 'immediate') return s;
  throw new Error(`unknown pushMode: ${s}`);
}

function splitTopic(s: string): string[] {
  return s.split('/');
}

function parseCsvFloats(text: string): number[] {
  const out: number[] = [];
  // Split on commas / whitespace; empty tokens are dropped so trailing
  // separators don't produce phantom zero values.
  for (const tok of text.split(/[\s,]+/)) {
    if (tok.length === 0) continue;
    const v = Number(tok);
    out.push(v);
  }
  return out;
}

function navigatePointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return root;
  if (pointer[0] !== '/') return undefined;
  let cur: any = root;
  const tokens = pointer.slice(1).split('/');
  for (const token of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return NaN;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export class MappingRegistry {
  public readonly rules: MappingRule[];
  public readonly metrics: MappingMetrics[];

  constructor(rules: MappingRule[]) {
    this.rules = rules;
    this.metrics = rules.map(() => ({
      received: 0, mapped: 0, rejected: 0, stale: 0,
      lastMessageAtMs: 0, lastError: '', lastErrorAtMs: 0,
    }));
  }

  get size(): number { return this.rules.length; }

  /**
   * Parse a JSON document of the form { defaults: {...}, mappings: [...] }
   * into a MappingRegistry.  Throws on schema errors so the caller can fail
   * fast at PE startup rather than silently dropping rules.
   */
  static fromJson(root: any): MappingRegistry {
    const defaults = (root && typeof root.defaults === 'object') ? root.defaults : {};
    const defaultTtl      = typeof defaults.ttlMs           === 'number' ? defaults.ttlMs : 30000;
    const defaultQos      = typeof defaults.qos             === 'number' ? defaults.qos : 0;
    const defaultRetained = typeof defaults.acceptRetained  === 'boolean' ? defaults.acceptRetained : true;
    const defaultPushMode = parsePushMode(typeof defaults.pushMode === 'string' ? defaults.pushMode : '');
    const defaultDebounce = typeof defaults.debounceMs       === 'number' ? defaults.debounceMs : 250;

    if (!root || !Array.isArray(root.mappings)) {
      throw new Error('mqtt-mappings: missing top-level "mappings" array');
    }

    const rules: MappingRule[] = [];
    for (const m of root.mappings) {
      if (!m || typeof m !== 'object') {
        throw new Error('mqtt-mappings: each mapping must be a JSON object');
      }
      const id          = typeof m.id          === 'string' ? m.id          : '';
      const topicFilter = typeof m.topicFilter === 'string' ? m.topicFilter : '';
      if (!id || !topicFilter) {
        throw new Error('mqtt-mappings: id and topicFilter are required');
      }
      const region: Region = {
        offset: m.region && typeof m.region.offset === 'number' ? Math.trunc(m.region.offset) : 0,
        length: m.region && typeof m.region.length === 'number' ? Math.max(1, Math.trunc(m.region.length)) : 1,
      };
      const ex = m.extract && typeof m.extract === 'object' ? m.extract : {};
      const extract: ExtractRule = {
        type: parseExtractType(typeof ex.type === 'string' ? ex.type : 'csv-float'),
        pointer: typeof ex.pointer === 'string' ? ex.pointer : undefined,
        index:   typeof ex.index   === 'number' ? Math.trunc(ex.index) : undefined,
      };
      const nm = m.normalize && typeof m.normalize === 'object' ? m.normalize : {};
      const normalize: NormalizeRule = {
        mode:   parseNormalizeMode(typeof nm.mode === 'string' ? nm.mode : 'passthrough'),
        min:    typeof nm.min    === 'number' ? nm.min    : DEFAULT_NORMALIZE.min,
        max:    typeof nm.max    === 'number' ? nm.max    : DEFAULT_NORMALIZE.max,
        scale:  typeof nm.scale  === 'number' ? nm.scale  : DEFAULT_NORMALIZE.scale,
        offset: typeof nm.offset === 'number' ? nm.offset : DEFAULT_NORMALIZE.offset,
        clamp:  typeof nm.clamp  === 'boolean' ? nm.clamp : DEFAULT_NORMALIZE.clamp,
      };
      rules.push({
        id, topicFilter,
        sensorIdTemplate: typeof m.sensorIdTemplate === 'string' ? m.sensorIdTemplate : '',
        region, extract, normalize,
        ttlMs:          typeof m.ttlMs          === 'number'  ? Math.trunc(m.ttlMs)          : defaultTtl,
        qos:            typeof m.qos            === 'number'  ? Math.trunc(m.qos)            : defaultQos,
        acceptRetained: typeof m.acceptRetained === 'boolean' ? m.acceptRetained             : defaultRetained,
        pushMode:       parsePushMode(typeof m.pushMode === 'string' ? m.pushMode : '' ) || defaultPushMode,
        debounceMs:     typeof m.debounceMs     === 'number'  ? Math.trunc(m.debounceMs)     : defaultDebounce,
      });
    }
    return new MappingRegistry(rules);
  }

  /**
   * Try one filter against `topicLevels` — returns captures when matched,
   * null when not.  Internal helper shared by match() and matchAll().
   */
  private static tryFilter(topicLevels: string[], filterLevels: string[]): string[] | null {
    const captures: string[] = [];
    let fi = 0, ti = 0;
    for (; fi < filterLevels.length; ++fi) {
      const f = filterLevels[fi];
      if (f === '#') {
        captures.push(topicLevels.slice(ti).join('/'));
        ti = topicLevels.length;
        ++fi;
        return fi === filterLevels.length ? captures : null;
      }
      if (ti >= topicLevels.length) return null;
      if (f === '+') captures.push(topicLevels[ti]);
      else if (f !== topicLevels[ti]) return null;
      ++ti;
    }
    return (fi === filterLevels.length && ti === topicLevels.length) ? captures : null;
  }

  /**
   * Find the first rule whose topicFilter matches `topic`.  MQTT v3.1.1
   * §4.7 wildcards: `+` matches exactly one topic level; `#` matches the
   * remaining tail (must be the last segment).  Captures are returned in
   * order so `sensorIdTemplate` can interpolate them as `{1}`, `{2}`, …
   * The bridge dispatches via matchAll() so a single PUBLISH fans out to
   * every rule that shares a filter (e.g. five JSON-pointer extractions
   * from one multi-field sensor payload).
   */
  match(topic: string): MatchResult | null {
    const topicLevels = splitTopic(topic);
    for (let i = 0; i < this.rules.length; ++i) {
      const captures = MappingRegistry.tryFilter(topicLevels, splitTopic(this.rules[i].topicFilter));
      if (captures) return { ruleIndex: i, captures };
    }
    return null;
  }

  /** Every rule matching `topic`, in declaration order.  Empty when none. */
  matchAll(topic: string): MatchResult[] {
    const topicLevels = splitTopic(topic);
    const out: MatchResult[] = [];
    for (let i = 0; i < this.rules.length; ++i) {
      const captures = MappingRegistry.tryFilter(topicLevels, splitTopic(this.rules[i].topicFilter));
      if (captures) out.push({ ruleIndex: i, captures });
    }
    return out;
  }

  /** Substitute `{n}` placeholders (1-indexed) in sensorIdTemplate. */
  resolveSensorId(rule: MappingRule, topic: string, captures: string[]): string {
    if (!rule.sensorIdTemplate) return topic;
    return rule.sensorIdTemplate.replace(/\{(\d+)\}/g, (_, n) => {
      const idx = Number(n);
      return idx >= 1 && idx <= captures.length ? captures[idx - 1] : '';
    });
  }

  /**
   * Run extract → normalize → length-validate on a payload.  Length is
   * required to equal `rule.region.length` exactly; NaN/Inf rejects.
   */
  decode(rule: MappingRule, payload: Uint8Array | Buffer | string): DecodeResult {
    const text = typeof payload === 'string'
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString('utf-8')
        : Buffer.from(payload).toString('utf-8');

    let raw: number[];
    switch (rule.extract.type) {
      case 'raw':
      case 'single-float': {
        const v = Number(text);
        raw = [v];
        break;
      }
      case 'csv-float': {
        const all = parseCsvFloats(text);
        if (rule.extract.index !== undefined) {
          const i = rule.extract.index;
          if (i < 0 || i >= all.length) {
            return { valid: false, values: [], error: `csv index ${i} out of range (have ${all.length})` };
          }
          raw = [all[i]];
        } else {
          raw = all;
        }
        break;
      }
      case 'json': {
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch (e: any) { return { valid: false, values: [], error: `json parse: ${e.message}` }; }
        const node = navigatePointer(parsed, rule.extract.pointer ?? '');
        if (node === undefined) {
          return { valid: false, values: [], error: `json pointer "${rule.extract.pointer ?? ''}" not found` };
        }
        if (typeof node === 'number') raw = [node];
        else if (Array.isArray(node)) {
          raw = node.map(v => typeof v === 'number' ? v : NaN);
        } else if (typeof node === 'string') {
          raw = [Number(node)];
        } else if (typeof node === 'boolean') {
          raw = [node ? 1 : 0];
        } else {
          return { valid: false, values: [], error: 'json pointer target is not a number / array / string / bool' };
        }
        break;
      }
    }

    const normalized: number[] = [];
    for (const v of raw) {
      if (!Number.isFinite(v)) return { valid: false, values: [], error: 'value is not finite' };
      let n = v;
      switch (rule.normalize.mode) {
        case 'passthrough': break;
        case 'minmax': {
          const denom = rule.normalize.max - rule.normalize.min;
          if (denom === 0) return { valid: false, values: [], error: 'normalize.min == normalize.max' };
          n = (v - rule.normalize.min) / denom;
          break;
        }
        case 'linear':
          n = v * rule.normalize.scale + rule.normalize.offset;
          break;
        case 'band':
          // Status-bit semantics — 1.0 when v ∈ [min,max], 0.0 otherwise.
          // Lets a continuous MQTT sensor feed one bit of a machine's
          // 4-bit status input without a conditioner CES in between.
          n = (v >= rule.normalize.min && v <= rule.normalize.max) ? 1 : 0;
          break;
      }
      if (rule.normalize.clamp) n = clampUnit(n);
      if (!Number.isFinite(n)) return { valid: false, values: [], error: 'value not finite after normalize' };
      normalized.push(n);
    }

    if (normalized.length !== rule.region.length) {
      return { valid: false, values: [], error:
        `transformed value count ${normalized.length} != region.length ${rule.region.length}` };
    }
    return { valid: true, values: normalized, error: '' };
  }

  /**
   * Return human-readable warnings for overlapping region declarations
   * across mappings.  Empty when no overlaps (or when allowOverlap=true).
   */
  validateOverlaps(allowOverlap: boolean = false): string[] {
    if (allowOverlap) return [];
    const warnings: string[] = [];
    for (let i = 0; i < this.rules.length; ++i) {
      const a = this.rules[i];
      const aEnd = a.region.offset + a.region.length;
      for (let j = i + 1; j < this.rules.length; ++j) {
        const b = this.rules[j];
        const bEnd = b.region.offset + b.region.length;
        if (a.region.offset < bEnd && b.region.offset < aEnd) {
          warnings.push(`mappings "${a.id}" [${a.region.offset},${aEnd}) and "${b.id}" [${b.region.offset},${bEnd}) overlap`);
        }
      }
    }
    return warnings;
  }

  /** Serialize the registry + per-rule counters for /api/mqtt/mappings. */
  toJson(): object {
    return {
      mappings: this.rules.map((r, i) => ({
        id: r.id,
        topicFilter: r.topicFilter,
        sensorIdTemplate: r.sensorIdTemplate,
        region: { ...r.region },
        extract: {
          type: r.extract.type,
          ...(r.extract.pointer ? { pointer: r.extract.pointer } : {}),
          ...(r.extract.index !== undefined ? { index: r.extract.index } : {}),
        },
        normalize: { ...r.normalize },
        ttlMs: r.ttlMs,
        qos: r.qos,
        acceptRetained: r.acceptRetained,
        pushMode: r.pushMode,
        debounceMs: r.debounceMs,
        counters: { ...this.metrics[i] },
      })),
    };
  }
}
