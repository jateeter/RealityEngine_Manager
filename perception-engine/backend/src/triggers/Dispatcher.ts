/**
 * Dispatcher — fire-and-record trigger envelope subscriber.
 *
 * Listens to every RE step (passed in via `dispatchStep`), scans
 * `step.mergeBatch` for governance-resolved CES terminal events, and
 * synthesises a `ces.terminal.event` envelope per qualifying op.  Each
 * envelope is wrapped in a `DispatchRecord`, stored in an in-memory ring
 * (capacity 256, FIFO eviction — matches C++), and announced over the
 * WebSocket as `trigger.envelope.created`.
 *
 * Phase-2 contract:
 *   - never blocks the PE cycle
 *   - never calls a provider (mode defaults to `dry-run`)
 *   - counters are wire-compatible with `RealityEngine_CPP::trigger_status()`
 *
 * Provider dispatch ({@link DispatchMode} = `graphql`, `https`, …) lands
 * later in Phase 4 — the envelope already carries the target metadata so
 * the adapter just needs to read the record from the ledger.
 */

import { randomUUID } from 'crypto';

import { Ledger } from '../dispatch/Ledger.js';
import { buildTriggerEnvelope, type BuilderContext } from './envelopeBuilder.js';
import type {
  DispatchMode,
  DispatchRecord,
  DispatchStepSummary,
  MachineRecord,
  MergeOp,
  TriggerEnvelope,
  TriggerStatus,
} from './types.js';

export interface DispatcherDeps {
  /**
   * Resolve a machineId to its catalog entry.  Returning `undefined`
   * counts as "drop — no dispatchable info" rather than an error so the
   * PE cycle stays clean when the catalog is still warming up.
   */
  getMachine: (machineId: string) => MachineRecord | undefined;
  /** WebSocket broadcaster.  Receives the parsed event object. */
  broadcast: (event: Record<string, unknown>) => void;
  /** Now-ms supplier.  Injectable for deterministic tests. */
  now?: () => number;
  /** UUID generator.  Injectable for deterministic tests. */
  newId?: (kind: string) => string;
  /**
   * Externally-owned ledger.  When omitted the dispatcher creates its
   * own in-memory ring — handy in tests but production wiring should
   * share one Ledger across the dispatcher and the `/api/dispatch/*`
   * routes so they read the same records.
   */
  ledger?: Ledger;
  /**
   * Optional adapter pipeline.  When present, the dispatcher fires
   * `pipeline.onRecord(envelope, record)` after each ledger.append so
   * provider adapters (Ollama, OpenAI, …) can run asynchronously.
   * Fire-and-forget at this layer — never blocks the PE cycle.
   */
  pipeline?: { onRecord: (envelope: TriggerEnvelope, record: DispatchRecord) => void };
}

export interface DispatcherConfig {
  enabled: boolean;
  mode: DispatchMode;
  graphqlEndpoint: string;
  realityEngineUrl: string;
}

export class Dispatcher {
  private readonly ledger: Ledger;

  // Cumulative counters across the lifetime of the dispatcher — wire-
  // compatible with C++ `trigger_status()`.
  private envelopesCreated = 0;
  private droppedNoGovernance = 0;
  private droppedNoDispatch = 0;
  private dispatchErrors = 0;
  // TS-side extension: subset of envelopesCreated that came from replay.
  private replaysCreated = 0;

  constructor(
    private readonly cfg: DispatcherConfig,
    private readonly deps: DispatcherDeps,
  ) {
    this.ledger = deps.ledger ?? new Ledger({ now: deps.now });
  }

  // ── Public surface ──────────────────────────────────────────────────────

