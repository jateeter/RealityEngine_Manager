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

export class PerceptionEngine {
  private sources: Map<string, SourceConfig> = new Map();
  private testStep: Map<string, number> = new Map();
  private walkState: Map<string, number[]> = new Map();

  /** Dimension of the perceptual vector. Defaults to 4128 to match the visualizer's PERCEPTUAL_DIM; override via VECTOR_SIZE env var. */
  readonly vectorSize: number;

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

  globalStep = 0;
  matchAlgorithm: MatchAlgorithm = 'gte';

  constructor(vectorSize: number = 4128) {
    this.vectorSize = vectorSize;
    this.persistentVector = new Float64Array(vectorSize);
    this.outBuf = new Float64Array(vectorSize);
  }

  setMatchAlgorithm(algo: MatchAlgorithm): void {
    this.matchAlgorithm = algo;
  }

  // ── Source CRUD ───────────────────────────────────────────────────────────

  addSource(config: Omit<SourceConfig, 'id'>): SourceConfig {
    const id = uuidv4();
    const source = { ...config, id } as SourceConfig;
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
    this.sources.set(id, updated);
    if (updated.active) this.activeSources.add(id);
    else this.activeSources.delete(id);
    return updated;
  }

  getSource(id: string): SourceConfig | undefined {
    return this.sources.get(id);
  }

  getSources(): SourceConfig[] {
    return Array.from(this.sources.values());
  }

  // ── Sensor push ───────────────────────────────────────────────────────────

  updateSensorValue(sensorId: string, values: number[]): boolean {
    for (const [, src] of this.sources) {
      if (src.type === 'sensor' && src.sensorId === sensorId) {
        const updated: SensorSourceConfig = {
          ...src,
          lastValue: values.slice(0, src.region.length),
          lastUpdated: Date.now(),
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

    for (const id of this.activeSources) {
      const src = this.sources.get(id);
      if (!src) continue;

      const values = this.getSourceValues(id, src);
      const { offset, length } = src.region;
      // Single pre-computed bound — eliminates double comparison per loop iteration.
      const len = Math.min(length, values.length);

      for (let i = 0; i < len; i++) {
        this.outBuf[offset + i] = Math.max(0, Math.min(1, values[i]));
      }
    }

    return Array.from(this.outBuf);
  }

  /**
   * Update the persistent base vector with the full perceptual space returned
   * by the Reality Engine after a push.  Must be called after every successful
   * push so that machine outputs written during the merge phase are visible to
   * the next assembleVector() call.
   */
  updateFromPerceptualSpace(ps: number[]): void {
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
      vectorSize: this.vectorSize,
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
