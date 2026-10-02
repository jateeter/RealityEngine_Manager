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

function copyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

/** A machine's resolved dispatch binding. */
export interface DispatchBinding {
  agent: string;
  trigger: string;
  /** agentBinding.mode; '' for a machine bound only through the legacy fields. */
  autonomyMode: string;
  actions: string[];
  /** The action at the first non-zero output cell, else the first action. */
  action: string;
  writeBack: Record<string, unknown> | null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Resolve the dispatch binding: first-class `metadata.agentBinding`, falling
 * back field by field to the legacy `dispatchableAgent` / `aiTrigger` /
 * `agentActions`. The same rule as C++ (`dispatch_binding`), LSP
 * (`ces-dispatch-binding`) and Scala (`TriggerDispatcher.binding`).
 *
 * This PE used to read only the legacy fields, so a machine bound through
 * agentBinding alone — `OpenClaw Completion E2E` among them — reached a
 * terminal CES and was dropped as droppedNoDispatch. That made the Docker
 * lane, whose PE this is, the only one where the OpenClaw dispatch seed
 * produced no envelope (RealityEngine_Machines#126).
 */
export function dispatchBinding(
  md: MachineRecord['metadata'] | undefined,
  values: number[] | undefined,
): DispatchBinding {
  const meta = (md ?? {}) as Record<string, unknown>;
  const ab = meta['agentBinding'];
  const binding = ab && typeof ab === 'object' && !Array.isArray(ab) ? ab as Record<string, unknown> : null;
  const legacyAgent = nonEmptyString(meta['dispatchableAgent']) ?? '';
  const legacyTrigger = nonEmptyString(meta['aiTrigger']) ?? '';
  const legacyActions = copyStringArray(meta['agentActions']);
  let actions = legacyActions;
  if (binding) {
    const allowed = copyStringArray(binding['allowedActions']);
    if (allowed.length > 0) actions = allowed;
  }
  const wb = binding?.['writeBack'];
  return {
    agent: binding ? nonEmptyString(binding['agent']) ?? legacyAgent : legacyAgent,
    trigger: binding ? nonEmptyString(binding['trigger']) ?? legacyTrigger : legacyTrigger,
    autonomyMode: binding && typeof binding['mode'] === 'string' ? binding['mode'] : '',
    actions,
    action: selectAgentAction(actions, values),
    writeBack: wb && typeof wb === 'object' && !Array.isArray(wb) ? wb as Record<string, unknown> : null,
  };
}

function selectAgentAction(actions: string[], values: number[] | undefined): string {
  if (actions.length === 0) return '';
  if (Array.isArray(values)) {
    for (let i = 0; i < values.length && i < actions.length; i++) {
      if (typeof values[i] === 'number' && values[i] !== 0) return actions[i]!;
    }
  }
  return actions[0]!;
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
  const binding = dispatchBinding(md, values);
  // Resolve the contributing sequence from either merge shape.
  //
  // A folded entry names every sequence that contributed to the output. When
  // exactly one did, the entry projects onto that sequence and naming it is
  // exact — the byte-identity property FOLD_PLACEMENT.md 8 asserts. When
  // several did, no single sequenceId is true of the entry, and inventing one
  // would misattribute the dispatch to whichever happened to sort first. It
  // stays empty there, which the audit contract already allows for.
  const foldedIds = Array.isArray(op.sequenceIds)
    ? op.sequenceIds.filter((x): x is string => typeof x === 'string' && x !== '')
    : [];
  // governance.sequenceId is the engine's own attribution for the entry and is
  // singular, so it is preferred over reconstructing one from the folded set.
  const govSequenceId = typeof op.governance?.sequenceId === 'string'
    ? op.governance.sequenceId
    : '';
  const sequenceId = typeof op.sequenceId === 'string' && op.sequenceId !== ''
    ? op.sequenceId
    : govSequenceId !== ''
      ? govSequenceId
      : foldedIds.length === 1
        ? foldedIds[0]!
        : '';

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
      agent: binding.agent,
      action: binding.action,
      agentActionsCatalog: binding.actions,
      trigger: binding.trigger,
      autonomyMode: binding.autonomyMode,
      writeBack: binding.writeBack,
      endpoint: {
        kind: ctx.mode,
        url: ctx.mode === 'graphql' ? ctx.graphqlEndpoint : '',
        mutation: ctx.mode === 'graphql' ? 'updateProcessState' : '',
        schemaRef: ctx.mode === 'graphql' ? 'localAIStack/services/api/routers/graphql_endpoint.py' : '',
      },
    },
  };
}
