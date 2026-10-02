import { foldUnitInterval } from './osreFold.js';
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

/** A source as an STT contention record names it (ARBITER_CONTRACT.md §4.4b). */
export interface SourceRef {
  id: string;
  name: string;
  kind: string;
  activatedAt: number;
}

/** One contended cell from the most recent push assembly. */
export interface ContendedCell {
  cell: number;
  resolution: 'incumbent' | 'live-over-seed';
  winner: SourceRef;
  suppressed: SourceRef[];
}

/** GET /api/sources/contention. */
export interface SourceContention {
  transition: number;
  cells: ContendedCell[];
  counters: { id: string; name: string; contended: number; suppressed: number }[];
}

/** Canonical (name, id) order, by code unit — the order every runtime lists in. */
function canonicalCompare(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export class PerceptionEngine {
  private sources: Map<string, SourceConfig> = new Map();
  // Activation instants (ARBITER_CONTRACT.md §4.4b): the globalStep at which
  // each source last became active. Kept beside the source, not on it, because
  // SourceConfig is what GET /api/sources serialises and persists.
  private activatedAt: Map<string, number> = new Map();
  // STT contention of the last push assembly, and per-source counters.
  private lastContention: ContendedCell[] = [];
  private contentionTransition = 0;
  private contentionCounters: Map<string, { contended: number; suppressed: number }> = new Map();
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

  // The OSRE cells of the last push: cell -> the writing machine's declared
  // outputMergeTransformation (ARBITER_CONTRACT.md §4.4b).
  private osreFold: Map<number, string> = new Map();

  /** Set from each push's mergeBatch; see osreFold.ts. */
  setOsreFold(cells: Map<number, string>): void {
    this.osreFold = cells;
  }

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

  /**
   * Every write to `sources` goes through here so the activation instant is
   * kept: a source that was active and stays active keeps its claim; any other
   * write stamps the current transition (§4.4b).
   */
  private store(id: string, next: SourceConfig): void {
    const continuing = (this.sources.get(id)?.active ?? false) && next.active;
    if (!continuing) this.activatedAt.set(id, this.globalStep);
    this.sources.set(id, next);
  }

  setMatchAlgorithm(algo: MatchAlgorithm): void {
    this.matchAlgorithm = algo;
  }

  // ── Source CRUD ───────────────────────────────────────────────────────────

  /**
   * Register a source. A caller-supplied `id` is kept, and a source already
   * holding it is replaced; one is minted only when none is given. That is the
   * C++ rule (PerceptionEngine::add_source), which C++, LSP and Scala share.
   * This PE used to mint an id unconditionally, so a caller that registered a
   * source by id and then deleted it by that id got a 404 and leaked the source
   * — every OpenClaw dispatch seed and envelope-contract seed run against the
   * Docker lane left one behind (RealityEngine_Machines#126).
   */
  addSource(config: Omit<SourceConfig, 'id'> & { id?: unknown }): SourceConfig {
    const id = typeof config.id === 'string' && config.id !== '' ? config.id : uuidv4();
    const source = this.deriveSensorActivity({ ...config, id } as SourceConfig);
    this.ensureCapacity(source.region.offset + source.region.length);
    if (!this.sources.has(id)) this.contentionCounters.delete(id);
    this.store(id, source);
    this.activeSources.delete(id);
    this.testStep.delete(id);
    this.walkState.delete(id);
    if (source.active) this.activeSources.add(id);

    if (source.type === 'test') {
      this.testStep.set(id, 0);
    }
    if (source.type === 'simulated' && source.pattern === 'random-walk') {
      this.walkState.set(id, new Array(source.region.length).fill(source.dcOffset));
    }

    return source;
  }

  /**
   * A sensor's stored activity, derived rather than accepted.
   *
   * An integration source's activity is always traceable to an ingress event:
   * registration declares the source — completely, and inactive
   * (RealityEngine_CI#163 point 2a) — and activity is earned by the first value
   * (point 2b). So no registration path may originate activity for a sensor,
   * and the flag a caller asks for is not consulted: it is derived from whether
   * a value is in hand and inside its TTL.
   *
   * This runtime has no separate declare path — addSource IS registration, as
   * add_source is in C++ — so the rule is enforced here, where every
   * construction funnels through. Without it a caller could do what no
   * integration could (RealityEngine_CI#199):
   *
   *     POST /api/sources {"type":"sensor","active":true,...}  ->  active, never fed
   *
   * Derived rather than forced to false: a path that constructs the source
   * while delivering a value still comes out active, because it sets
   * lastValue/lastUpdated first and so satisfies the predicate. That is the
   * MQTT auto-provision and signal-ingest shape.
   *
   * The rule is a conjunction, and the second term is "has a value ever
   * arrived", not "is that value still fresh":
   *
   *     stored_active = requested_active AND (lastUpdated is set)
   *
   * A caller asking for `true` on a sensor that has never reported gets
   * `false` — activity cannot be asserted, which is the whole of #199. A caller
   * asking for `false` gets `false` whatever the value says, so a pause through
   * `updateSource({active: false})` is honoured.
   *
   * Freshness is deliberately NOT part of this. Expiry is a read-time question:
   * `serializeSource` reports `stored AND validated` (#175), and that
   * separation is load-bearing — a sensor that was fed and then lapsed keeps
   * its stored flag and is demoted only on the way out, so a later value
   * revives it without anything having to re-establish the flag. Validating at
   * storage time writes the demotion back and breaks it, which
   * SerializationValidatesActivity asserts against directly.
   *
   * That is a narrower rule than C++'s add_source, which derives from liveness
   * and does write the demotion back. Both refuse to originate activity, which
   * is the invariant #163 point 2b states and the one #199 is about; they
   * differ on whether storage or serialization owns expiry, and here that is
   * already settled.
   */
  private deriveSensorActivity(src: SourceConfig, now: number = Date.now()): SourceConfig {
    if (src.type !== 'sensor') return src;
    void now;
    const everFed = (src as SensorSourceConfig).lastUpdated != null;
    const active = src.active && everFed;
    return active === src.active ? src : ({ ...src, active } as SourceConfig);
  }

  /**
   * Clear a source's stored active flag.
   *
   * Activation is earned; deactivation is not, and the two directions do not
   * need the same rule. Clearing asserts nothing about ingress: the source
   * keeps its value, keeps its TTL, and the next value re-earns activity
   * through updateSensorValue. It says only "do not use this right now" — the
   * one lever an operator has, and derivation applied to both directions would
   * disconnect it (RealityEngine_CPP#43).
   */
  deactivateSource(id: string): boolean {
    const existing = this.sources.get(id);
    if (!existing) return false;
    this.store(id, { ...existing, active: false } as SourceConfig);
    this.activeSources.delete(id);
    return true;
  }

  /** Restore a previously persisted source preserving its original ID. */
  restoreSource(source: SourceConfig): void {
    this.ensureCapacity(source.region.offset + source.region.length);
    // Restored at boot: instant 0, as every runtime that rebuilds its sources
    // on boot stamps them (§4.4b).
    this.sources.set(source.id, source);
    this.activatedAt.set(source.id, 0);
    if (source.active) this.activeSources.add(source.id);

    if (source.type === 'test') {
      this.testStep.set(source.id, 0);
    }
    if (source.type === 'simulated' && source.pattern === 'random-walk') {
      this.walkState.set(source.id, new Array(source.region.length).fill(source.dcOffset));
    }
  }

  /**
   * Remove every interned source (a `test` source carrying a machineId) whose
   * machine is not in `served`; returns what was removed. Sources a caller
   * registered carry no machineId and are never touched.
   */
  removeInternedSourcesOutside(served: ReadonlySet<string>): SourceConfig[] {
    const removed: SourceConfig[] = [];
    for (const src of this.getSources()) {
      if (src.type !== 'test' || !src.machineId || served.has(src.machineId)) continue;
      if (this.removeSource(src.id)) removed.push(src);
    }
    return removed;
  }

  removeSource(id: string): boolean {
    this.testStep.delete(id);
    this.walkState.delete(id);
    this.activeSources.delete(id);
    this.activatedAt.delete(id);
    this.contentionCounters.delete(id);
    return this.sources.delete(id);
  }

  updateSource(id: string, patch: Partial<SourceConfig>): SourceConfig | null {
    const existing = this.sources.get(id);
    if (!existing) return null;
    // A PATCH is a registration path like any other and may not assert a sensor
    // into activity it has not earned. Deactivation is handled separately —
    // see deactivateSource.
    const updated = this.deriveSensorActivity({ ...existing, ...patch, id } as SourceConfig);
    this.ensureCapacity(updated.region.offset + updated.region.length);
    this.store(id, updated);
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
   *
   * This is the STORED view: every source exactly as it is held, `active`
   * included. It is what persistence and the internal callers want. Anything
   * that reports a source to a client wants serializeSources() instead.
   */
  getSources(): SourceConfig[] {
    return Array.from(this.sources.values()).sort((a, b) =>
      a.name === b.name ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.name < b.name ? -1 : 1,
    );
  }

  /**
   * Sources as they are reported to a client: `active` is the validated value.
   *
   *     reported_active = stored_active AND validated_active(kind)
   *
   * Activity expires continuously, not at reset (RealityEngine_CI#175). Nothing
   * runs when a sensor's TTL lapses — no timer, no callback — so a flag that is
   * only re-validated by reset() goes stale the moment the window closes, and
   * /api/sources happily advertises a source that assembly is already zeroing.
   * Validating here closes the gap for every read, whether or not a reset ever
   * happens. LSP does this in source-json and is the reference.
   *
   * Both conjuncts carry weight. The stored flag still gates, so a source an
   * operator paused via PATCH /api/sources/:id reports inactive, a sensor that
   * has never been fed reports inactive, and an exhausted non-looping test
   * source stays reported inactive after advance() retires it. Validation can
   * only ever take activity away — it never grants it.
   *
   * This is a read. It returns copies and does not touch `this.sources` or
   * `this.activeSources`: what a client is told has no business rewriting what
   * the engine holds. Ingress (updateSensorValue) and reset() remain the only
   * things that move the stored flag.
   */
  serializeSources(): SourceConfig[] {
    // One clock reading for the whole pass — two sensors with the same
    // lastUpdated and ttlMs must not serialize differently because the loop
    // crossed a millisecond between them.
    const now = Date.now();
    return this.getSources().map(src => this.serializeSource(src, now));
  }

  /**
   * One source as it is reported to a client. See serializeSources() for the
   * rule; this is the same read applied to a single source, for the write
   * receipts (POST /api/sources, PATCH /api/sources/:id) that echo one back.
   *
   * `now` is a parameter so a caller serializing many sources reads the clock
   * once. Returns the stored object untouched when validation changes nothing,
   * and a copy when it does — never a mutation.
   */
  serializeSource(src: SourceConfig, now: number = Date.now()): SourceConfig {
    const active = src.active && this.validateActive(src, now);
    return active === src.active ? src : ({ ...src, active } as SourceConfig);
  }

  // ── Sensor push ───────────────────────────────────────────────────────────

  updateSensorValue(sensorId: string, values: number[]): boolean {
    for (const [, src] of this.sources) {
      if (src.type === 'sensor' && src.sensorId === sensorId) {
        const now = Date.now();
        const updated: SensorSourceConfig = {
          ...src,
          // A value earns activity. Registration is the usual place a sensor
          // first becomes active, but it is not the only one: a sensor whose
          // TTL expired is validated inactive by reset(), and without this it
          // would be stranded there — holding a fresh reading, excluded from
          // activeSources, contributing zeros forever.
          active: true,
          lastValue: values.slice(0, src.region.length),
          lastUpdated: now,
          lastWriteAt: now,
          writeCount: (src.writeCount ?? 0) + 1,
        };
        this.store(src.id, updated);  // earning activity is an activation (§4.4b)
        this.activeSources.add(src.id);
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

    const { contributions, seedOrigins } = this.gatherSourceContributions(true);
    this.resolveSourceContention(contributions, seedOrigins);

    // RESOLVE then COMMIT — exactly one write per cell.
    const { values: resolved, records } = resolveAll(contributions, this.globalStep, (cell) =>
      arbitrationRegistry.entryFor(cell),
    );
    for (const [cell, value] of resolved) {
      this.outBuf[cell] = value;
    }
    // A source on an OSRE cell is folded with the OSRE value by the writing
    // machine's operator rather than replacing it (§4.4b). `contributions`
    // holds exactly the cells a source wrote this instant.
    for (const [cell, transformation] of this.osreFold) {
      if (cell < 0 || cell >= this._vectorSize || !contributions.has(cell)) continue;
      this.outBuf[cell] = Math.max(0, Math.min(1,
        foldUnitInterval(transformation, this.outBuf[cell], this.persistentVector[cell])));
    }
    this.lastArbitration = records;

    return Array.from(this.outBuf);
  }

  /**
   * GATHER — cell -> contributions for this instant, from every active source.
   * Nothing reaches outBuf until each contended cell is resolved (contract §2).
   */
  private gatherSourceContributions(warn: boolean): {
    contributions: Map<number, Contribution[]>;
    seedOrigins: Set<string>;
  } {
    const contributions = new Map<number, Contribution[]>();
    const seedOrigins = new Set<string>();

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
      if (warn && (offset < 0 || offset + len > this._vectorSize)) {
        // machineId is only present on machine-derived sources, not on
        // SimulatedSourceConfig — narrow rather than assume.
        const machineId = 'machineId' in src ? src.machineId : '';
        console.warn(
          `[PerceptionEngine] source '${src.name}' region [${offset},${offset + len}) ` +
            `exceeds perceptionDimension ${this._vectorSize} — region not written ` +
            `(machineId=${machineId}, sourceId=${id})`,
        );
      }

      // A contribution, not a write. The previous direct write meant the last
      // source iterated won, and Set iteration is insertion-ordered, so that
      // resolution was stable and therefore invisible.
      const provider = providerOf(src);
      if (src.type === 'test') seedOrigins.add(id);
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
    return { contributions, seedOrigins };
  }

  /**
   * Resolve every cell several sources write, leaving one contribution per cell
   * for the arbiter, and return what was decided.
   *
   * SEED BENEATH LIVE. Interned test sources are ISRESeed(n), the base every
   * live input folds over (the direction of the OSRE->ISRE fold), so on a cell
   * where any live source contributes, the seed does not contend at all: the
   * live input wins, always (owner decision, 2026-10-02, RealityEngine_CPP#146).
   *
   * THE INCUMBENT KEEPS THE CELL. Within the tier left standing, two sources on
   * one cell in one transition violates the single transition time constraint
   * (ARBITER_CONTRACT.md §4.4b, owner decision 2026-10-02): the source activated
   * earliest wins; equal instants — every seed interned at boot — fall back to
   * canonical (name, id), first winning. No value combinator applies between
   * sources: the registry's per-cell rules govern machine-vs-source, not
   * source-vs-source. The C++, LSP and Scala PEs reach the same result by
   * composing each tier newest first so the incumbent writes last.
   */
  private resolveSourceContention(
    contributions: Map<number, Contribution[]>,
    seedOrigins: Set<string>,
  ): ContendedCell[] {
    const cells: ContendedCell[] = [];
    const ref = (id: string): SourceRef => {
      const src = this.sources.get(id);
      return {
        id,
        name: src?.name ?? '',
        kind: src?.type ?? '',
        activatedAt: this.activatedAt.get(id) ?? 0,
      };
    };
    const incumbentFirst = (a: SourceRef, b: SourceRef): number =>
      a.activatedAt !== b.activatedAt
        ? a.activatedAt - b.activatedAt
        : canonicalCompare(a, b);
    const sortedCells = [...contributions.keys()].sort((a, b) => a - b);
    for (const cell of sortedCells) {
      const list = contributions.get(cell)!;
      if (list.length < 2) continue;
      const live = list.filter((c) => !seedOrigins.has(c.originId));
      const tier = live.length > 0 ? live : list;
      const winner = tier.map((c) => ref(c.originId)).sort(incumbentFirst)[0]!;
      contributions.set(cell, list.filter((c) => c.originId === winner.id));
      if (cell < 0 || cell >= this._vectorSize) continue;
      cells.push({
        cell,
        resolution: tier.length > 1 ? 'incumbent' : 'live-over-seed',
        winner,
        suppressed: list
          .filter((c) => c.originId !== winner.id)
          .map((c) => ref(c.originId))
          .sort(canonicalCompare),
      });
    }
    return cells;
  }

  /** Cells written by more than one active source, resolved as assembleVector
   * resolves them. A pure read: it neither records nor counts. */
  sourceContention(): ContendedCell[] {
    const { contributions, seedOrigins } = this.gatherSourceContributions(false);
    return this.resolveSourceContention(contributions, seedOrigins);
  }

  /** Record the contention of the assembly a push sends, and count it. Push path only. */
  recordContention(): void {
    this.lastContention = this.sourceContention();
    this.contentionTransition = this.globalStep;
    const contended = new Set<string>();
    const lost = new Set<string>();
    for (const c of this.lastContention) {
      contended.add(c.winner.id);
      for (const l of c.suppressed) {
        contended.add(l.id);
        lost.add(l.id);
      }
    }
    for (const id of contended) {
      const counter = this.contentionCounters.get(id) ?? { contended: 0, suppressed: 0 };
      counter.contended++;
      if (lost.has(id)) counter.suppressed++;
      this.contentionCounters.set(id, counter);
    }
  }

  /** GET /api/sources/contention. */
  getContention(): SourceContention {
    const counters: SourceContention['counters'] = [];
    for (const src of this.getSources()) {
      const c = this.contentionCounters.get(src.id);
      if (c) counters.push({ id: src.id, name: src.name, contended: c.contended, suppressed: c.suppressed });
    }
    return { transition: this.contentionTransition, cells: this.lastContention, counters };
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
            this.store(id, { ...src, active: false });
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

  /**
   * Rewind the run and re-validate what is active.
   *
   * Reset is membership-neutral (contract RealityEngine_CI#163 §3): it rewinds
   * cursors, globalStep and the persistent vector, and never manufactures or
   * retires a source. What it does to `active` is VALIDATE it — every flag is
   * recomputed from the rules for its kind against the state the rewind just
   * produced, rather than assigned.
   *
   * This used to force `active: true` on every test source and leave every
   * other kind's flag exactly as it found it, so a sensor whose TTL had expired
   * before the reset was still reported active afterwards. The assembled vector
   * was right either way — an expired sensor contributes zeros at assembly —
   * but `active` is part of the byte-compared source payload, and it was
   * advertising a source that supplies nothing.
   */
  reset(): void {
    this.globalStep = 0;
    // No push since the reset, so no OSRE term to fold with.
    this.osreFold = new Map();
    this.persistentVector.fill(0);
    this.gaussianSpare = null;

    // One clock reading for the whole pass: two sensors with the same
    // lastUpdated and ttlMs must not validate differently because the loop
    // crossed a millisecond between them.
    const now = Date.now();

    for (const [id, src] of this.sources) {
      // Clear run state first — activity is validated against the rewound
      // engine, not against the run that has just been discarded.
      if (src.type === 'test') {
        this.testStep.set(id, 0);
      }
      if (src.type === 'simulated' && src.pattern === 'random-walk') {
        this.walkState.set(id, new Array(src.region.length).fill(src.dcOffset));
      }

      const active = this.validateActive(src, now);
      if (active !== src.active) {
        this.sources.set(id, { ...src, active } as SourceConfig);
      }
      // activeSources is the set assembleVector() and advance() iterate, so it
      // has to move with the flag or the two disagree about the same source.
      if (active) this.activeSources.add(id);
      else this.activeSources.delete(id);
      // A reset is a boot for the run: instant 0 for every source (§4.4b).
      this.activatedAt.set(id, 0);
    }
    this.lastContention = [];
    this.contentionTransition = 0;
    this.contentionCounters.clear();
  }

  /**
   * Can this source supply a value right now? Each kind answers from its own
   * rules, never by reading the stored flag back.
   *
   * One predicate, two callers, so they cannot drift: reset() validates the
   * stored flag with it after a rewind, and serializeSources() validates the
   * reported flag with it on every read. `now` is a parameter so a caller
   * validating many sources reads the clock once.
   */
  private validateActive(src: SourceConfig, now: number): boolean {
    switch (src.type) {
      case 'sensor':
        // Activity is earned by a value and lost when that value goes stale.
        // Nothing refreshes a reading on its own — not a rewind, not the
        // passage of time — so the TTL is the whole answer here.
        return this.sensorHoldsFreshValue(src, now);
      case 'test':
        // Supplies its own values from the sequence interned at registration.
        // A test source with no steps supplies nothing, so calling it active
        // would be an assignment rather than a validation. Whether it has
        // *reached* the end is the stored flag's business: advance() retires an
        // exhausted non-looping source, and reset() rewinds it to step 0.
        return src.inputs.length > 0;
      case 'simulated':
        // Generates from globalStep; nothing can starve it.
        return true;
    }
  }

  // ── State snapshot ────────────────────────────────────────────────────────

  /**
   * The snapshot behind GET /api/state and every `state-update` WebSocket
   * broadcast. Sources come from serializeSources(), so the HTTP and WS views
   * of the same source cannot disagree about whether it is active.
   */
  getState(lastPush: number | null, auto: { running: boolean; intervalMs: number }): EngineState {
    return {
      sources: this.serializeSources(),
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

  /**
   * Whether a sensor is holding a value inside its TTL.
   *
   * The single definition of sensor liveness. Assembly reads it to decide
   * whether the region contributes anything, and validateActive() reads it for
   * both the stored flag (reset) and the reported one (serialization) — one
   * predicate, so what a sensor is said to be cannot disagree with what it
   * actually contributes.
   */
  private sensorHoldsFreshValue(src: SensorSourceConfig, now: number = Date.now()): boolean {
    if (src.lastUpdated === null) return false;
    return now - src.lastUpdated <= src.ttlMs;
  }

  private getSensorValues(src: SensorSourceConfig): number[] {
    const padded = new Array(src.region.length).fill(0);
    if (!this.sensorHoldsFreshValue(src)) return padded;
    for (let i = 0; i < src.lastValue.length && i < src.region.length; i++) {
      padded[i] = src.lastValue[i];
    }
    return padded;
  }
}
