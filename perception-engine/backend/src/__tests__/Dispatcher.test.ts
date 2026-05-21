/**
 * Dispatcher — Phase 2 contract tests.
 *
 * Covers fire-and-record semantics, drop classification, counter wire-
 * compatibility with `RealityEngine_CPP::trigger_status()`, the WS
 * broadcast event, and the 256-entry FIFO ring eviction.
 */

import { describe, it, expect } from '@jest/globals';

import { Dispatcher } from '../triggers/Dispatcher.js';
import type { DispatcherConfig, DispatcherDeps } from '../triggers/Dispatcher.js';
import type { MachineRecord, MergeOp } from '../triggers/types.js';

const NOW = 1_700_000_000_000;

function harness(cfgOverrides: Partial<DispatcherConfig> = {}, machineMap: Map<string, MachineRecord> = new Map()) {
  let idCounter = 0;
  const broadcasts: Record<string, unknown>[] = [];
  const deps: DispatcherDeps = {
    getMachine: (id) => machineMap.get(id),
    broadcast: (evt) => { broadcasts.push(evt); },
    now: () => NOW,
    newId: (kind) => `${kind}-${++idCounter}`,
  };
  const cfg: DispatcherConfig = {
    enabled: true,
    mode: 'dry-run',
    graphqlEndpoint: 'http://localhost:4000/graphql',
    realityEngineUrl: 'http://reality:3001',
    ...cfgOverrides,
  };
  return { dispatcher: new Dispatcher(cfg, deps), broadcasts, machineMap };
}

const machine: MachineRecord = {
  id: 'm-1',
  name: 'Test Machine',
  metadata: {
    dispatchableAgent: 'agent_x',
    aiTrigger: 'trigger_x',
    machineCode: 'TST001',
    agentActions: ['act-1', 'act-2'],
  },
};

const goodOp: MergeOp = {
  machineId: 'm-1',
  sequenceId: 'seq-1',
  region: { offset: 0, length: 2 },
  values: [1, 0],
  governance: { ragStatusCode: 'RED', processStatus: 'error' },
};

const opNoGovernance: MergeOp = { ...goodOp, governance: null as any };
const opUnknownMachine: MergeOp = { ...goodOp, machineId: 'unknown' };
const opMissingAgent: MergeOp = { ...goodOp, machineId: 'no-agent' };

const machinesByMid = new Map<string, MachineRecord>([
  ['m-1', machine],
  ['no-agent', { id: 'no-agent', metadata: { aiTrigger: 'x' } }],
]);

describe('Dispatcher — disabled', () => {
  it('is a no-op when enabled:false', () => {
    const { dispatcher, broadcasts } = harness({ enabled: false }, machinesByMid);
    const s = dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    expect(s.envelopesCreated).toBe(0);
    expect(s.mergeOps).toBe(0);
    expect(broadcasts).toEqual([]);
    expect(dispatcher.status().enabled).toBe(false);
  });
});

describe('Dispatcher — happy path', () => {
  it('creates one envelope per qualifying op and broadcasts trigger.envelope.created', () => {
    const { dispatcher, broadcasts } = harness({}, machinesByMid);
    const s = dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    expect(s).toEqual({
      enabled: true,
      mode: 'dry-run',
      mergeOps: 1,
      envelopesCreated: 1,
      dispatchRecordsCreated: 1,
      droppedNoGovernance: 0,
      droppedNoDispatch: 0,
      errors: 0,
    });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      type: 'trigger.envelope.created',
      envelopeId: 'trigger-envelope-1',
      correlationId: 'trigger-correlation-2',
      dispatchId: 'dispatch-3',
      target: 'agent_x',
      mode: 'dry-run',
    });
  });

  it('records the envelope in the ledger with C++-shaped DispatchRecord fields', () => {
    const { dispatcher } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    const records = dispatcher.listRecords();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.status).toBe('recorded');
    expect(r.target).toBe('agent_x');
    expect(r.machineId).toBe('m-1');
    expect(r.sequenceId).toBe('seq-1');
    expect(r.ragStatusCode).toBe('RED');
    expect(r.processStatus).toBe('error');
    expect(r.attempts).toBe(0);
    expect(r.providerReceipt).toBeNull();
    expect(r.envelope.envelopeType).toBe('ces.terminal.event');
  });
});

describe('Dispatcher — drop classification', () => {
  it('counts ops without governance as droppedNoGovernance', () => {
    const { dispatcher } = harness({}, machinesByMid);
    const s = dispatcher.dispatchStep({ mergeBatch: [opNoGovernance] });
    expect(s.envelopesCreated).toBe(0);
    expect(s.droppedNoGovernance).toBe(1);
    expect(dispatcher.status().droppedNoGovernance).toBe(1);
  });

  it('counts ops with unknown machineId as droppedNoDispatch', () => {
    const { dispatcher } = harness({}, machinesByMid);
    const s = dispatcher.dispatchStep({ mergeBatch: [opUnknownMachine] });
    expect(s.droppedNoDispatch).toBe(1);
    expect(dispatcher.status().droppedNoDispatch).toBe(1);
  });

  it('counts ops with no dispatchable agent as droppedNoDispatch', () => {
    const { dispatcher } = harness({}, machinesByMid);
    const s = dispatcher.dispatchStep({ mergeBatch: [opMissingAgent] });
    expect(s.droppedNoDispatch).toBe(1);
  });

  it('mixes pass/drop in a single step', () => {
    const { dispatcher } = harness({}, machinesByMid);
    const s = dispatcher.dispatchStep({
      mergeBatch: [goodOp, opNoGovernance, opUnknownMachine, opMissingAgent],
    });
    expect(s).toEqual({
      enabled: true,
      mode: 'dry-run',
      mergeOps: 4,
      envelopesCreated: 1,
      dispatchRecordsCreated: 1,
      droppedNoGovernance: 1,
      droppedNoDispatch: 2,
      errors: 0,
    });
  });
});