  /**
   * Run the dispatcher against one RE step result.  Tolerates a missing
   * or malformed `mergeBatch` so a step with no terminal events is a
   * no-op.  Always returns a structured summary.
   */
  dispatchStep(step: unknown): DispatchStepSummary {
    const summary: DispatchStepSummary = {
      enabled: this.cfg.enabled,
      mode: this.cfg.mode,
      mergeOps: 0,
      envelopesCreated: 0,
      dispatchRecordsCreated: 0,
      droppedNoGovernance: 0,
      droppedNoDispatch: 0,
      errors: 0,
    };
    if (!this.cfg.enabled) return summary;
    if (!step || typeof step !== 'object') return summary;

    const mergeBatch = (step as { mergeBatch?: unknown }).mergeBatch;
    if (!Array.isArray(mergeBatch)) return summary;

    for (const raw of mergeBatch) {
      summary.mergeOps++;
      try {
        const op = raw as MergeOp;
        if (!op || typeof op !== 'object' || !op.governance || typeof op.governance !== 'object') {
          summary.droppedNoGovernance++;
          this.droppedNoGovernance++;
          continue;
        }
        if (typeof op.machineId !== 'string' || op.machineId === '') {
          summary.droppedNoDispatch++;
          this.droppedNoDispatch++;
          continue;
        }
        const machine = this.deps.getMachine(op.machineId);
        const md = machine?.metadata ?? {};
        const agent = typeof md.dispatchableAgent === 'string' ? md.dispatchableAgent : '';
        const trigger = typeof md.aiTrigger === 'string' ? md.aiTrigger : '';
        if (!machine || agent === '' || trigger === '') {
          summary.droppedNoDispatch++;
          this.droppedNoDispatch++;
          continue;
        }

        const envelopeId = this.mintId('trigger-envelope');
        const correlationId = this.mintId('trigger-correlation');
        const envelope = buildTriggerEnvelope(op, machine, envelopeId, correlationId, this.builderCtx());
        const record = this.recordFromEnvelope(envelope, op, agent);

        this.ledger.append(record);
        this.envelopesCreated++;
        summary.envelopesCreated++;
        summary.dispatchRecordsCreated++;

        this.deps.broadcast({
          type: 'trigger.envelope.created',
          envelopeId,
          correlationId,
          dispatchId: record.id,
          target: agent,
          mode: this.cfg.mode,
        });

        // Phase 4 — hand the envelope to the adapter pipeline if one is
        // registered.  Synchronous call but the pipeline never awaits a
        // provider, so this stays off the critical path.
        if (this.deps.pipeline) {
          try {
            this.deps.pipeline.onRecord(envelope, record);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[dispatcher] pipeline.onRecord threw for envelope=${envelopeId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        summary.errors++;
        this.dispatchErrors++;
        // Mirrors C++ stderr line so an operator reading mixed logs sees one message.
        // eslint-disable-next-line no-console
        console.error(`trigger dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return summary;
  }

  /** Returns the C++-compatible `/api/triggers/status` body. */
  status(): TriggerStatus {
    return {
      enabled: this.cfg.enabled,
      mode: this.cfg.mode,
      graphqlEndpoint: this.cfg.graphqlEndpoint,
      records: this.ledger.size(),
      envelopesCreated: this.envelopesCreated,
      droppedNoGovernance: this.droppedNoGovernance,
      droppedNoDispatch: this.droppedNoDispatch,
      dispatchErrors: this.dispatchErrors,
      replaysCreated: this.replaysCreated,
    };
  }

  /**
   * Replay an existing ledger record — emits a NEW DispatchRecord
   * referencing the original via {@link DispatchRecord.replayOf}.
   *
   *   - `freshIds:false` (default) keeps the original `envelopeId` and
   *     `correlationId`, so downstream subscribers see the same causal
   *     chain.  Use this when re-dispatching an envelope that a provider
   *     dropped on the floor.
   *   - `freshIds:true` mints new envelope / correlation IDs.  Use this
   *     when intentionally forking a new chain off the original event.
   *
   * Never mutates PE/RE state; never calls a provider.  Returns
   * `undefined` when no record with `dispatchId` exists.
   */
  replay(
    dispatchId: string,
    opts: { freshIds?: boolean } = {},
  ): DispatchRecord | undefined {
    const original = this.ledger.get(dispatchId);
    if (!original) return undefined;

    const now = (this.deps.now ?? Date.now)();
    const envelopeId = opts.freshIds ? this.mintId('trigger-envelope') : original.envelopeId;
    const correlationId = opts.freshIds ? this.mintId('trigger-correlation') : original.correlationId;

    // Shallow-clone the envelope so a freshIds replay rewrites only the
    // top-level identifiers without mutating the original entry.
    const envelope: TriggerEnvelope = opts.freshIds
      ? { ...original.envelope, envelopeId, correlationId, emittedAtMs: now }
      : original.envelope;

    const record: DispatchRecord = {
      id: this.mintId('dispatch'),
      envelopeId,
      correlationId,
      status: 'recorded',
      mode: 'replay',
      target: original.target,
      machineId: original.machineId,
      sequenceId: original.sequenceId,
      ragStatusCode: original.ragStatusCode,
      processStatus: original.processStatus,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      providerReceipt: null,
      envelope,
      replayOf: original.id,
    };

    this.ledger.append(record);
    this.envelopesCreated++;
    this.replaysCreated++;

    this.deps.broadcast({
      type: 'trigger.envelope.created',
      envelopeId,
      correlationId,
      dispatchId: record.id,
      target: record.target,
      mode: record.mode,
      replayOf: original.id,
    });

    return record;
  }

  /** Snapshot of the ledger in insertion order, oldest first. */
  listRecords(): DispatchRecord[] {
    return this.ledger.list();
  }

  getRecord(id: string): DispatchRecord | undefined {
    return this.ledger.get(id);
  }

  /** Returns the underlying ledger so server routes can share storage. */
  getLedger(): Ledger {
    return this.ledger;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private builderCtx(): BuilderContext {
    return {
      mode: this.cfg.mode,
      graphqlEndpoint: this.cfg.graphqlEndpoint,
      realityEngineUrl: this.cfg.realityEngineUrl,
      now: this.deps.now ?? Date.now,
    };
  }

  private mintId(kind: string): string {
    return this.deps.newId ? this.deps.newId(kind) : `${kind}-${randomUUID()}`;
  }

  private recordFromEnvelope(envelope: TriggerEnvelope, op: MergeOp, agent: string): DispatchRecord {
    const now = (this.deps.now ?? Date.now)();
    const governance = op.governance ?? {};
    return {
      id: this.mintId('dispatch'),
      envelopeId: envelope.envelopeId,
      correlationId: envelope.correlationId,
      status: 'recorded',
      mode: this.cfg.mode,
      target: agent,
      machineId: op.machineId,
      sequenceId: typeof op.sequenceId === 'string' ? op.sequenceId : '',
      ragStatusCode: typeof governance.ragStatusCode === 'string' ? governance.ragStatusCode : '',
      processStatus: typeof governance.processStatus === 'string' ? governance.processStatus : '',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      providerReceipt: null,
      envelope,
    };
  }
}
