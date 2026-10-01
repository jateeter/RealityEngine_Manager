/**
 * envelopeBuilder — contract tests.
 *
 * Mirrors the wire shape produced by RealityEngine_CPP::build_trigger_envelope
 * (src/perception_engine_server.cpp).  Each assertion maps to a field both
 * engines must agree on for adapter interop.
 */

import { describe, it, expect } from 'vitest';

import {
  assertedLabel,
  buildTriggerEnvelope,
  dispatchBinding,
  type BuilderContext,
} from '../triggers/envelopeBuilder.js';
import type { MachineRecord, MergeOp } from '../triggers/types.js';

const FIXED_NOW = 1_700_000_000_000;

function ctx(overrides: Partial<BuilderContext> = {}): BuilderContext {
  return {
    mode: 'dry-run',
    graphqlEndpoint: 'http://localhost:4000/graphql',
    realityEngineUrl: 'http://reality:3001',
    now: () => FIXED_NOW,
    ...overrides,
  };
}

const opAGX051: MergeOp = {
  machineId: 'machine-agx051-yuma-aqua-maintenance-forecaster',
  sequenceId: 'agx-051-urgent-maint',
  outputIndex: 0,
  region: { offset: 256, length: 4 },
  values: [1, 0, 0, 0],
  provenance: ['lateral-watersuite-dev0000001-sensorreadings-v1-tick-918'],
  deprecation: null,
  governance: {
    ragStatusCode: 'RED',
    processStatus: 'error',
    ownerTeam: 'agriculture-operations',
  },
};

const machineAGX051: MachineRecord = {
  id: 'machine-agx051-yuma-aqua-maintenance-forecaster',
  name: 'Agriculture Yuma Aqua Maintenance Forecaster',
  metadata: {
    dispatchableAgent: 'aquaculture_predictive_maintenance_agent',
    aiTrigger: 'agriculture-yuma-aqua-maintenance-forecaster-maintenance',
    machineCode: 'AGX051',
    agentActions: [
      'Dispatch aquaculture_predictive_maintenance_agent for urgent maintenance and record corrective action.',
      'Schedule preventive maintenance via aquaculture_predictive_maintenance_agent and verify completion telemetry.',
    ],
  },
};

describe('assertedLabel', () => {
  it('joins non-zero cell indices with +', () => {
    expect(assertedLabel([1, 0, 0, 0])).toBe('cell_0');
    expect(assertedLabel([0, 1, 0, 1])).toBe('cell_1+cell_3');
  });
  it('returns "none" when every cell is zero', () => {
    expect(assertedLabel([0, 0, 0])).toBe('none');
  });
  it('returns "" for non-array input (matches C++ fallthrough)', () => {
    expect(assertedLabel(undefined)).toBe('');
  });
});

describe('buildTriggerEnvelope — wire shape', () => {
  it('produces the minimal C++-equivalent envelope', () => {
    const env = buildTriggerEnvelope(opAGX051, machineAGX051, 'env-1', 'corr-1', ctx());
    expect(env).toEqual({
      schemaVersion: '1.0.0',
      envelopeType: 'ces.terminal.event',
      envelopeId: 'env-1',
      correlationId: 'corr-1',
      emittedAtMs: FIXED_NOW,
      source: {
        engine: 'PE',
        observedEngine: 'RE',
        endpoint: 'http://reality:3001',
      },
      ces: {
        machineId: 'machine-agx051-yuma-aqua-maintenance-forecaster',
        machineName: 'Agriculture Yuma Aqua Maintenance Forecaster',
        machineCode: 'AGX051',
        sequenceId: 'agx-051-urgent-maint',
        sequenceName: 'agx-051-urgent-maint',
        outputIndex: 0,
        stepNumber: 0,
        perceptualMapping: { output: { offset: 256, length: 4 } },
        provenance: ['lateral-watersuite-dev0000001-sensorreadings-v1-tick-918'],
        deprecation: null,
      },
      outputVector: {
        values: [1, 0, 0, 0],
        encoding: 'vector',
        semantics: [
          { index: 0, label: 'cell_0' },
          { index: 1, label: 'cell_1' },
          { index: 2, label: 'cell_2' },
          { index: 3, label: 'cell_3' },
        ],
        assertedLabel: 'cell_0',
      },
      projection: null,
      governance: opAGX051.governance,
      dispatch: {
        agent: 'aquaculture_predictive_maintenance_agent',
        action: 'Dispatch aquaculture_predictive_maintenance_agent for urgent maintenance and record corrective action.',
        agentActionsCatalog: machineAGX051.metadata!.agentActions!,
        trigger: 'agriculture-yuma-aqua-maintenance-forecaster-maintenance',
        // Emitted unconditionally, as C++ does: '' and null for a legacy-bound machine.
        autonomyMode: '',
        writeBack: null,
        endpoint: { kind: 'dry-run', url: '', mutation: '', schemaRef: '' },
      },
    });
  });

  it('populates the graphql endpoint metadata when mode === "graphql"', () => {
    const env = buildTriggerEnvelope(opAGX051, machineAGX051, 'e', 'c', ctx({ mode: 'graphql' }));
    expect(env.dispatch.endpoint).toEqual({
      kind: 'graphql',
      url: 'http://localhost:4000/graphql',
      mutation: 'updateProcessState',
      schemaRef: 'localAIStack/services/api/routers/graphql_endpoint.py',
    });
  });

  it('falls back gracefully when fields are missing', () => {
    const env = buildTriggerEnvelope(
      { machineId: 'm', values: [0, 0] },
      { id: 'm' },
      'e', 'c', ctx(),
    );
    expect(env.ces.machineName).toBe('m');
    expect(env.ces.machineCode).toBe('');
    expect(env.ces.sequenceId).toBe('');
    expect(env.ces.sequenceName).toBe('');
    expect(env.ces.perceptualMapping.output).toBeNull();
    expect(env.outputVector.assertedLabel).toBe('none');
    expect(env.dispatch.agent).toBe('');
    expect(env.dispatch.trigger).toBe('');
    expect(env.dispatch.agentActionsCatalog).toEqual([]);
    expect(env.governance).toBeNull();
  });
});

