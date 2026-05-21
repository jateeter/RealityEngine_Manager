/**
 * envelopeBuilder — contract tests.
 *
 * Mirrors the wire shape produced by RealityEngine_CPP::build_trigger_envelope
 * (src/perception_engine_server.cpp).  Each assertion maps to a field both
 * engines must agree on for adapter interop.
 */

import { describe, it, expect } from '@jest/globals';

import {
  assertedLabel,
  buildTriggerEnvelope,
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
