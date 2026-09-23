/**
 * Trigger dispatcher — public types.
 *
 * Wire-compatible with `RealityEngine_CPP::build_trigger_envelope` and the
 * surrounding dispatch loop in src/perception_engine_server.cpp.  The
 * envelope schema is described in
 * `examples/triggers/ai_trigger_envelope.template.json` — this is the
 * minimal subset that both engines synthesize for every CES terminal
 * event that carries governance + a dispatchable agent.
 */

export type DispatchMode = 'dry-run' | 'graphql' | string;

// ── Inputs (read off the RE step payload + machine catalog) ───────────────

export interface Region {
  offset: number;
  length: number;
}

export interface MergeOpGovernance {
  ragStatusCode?: string;
  /**
   * The action the corpus prescribes for this determination. Travels beside
   * ragStatusCode because both come from the output event's metadata
   * (RealityEngine_CI#365). Read from here rather than from a top-level
   * `op.action`, which no engine emits.
   */
  actionCode?: string;
  processStatus?: string;
  /** Any other governance keys are passed through verbatim. */
  [key: string]: unknown;
}

export interface MergeOp {
  machineId: string;
  /**
   * Pre-fold shape: one entry per firing, so one sequence per entry.
   * Still read for compatibility with any runtime that emits it.
   */
  sequenceId?: string;
  /**
   * Post-fold shape. When the fold moved into the machine's atomic step a
   * merge entry became the union of every sequence contributing to that
   * output, so the engines emit `sequenceIds` and no longer emit `sequenceId`
   * (RealityEngine_CI#327). Reading only the singular field silently yielded
   * "" — which is why dispatch records carried a null sequenceIri.
   */
  sequenceIds?: string[];
  outputIndex?: number;
  region?: Region;
  values?: number[];
  provenance?: string[];
  deprecation?: unknown;
  governance?: MergeOpGovernance | null;
  /** Any other op keys are ignored by the builder. */
  [key: string]: unknown;
}

export interface MachineMetadata {
  dispatchableAgent?: string;
  aiTrigger?: string;
  agentActions?: string[];
  machineCode?: string;
  /** Pass-through for governance defaults / runbook etc. */
  [key: string]: unknown;
}

export interface MachineRecord {
  id: string;
  name?: string;
  metadata?: MachineMetadata;
  /** Pass-through for everything else (perceptualMapping, sequences, …). */
  [key: string]: unknown;
}

// ── Output envelope (the `ces.terminal.event` shape) ─────────────────────

export interface EnvelopeSource {
  engine: 'PE';
  observedEngine: 'RE';
  endpoint: string;
}

export interface EnvelopeCes {
  machineId: string;
  machineName: string;
  machineCode: string;
  sequenceId: string;
  sequenceName: string;
  outputIndex: number;
  stepNumber: number;
  perceptualMapping: { output: Region | null };
  provenance: string[];
  deprecation: unknown;
}

export interface EnvelopeSemanticCell {
  index: number;
  label: string;
}

export interface EnvelopeOutputVector {
  values: number[];
  encoding: 'vector';
  semantics: EnvelopeSemanticCell[];
  assertedLabel: string;
}

export interface EnvelopeDispatch {
  agent: string;
  action: string;
  agentActionsCatalog: string[];
  trigger: string;
  endpoint: {
    kind: DispatchMode;
    url: string;
    mutation: string;
    schemaRef: string;
  };
}

export interface TriggerEnvelope {
  schemaVersion: '1.0.0';
  envelopeType: 'ces.terminal.event';
  envelopeId: string;
  correlationId: string;
  emittedAtMs: number;
  source: EnvelopeSource;
  ces: EnvelopeCes;
  outputVector: EnvelopeOutputVector;
  projection: null;
  governance: MergeOpGovernance | null;
  dispatch: EnvelopeDispatch;
}

// ── Dispatch record ──────────────────────────────────────────────────────
// Type lives in `dispatch/types.ts` since the ledger owns its storage; we
// re-export here so existing importers in this package keep compiling.

export type { DispatchRecord } from '../dispatch/types.js';

// ── Status + summary ─────────────────────────────────────────────────────

/**
 * `/api/triggers/status`, settled 3-of-3 in RealityEngine_CI SURFACE_SPEC.md
 * ("Dispatch surface shapes"). The TS PE conforms; it is not a vote.
 */
export interface TriggerStatus {
  participation: 'active' | 'not-active' | 'unsupported';
  enabled: boolean;
  mode: DispatchMode;
  graphqlEndpoint: string;
  records: number;
  envelopesCreated: number;
  droppedNoGovernance: number;
  droppedNoDispatch: number;
  /** Machine absent from a catalog that has never loaded (RealityEngine_LSP#63). */
  droppedCatalogCold: number;
  dispatchErrors: number;
  machineCatalogCold: boolean;
  /** Epoch ms of the last successful catalog fetch; 0 = never. */
  machineCatalogRefreshedAt: number;
  machineCatalogSize: number;
  /**
   * Subset of `envelopesCreated` produced by
   * `POST /api/triggers/replay/:id`.  TS-side extension — not present in
   * the C++ `trigger_status()` body today, but additive so older
   * adapters continue to parse the response.
   */
  replaysCreated: number;
}

export interface DispatchStepSummary {
  enabled: boolean;
  mode: DispatchMode;
  mergeOps: number;
  envelopesCreated: number;
  dispatchRecordsCreated: number;
  droppedNoGovernance: number;
  droppedNoDispatch: number;
  errors: number;
}
