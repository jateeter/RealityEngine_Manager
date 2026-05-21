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
  processStatus?: string;
  /** Any other governance keys are passed through verbatim. */
  [key: string]: unknown;
}

export interface MergeOp {
  machineId: string;
  sequenceId?: string;
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

export interface TriggerStatus {
  enabled: boolean;
  mode: DispatchMode;
  graphqlEndpoint: string;
  records: number;
  envelopesCreated: number;
  droppedNoGovernance: number;
  droppedNoDispatch: number;
  dispatchErrors: number;
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
