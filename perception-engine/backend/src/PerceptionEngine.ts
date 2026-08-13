import { v4 as uuidv4 } from 'uuid';
import type {
  SourceConfig,
  TestSourceConfig,
  SimulatedSourceConfig,
  SensorSourceConfig,
  SimPattern,
  Region,
  EngineState,
  MatchAlgorithm,
  TestProgress,
} from './types.js';
import { resolveAll, type Contribution, type ArbitrationRecord } from './Arbiter.js';
import { arbitrationRegistry } from './ArbitrationRegistry.js';

/**
 * Map a PE source to its contract provider (contract §3). `origin` carries the
 * integration surface where the source has one — ACP, MCP, MQTT, HealthKit — and
 * the source `type` is the fallback. Anything unrecognised falls through to
 * `generated` in determinismOf(), which is the safe default: an unregistered
 * surface must not be able to outrank a reading.
 */
function providerOf(src: { type?: string; origin?: string }): string {
  const origin = (src.origin ?? '').toLowerCase();
  if (origin.includes('acp') || origin.includes('openclaw')) return 'acp';
  if (origin.includes('mcp')) return 'mcp';
  if (origin.includes('mqtt')) return 'mqtt';
  if (origin.includes('healthkit')) return 'healthkit';
  if (origin.includes('localai') || origin.includes('ollama')) return 'localai';
  if (src.type === 'sensor') return 'sensor';
  if (src.type === 'simulated') return 'synthetic';
  if (src.type === 'test') return 'synthetic';
  return 'sensor';
}

export class PerceptionEngine {
  private sources: Map<string, SourceConfig> = new Map();
  private testStep: Map<string, number> = new Map();
  private walkState: Map<string, number[]> = new Map();

  /**
   * Dimension of the perceptual vector.  Grows on demand (see
   * ensureCapacity) so a source region beyond the initial dimension is
   * accommodated instead of silently skipped — matching the Scala PE.
   */
  private _vectorSize: number;

  get vectorSize(): number {
    return this._vectorSize;
  }

  // Typed array for the persistent perceptual space — avoids per-element boxing
  // overhead of plain number[] and enables fast bulk copy via Float64Array.set().
  private persistentVector: Float64Array;

  // Pre-allocated output buffer — reused by assembleVector() on every push tick
  // so no heap allocation is needed per call.
  private outBuf: Float64Array;

  // Active source IDs — kept in sync with sources.active so that advance() and
  // assembleVector() skip paused/exhausted sources without iterating the full map.
  private activeSources: Set<string> = new Set();

  // Box-Muller spare: each pair (u1, u2) produces two independent normal samples.
  // z1 is stored here and consumed on the next gaussian-noise element, halving
  // the number of Math.random() calls per region.
  private gaussianSpare: number | null = null;

  // Arbitration records for the most recent assembleVector(). Observability is
  // not optional: a resolution nobody can see is indistinguishable from no
  // resolution at all.
  private lastArbitration: ArbitrationRecord[] = [];

  globalStep = 0;
  matchAlgorithm: MatchAlgorithm = 'gte';

  constructor(vectorSize: number = 7680) {
    this._vectorSize = vectorSize;
    this.persistentVector = new Float64Array(vectorSize);
    this.outBuf = new Float64Array(vectorSize);
  }

  /** Expand persistentVector/outBuf and vectorSize to cover [0, requiredEnd). */
  private ensureCapacity(requiredEnd: number): void {
    if (requiredEnd <= this._vectorSize) return;
    const previous = this._vectorSize;
    const grownPersistent = new Float64Array(requiredEnd);
    grownPersistent.set(this.persistentVector);
    this.persistentVector = grownPersistent;
    this.outBuf = new Float64Array(requiredEnd);
    this._vectorSize = requiredEnd;
    console.log(`[PerceptionEngine] vectorSize grew ${previous} → ${requiredEnd}`);
  }

  setMatchAlgorithm(algo: MatchAlgorithm): void {
    this.matchAlgorithm = algo;
  }

  // ── Source CRUD ───────────────────────────────────────────────────────────

