/**
 * envelopeBuilder — assembles a `ces.terminal.event` envelope from a RE
 * MergeOperation + the corresponding machine record.
 *
 * Byte-equivalent (modulo IDs/timestamps/endpoint) to
 * `RealityEngine_CPP::build_trigger_envelope` in
 * src/perception_engine_server.cpp.  Field order and defaults match
 * exactly so an envelope produced by either engine round-trips through
 * the same downstream consumers.
 */

import type {
  DispatchMode,
  EnvelopeSemanticCell,
  MachineRecord,
  MergeOp,
  TriggerEnvelope,
} from './types.js';

export interface BuilderContext {
  /** Dispatch mode — populated into envelope.dispatch.endpoint.kind. */
  mode: DispatchMode;
  /** GraphQL target — populated when `mode === "graphql"`. */
  graphqlEndpoint: string;
  /** The PE endpoint URL — surfaced under envelope.source.endpoint. */
  realityEngineUrl: string;
  /** Wall-clock; injectable for deterministic tests. */
  now: () => number;
}

/**
 * Build the `assertedLabel` field: `cell_<i>+cell_<j>` for every non-zero
 * cell, or `"none"` when all cells are zero / absent.  Matches the C++
 * `asserted_label()` algorithm verbatim.
 */
export function assertedLabel(values: number[] | undefined): string {
  if (!Array.isArray(values)) return '';
  const labels: string[] = [];
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] === 'number' && values[i] !== 0) labels.push(`cell_${i}`);
  }
  return labels.length === 0 ? 'none' : labels.join('+');
}

function firstAgentAction(metadata: MachineRecord['metadata']): string {
  const actions = metadata?.agentActions;
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return typeof actions[0] === 'string' ? actions[0] : '';
}

function copyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

function semanticsFromValues(values: number[] | undefined): EnvelopeSemanticCell[] {
  if (!Array.isArray(values)) return [];
  const out: EnvelopeSemanticCell[] = [];
  for (let i = 0; i < values.length; i++) {
    out.push({ index: i, label: `cell_${i}` });
  }
  return out;
}

/**
 * Build a single envelope.  The caller supplies pre-generated
 * envelopeId / correlationId so tests can pin deterministic values.
 */
export function buildTriggerEnvelope(
  op: MergeOp,
  machine: MachineRecord,
  envelopeId: string,
  correlationId: string,
  ctx: BuilderContext,
): TriggerEnvelope {
  const md = machine.metadata ?? {};
  const values = Array.isArray(op.values) ? op.values : [];
  const sequenceId = typeof op.sequenceId === 'string' ? op.sequenceId : '';

  return {
    schemaVersion: '1.0.0',
    envelopeType: 'ces.terminal.event',
    envelopeId,
    correlationId,
    emittedAtMs: ctx.now(),
    source: {
      engine: 'PE',
      observedEngine: 'RE',
      endpoint: ctx.realityEngineUrl,
    },
    ces: {
      machineId: op.machineId,
      machineName: typeof machine.name === 'string' ? machine.name : op.machineId,
      machineCode: typeof md.machineCode === 'string' ? md.machineCode : '',
      sequenceId,
      // C++ mirrors sequenceName from sequenceId — the engine doesn't carry
      // a separate display label at this layer.  Producers may overwrite
      // this in the richer template form (see examples/triggers/*.json).
      sequenceName: sequenceId,
      outputIndex: typeof op.outputIndex === 'number' ? op.outputIndex : 0,
      stepNumber: 0,
      perceptualMapping: {
        output: op.region && typeof op.region.offset === 'number' && typeof op.region.length === 'number'
          ? { offset: op.region.offset, length: op.region.length }
          : null,
      },
      provenance: Array.isArray(op.provenance)
        ? op.provenance.filter((x): x is string => typeof x === 'string')
        : [],
      deprecation: op.deprecation ?? null,
    },
    outputVector: {
      values,
      encoding: 'vector',
      semantics: semanticsFromValues(values),
      assertedLabel: assertedLabel(values),
    },
    projection: null,
    governance: op.governance && typeof op.governance === 'object' ? op.governance : null,
    dispatch: {
      agent: typeof md.dispatchableAgent === 'string' ? md.dispatchableAgent : '',
      action: firstAgentAction(md),
      agentActionsCatalog: copyStringArray(md.agentActions),
      trigger: typeof md.aiTrigger === 'string' ? md.aiTrigger : '',
      endpoint: {
        kind: ctx.mode,
        url: ctx.mode === 'graphql' ? ctx.graphqlEndpoint : '',
        mutation: ctx.mode === 'graphql' ? 'updateProcessState' : '',
        schemaRef: ctx.mode === 'graphql' ? 'localAIStack/services/api/routers/graphql_endpoint.py' : '',
      },
    },
  };
}