describe('Dispatcher — status() shape', () => {
  it('matches the C++ /api/triggers/status response shape', () => {
    const { dispatcher } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp, opNoGovernance, opUnknownMachine] });
    expect(dispatcher.status()).toEqual({
      enabled: true,
      mode: 'dry-run',
      graphqlEndpoint: 'http://localhost:4000/graphql',
      records: 1,
      envelopesCreated: 1,
      droppedNoGovernance: 1,
      droppedNoDispatch: 1,
      dispatchErrors: 0,
      replaysCreated: 0,
    });
  });
});

describe('Dispatcher — ring eviction', () => {
  it('caps records at 256 (FIFO eviction)', () => {
    const { dispatcher } = harness({}, machinesByMid);
    for (let i = 0; i < 260; i++) {
      dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    }
    const records = dispatcher.listRecords();
    expect(records).toHaveLength(256);
    expect(dispatcher.status().envelopesCreated).toBe(260); // cumulative counter unaffected
    expect(dispatcher.status().records).toBe(256);
  });
});

describe('Dispatcher.replay', () => {
  it('returns undefined when the dispatchId is unknown', () => {
    const { dispatcher } = harness({}, machinesByMid);
    expect(dispatcher.replay('nope')).toBeUndefined();
  });

  it('appends a new record with mode:replay, status:recorded, attempts:0, and replayOf set', () => {
    const { dispatcher } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    const original = dispatcher.listRecords()[0]!;
    const replayed = dispatcher.replay(original.id);
    expect(replayed).toBeDefined();
    expect(replayed?.id).not.toBe(original.id);
    expect(replayed?.mode).toBe('replay');
    expect(replayed?.status).toBe('recorded');
    expect(replayed?.attempts).toBe(0);
    expect(replayed?.replayOf).toBe(original.id);
    expect(replayed?.providerReceipt).toBeNull();
    expect(dispatcher.listRecords()).toHaveLength(2);
  });

  it('preserves envelopeId/correlationId by default (same causal chain)', () => {
    const { dispatcher } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    const original = dispatcher.listRecords()[0]!;
    const replayed = dispatcher.replay(original.id)!;
    expect(replayed.envelopeId).toBe(original.envelopeId);
    expect(replayed.correlationId).toBe(original.correlationId);
    expect(replayed.envelope).toBe(original.envelope);   // same object reference
  });

  it('mints fresh envelope+correlation ids when freshIds:true', () => {
    const { dispatcher } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    const original = dispatcher.listRecords()[0]!;
    const replayed = dispatcher.replay(original.id, { freshIds: true })!;
    expect(replayed.envelopeId).not.toBe(original.envelopeId);
    expect(replayed.correlationId).not.toBe(original.correlationId);
    expect(replayed.envelope.envelopeId).toBe(replayed.envelopeId);
    expect(replayed.envelope.correlationId).toBe(replayed.correlationId);
  });

  it('broadcasts trigger.envelope.created with replayOf and mode:replay', () => {
    const { dispatcher, broadcasts } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    const original = dispatcher.listRecords()[0]!;
    broadcasts.length = 0;          // discard the original-fire event
    dispatcher.replay(original.id);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'trigger.envelope.created',
      mode: 'replay',
      replayOf: original.id,
    });
  });

  it('increments envelopesCreated + replaysCreated on /api/triggers/status', () => {
    const { dispatcher } = harness({}, machinesByMid);
    dispatcher.dispatchStep({ mergeBatch: [goodOp] });
    const before = dispatcher.status();
    expect(before.envelopesCreated).toBe(1);
    expect(before.replaysCreated).toBe(0);
    dispatcher.replay(dispatcher.listRecords()[0]!.id);
    const after = dispatcher.status();
    expect(after.envelopesCreated).toBe(2);
    expect(after.replaysCreated).toBe(1);
    expect(after.records).toBe(2);
  });
});

describe('Dispatcher — malformed input tolerance', () => {
  it('returns an empty summary when step is null or has no mergeBatch', () => {
    const { dispatcher } = harness({}, machinesByMid);
    expect(dispatcher.dispatchStep(null).envelopesCreated).toBe(0);
    expect(dispatcher.dispatchStep({}).envelopesCreated).toBe(0);
    expect(dispatcher.dispatchStep({ mergeBatch: 'nope' }).envelopesCreated).toBe(0);
  });
});