  addSource(config: Omit<SourceConfig, 'id'>): SourceConfig {
    const id = uuidv4();
    const source = { ...config, id } as SourceConfig;
    this.ensureCapacity(source.region.offset + source.region.length);
    this.sources.set(id, source);
    if (source.active) this.activeSources.add(id);

    if (source.type === 'test') {
      this.testStep.set(id, 0);
    }
    if (source.type === 'simulated' && source.pattern === 'random-walk') {
      this.walkState.set(id, new Array(source.region.length).fill(source.dcOffset));
    }

    return source;
  }

  /** Restore a previously persisted source preserving its original ID. */
  restoreSource(source: SourceConfig): void {
    this.ensureCapacity(source.region.offset + source.region.length);
    this.sources.set(source.id, source);
    if (source.active) this.activeSources.add(source.id);

    if (source.type === 'test') {
      this.testStep.set(source.id, 0);
    }
    if (source.type === 'simulated' && source.pattern === 'random-walk') {
      this.walkState.set(source.id, new Array(source.region.length).fill(source.dcOffset));
    }
  }

  removeSource(id: string): boolean {
    this.testStep.delete(id);
    this.walkState.delete(id);
    this.activeSources.delete(id);
    return this.sources.delete(id);
  }

  updateSource(id: string, patch: Partial<SourceConfig>): SourceConfig | null {
    const existing = this.sources.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id } as SourceConfig;
    this.ensureCapacity(updated.region.offset + updated.region.length);
    this.sources.set(id, updated);
    if (updated.active) this.activeSources.add(id);
    else this.activeSources.delete(id);
    return updated;
  }

  getSource(id: string): SourceConfig | undefined {
    return this.sources.get(id);
  }

  /**
   * Sources in canonical order: (name, id).
   *
   * A Map iterates in insertion order, which is deterministic within one
   * process but has nothing to do with the order the other runtimes produce —
   * C++ listed by id, Scala and LSP by hash order. Four engines, four
   * orderings, on an endpoint under byte comparison.
   */
  getSources(): SourceConfig[] {
    return Array.from(this.sources.values()).sort((a, b) =>
      a.name === b.name ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.name < b.name ? -1 : 1,
    );
  }

  // ── Sensor push ───────────────────────────────────────────────────────────

  updateSensorValue(sensorId: string, values: number[]): boolean {
    for (const [, src] of this.sources) {
      if (src.type === 'sensor' && src.sensorId === sensorId) {
        const now = Date.now();
        const updated: SensorSourceConfig = {
          ...src,
          lastValue: values.slice(0, src.region.length),
          lastUpdated: now,
          lastWriteAt: now,
          writeCount: (src.writeCount ?? 0) + 1,
        };
        this.sources.set(src.id, updated);
        return true;
      }
    }
    return false;
  }

  // ── Vector assembly ───────────────────────────────────────────────────────

  /**
   * Assemble the next push vector.
   *
   * Starts from the persistent perceptual space — which was last updated with
   * the full post-merge state returned by the Reality Engine — so that machine
   * output regions carry forward unchanged.  Each active source then overwrites
   * only its own assigned region.  Positions touched by no active source remain
   * exactly as the RE left them (e.g. an RS flip-flop Q output stays asserted
   * until a source or another machine actively changes it).
   *
   * This method is pure: it does not modify persistentVector.
   * Call updateFromPerceptualSpace() after each successful push to advance the
   * persistent base to the RE's post-merge state.
   */
  assembleVector(): number[] {
    // Bulk copy via typed array: one native memcpy vs vectorSize individual JS writes.
    this.outBuf.set(this.persistentVector);

    // cell -> contributions for this instant. Populated by the gather pass
    // below; resolved and committed once, after every source has been read.
    const contributions = new Map<number, Contribution[]>();

    for (const id of this.activeSources) {
      const src = this.sources.get(id);
      if (!src) continue;

      const values = this.getSourceValues(id, src);
      const { offset, length } = src.region;
      // Single pre-computed bound — eliminates double comparison per loop iteration.
      const len = Math.min(length, values.length);

      // Out-of-range writes on a Float64Array are silently discarded, so a
      // region past the end would vanish with no signal at all.  Growth should
      // make this unreachable; if it is reached, name the machine that lost its
      // input rather than dropping it quietly.
      if (offset < 0 || offset + len > this._vectorSize) {
        // machineId is only present on machine-derived sources, not on
        // SimulatedSourceConfig — narrow rather than assume.
        const machineId = 'machineId' in src ? src.machineId : '';
        console.warn(
          `[PerceptionEngine] source '${src.name}' region [${offset},${offset + len}) ` +
            `exceeds perceptionDimension ${this._vectorSize} — region not written ` +
            `(machineId=${machineId}, sourceId=${id})`,
        );
      }

      // GATHER — a contribution, not a write. Nothing reaches outBuf until the
      // arbiter has resolved every contended cell (contract §2). The previous
      // direct write meant the last source iterated won, and Set iteration is
      // insertion-ordered, so that resolution was stable and therefore invisible.
      const provider = providerOf(src);
      for (let i = 0; i < len; i++) {
        const cell = offset + i;
        const list = contributions.get(cell);
        const contribution = {
          cell,
          value: Math.max(0, Math.min(1, values[i])),
          provider,
          originId: id,
        };
        if (list) list.push(contribution);
        else contributions.set(cell, [contribution]);
      }
    }

    // RESOLVE then COMMIT — exactly one write per cell.
    const { values: resolved, records } = resolveAll(contributions, this.globalStep, (cell) =>
      arbitrationRegistry.entryFor(cell),
    );
    for (const [cell, value] of resolved) {
      this.outBuf[cell] = value;
    }
    this.lastArbitration = records;

    return Array.from(this.outBuf);
  }

  /** Arbitration records from the most recent assembleVector() — contributors,
   * rule applied, resolved value, and what was suppressed. A suppressed
   * contribution must stay attributable (contract §6). */
  getLastArbitration(): ArbitrationRecord[] {
    return this.lastArbitration;
  }

  /**
   * Update the persistent base vector with the full perceptual space returned
   * by the Reality Engine after a push.  Must be called after every successful
   * push so that machine outputs written during the merge phase are visible to
   * the next assembleVector() call.
   */
  updateFromPerceptualSpace(ps: number[]): void {
    // The RE grows its perceptual space to fit every loaded machine's mapping,
    // so it may return a vector longer than ours — adopt that length instead of
    // truncating to the current one.  Source-driven growth alone does not cover
    // this: the RE also grows for output-only regions, and for machines loaded
    // after the PE's sources were built.
    this.ensureCapacity(ps.length);

    for (let i = 0; i < this.vectorSize; i++) {
      this.persistentVector[i] = ps[i] ?? 0;
    }
  }

  // ── Advance state (call after each push) ──────────────────────────────────

  advance(): void {
    this.globalStep++;

    // Iterate only active sources — skips paused/exhausted sources
    // without touching the full sources map.
    for (const id of this.activeSources) {
      const src = this.sources.get(id);
      if (!src) continue;

      if (src.type === 'test') {
        const current = this.testStep.get(id) ?? 0;
        const next = current + 1;
        if (next >= src.inputs.length) {
          if (src.loop) {
            this.testStep.set(id, 0);
          } else {
            // Deactivate exhausted non-looping source and remove from active set.
            this.sources.set(id, { ...src, active: false });
            this.activeSources.delete(id);
            this.testStep.set(id, 0);
          }
        } else {
          this.testStep.set(id, next);
        }
      }

      if (src.type === 'simulated' && src.pattern === 'random-walk') {
        const prev = this.walkState.get(id) ?? new Array(src.region.length).fill(src.dcOffset);
        const next = prev.map(v => {
          const delta = (Math.random() * 2 - 1) * 0.05;
          return Math.max(0, Math.min(1, v + delta));
        });
        this.walkState.set(id, next);
      }
    }
  }

  // ── Progress ──────────────────────────────────────────────────────────────

  getTestProgress(id: string): TestProgress | null {
    const src = this.sources.get(id);
    if (!src || src.type !== 'test') return null;
    return {
      current: this.testStep.get(id) ?? 0,
      total: src.inputs.length,
    };
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  reset(): void {
    this.globalStep = 0;
    this.persistentVector.fill(0);
    this.gaussianSpare = null;

    for (const [id, src] of this.sources) {
      if (src.type === 'test') {
        this.testStep.set(id, 0);
        // Reactivate deactivated test sources
        if (!src.active) {
          const reactivated = { ...src, active: true };
          this.sources.set(id, reactivated);
          this.activeSources.add(id);
        }
      }
      if (src.type === 'simulated' && src.pattern === 'random-walk') {
        this.walkState.set(id, new Array(src.region.length).fill(src.dcOffset));
      }
    }
  }

  // ── State snapshot ────────────────────────────────────────────────────────

  getState(lastPush: number | null, auto: { running: boolean; intervalMs: number }): EngineState {
    return {
      sources: this.getSources(),
      assembledVector: this.assembleVector(),
      globalStep: this.globalStep,
      auto,
      lastPush,
      matchAlgorithm: this.matchAlgorithm,
      perceptionDimension: this.vectorSize,
    };
  }

  // ── Private value generators ──────────────────────────────────────────────

  private getSourceValues(id: string, src: SourceConfig): number[] {
    switch (src.type) {
      case 'test':
        return this.getTestValues(id, src);
      case 'simulated':
        return this.getSimValues(id, src);
      case 'sensor':
        return this.getSensorValues(src);
    }
  }

  private getTestValues(id: string, src: TestSourceConfig): number[] {
    const step = this.testStep.get(id) ?? 0;
    return src.inputs[step] ?? new Array(src.region.length).fill(0);
  }

  private getSimValues(id: string, src: SimulatedSourceConfig): number[] {
    const { pattern, frequency, amplitude, dcOffset, region } = src;
    const t = this.globalStep;
    const result: number[] = [];

    for (let i = 0; i < region.length; i++) {
      result.push(this.computeSample(id, pattern, t + i * 0.1, frequency, amplitude, dcOffset));
    }

    return result;
  }

  private computeSample(
    id: string,
    pattern: SimPattern,
    t: number,
    frequency: number,
    amplitude: number,
    dcOffset: number
  ): number {
    const period = frequency > 0 ? 1 / frequency : 1;
    const phase = (t / period) % 1;

    switch (pattern) {
      case 'sine':
        return dcOffset + amplitude * Math.sin(2 * Math.PI * phase);

      case 'sawtooth':
        return dcOffset + amplitude * (2 * phase - 1);

      case 'square':
        return dcOffset + amplitude * (phase < 0.5 ? 1 : -1);

      case 'linear-ramp':
        return dcOffset + amplitude * phase;

      case 'constant':
        return dcOffset;

      case 'random-walk': {
        // Value is maintained in walkState; return dcOffset as placeholder
        // (the actual value is read from walkState in getSimValues via advance())
        const state = this.walkState.get(id);
        return state ? state[0] ?? dcOffset : dcOffset;
      }

      case 'gaussian-noise': {
        // Consume the spare from the previous Box-Muller pair if available.
        // Halves random() calls and Math.sqrt/log work for multi-element regions.
        if (this.gaussianSpare !== null) {
          const z = this.gaussianSpare;
          this.gaussianSpare = null;
          return dcOffset + amplitude * z;
        }
        // Box-Muller: produce two independent standard normals z0, z1.
        // Store z1 as the spare for the next element.
        const u1 = Math.max(Math.random(), 1e-10);
        const u2 = Math.random();
        const mag = Math.sqrt(-2 * Math.log(u1));
        const z0 = mag * Math.cos(2 * Math.PI * u2);
        this.gaussianSpare = mag * Math.sin(2 * Math.PI * u2);
        return dcOffset + amplitude * z0;
      }

      case 'binary':
        // Hard 0/1 toggle — 1.0 for the first half of each period, 0.0 for the second half
        return phase < 0.5 ? 1.0 : 0.0;

      default:
        return dcOffset;
    }
  }

  private getSensorValues(src: SensorSourceConfig): number[] {
    if (src.lastUpdated === null) {
      return new Array(src.region.length).fill(0);
    }
    const age = Date.now() - src.lastUpdated;
    if (age > src.ttlMs) {
      return new Array(src.region.length).fill(0);
    }
    const padded = new Array(src.region.length).fill(0);
    for (let i = 0; i < src.lastValue.length && i < src.region.length; i++) {
      padded[i] = src.lastValue[i];
    }
    return padded;
  }
}