// The native binding rule (C++ dispatch_binding, LSP ces-dispatch-binding,
// Scala TriggerDispatcher.binding): agentBinding first, legacy fields as the
// per-field fallback (RealityEngine_Machines#126).
describe('dispatchBinding', () => {
  const writeBack = { type: 'pe-sensor', provider: 'localai', sensorId: 'acp.openclaw.hello-world.completion' };

  it('resolves a machine bound only through agentBinding', () => {
    const b = dispatchBinding({
      agentBinding: { agent: 'openclaw_e2e_agent', trigger: 'openclaw-e2e-dispatch-seed', mode: 'advise',
                      allowedActions: ['first', 'second'], writeBack },
    }, [0, 1, 0, 1]);
    expect(b).toEqual({
      agent: 'openclaw_e2e_agent', trigger: 'openclaw-e2e-dispatch-seed', autonomyMode: 'advise',
      actions: ['first', 'second'], action: 'second', writeBack,
    });
  });

  it('falls back to the legacy field for each one agentBinding leaves out', () => {
    const b = dispatchBinding({
      dispatchableAgent: 'legacy_agent', aiTrigger: 'legacy-trigger', agentActions: ['legacy-act'],
      agentBinding: { mode: 'advise' },
    }, [0, 0]);
    expect(b).toMatchObject({ agent: 'legacy_agent', trigger: 'legacy-trigger', actions: ['legacy-act'],
                              action: 'legacy-act', autonomyMode: 'advise', writeBack: null });
  });

  it('prefers agentBinding over the legacy fields when both are present', () => {
    const b = dispatchBinding({
      dispatchableAgent: 'legacy_agent', aiTrigger: 'legacy-trigger',
      agentBinding: { agent: 'bound_agent', trigger: 'bound-trigger' },
    }, []);
    expect(b.agent).toBe('bound_agent');
    expect(b.trigger).toBe('bound-trigger');
  });

  it('reads the legacy fields alone, with no mode or writeBack', () => {
    expect(dispatchBinding(machineAGX051.metadata, [1, 0, 0, 0])).toMatchObject({
      agent: 'aquaculture_predictive_maintenance_agent',
      trigger: 'agriculture-yuma-aqua-maintenance-forecaster-maintenance',
      autonomyMode: '', writeBack: null,
    });
  });

  it('selects the action at the first non-zero cell, else the first action', () => {
    const md = { agentActions: ['a0', 'a1', 'a2'] };
    expect(dispatchBinding(md, [0, 0, 1]).action).toBe('a2');
    expect(dispatchBinding(md, [0, 0, 0]).action).toBe('a0');
    expect(dispatchBinding(md, [0, 0, 0, 5]).action).toBe('a0');
  });

  it('carries the binding into envelope.dispatch', () => {
    const env = buildTriggerEnvelope(
      { ...opAGX051, machineId: 'm-ab', values: [0, 1] },
      { id: 'm-ab', name: 'Bound', metadata: { agentBinding: {
        agent: 'bound_agent', trigger: 'bound-trigger', mode: 'advise', allowedActions: ['x', 'y'], writeBack } } },
      'env-1', 'corr-1', ctx());
    expect(env.dispatch).toMatchObject({
      agent: 'bound_agent', trigger: 'bound-trigger', action: 'y', agentActionsCatalog: ['x', 'y'],
      autonomyMode: 'advise', writeBack,
    });
  });
});
