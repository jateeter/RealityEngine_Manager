/**
 * Completion round-trip — end-to-end async tests.
 *
 * Each test covers one slice of the full causal chain:
 *
 *   RE step → Dispatcher → TriggerEnvelope + DispatchRecord
 *     → AdapterPipeline → ProviderAdapter.dispatch()
 *       → DispatchReceipt → ledger PATCH
 *         → resolveCompletion() → signal
 *           → PerceptionEngine.updateSensorValue()
 *             → assembleVector() reflects the AI values
 *               → "machine transition" (vector at completion region changes)
 *
 * All external I/O is stubbed.  The PerceptionEngine runs fully in-process
 * so the vector delta can be asserted byte-for-byte.
 */

import { describe, it, expect } from '@jest/globals';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Dispatcher } from '../triggers/Dispatcher.js';
import type { DispatcherConfig, DispatcherDeps } from '../triggers/Dispatcher.js';
import type { MachineRecord, MergeOp, TriggerEnvelope } from '../triggers/types.js';
import { Ledger } from '../dispatch/Ledger.js';
import type { DispatchRecord } from '../dispatch/types.js';
import { AdapterPipeline } from '../integrations/AdapterPipeline.js';
import type { DispatchReceipt, ProviderAdapter } from '../integrations/adapters/types.js';
import { resolveCompletion } from '../integrations/SourceMapper.js';
import { loadRegistry } from '../integrations/Registry.js';
import { PerceptionEngine } from '../PerceptionEngine.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_750_000_000_000;
const REGION = { offset: 4200, length: 4 };

/** Registry with one completion source mapping. */
const COMPLETION_MAPPING = {
  id: 'agent-completion-risk',
  sensorIdTemplate: 'agent.{agent}.completion',
  region: REGION,
  extract: { type: 'json', pointers: ['/completed', '/failed', '/confidence', '/actionClass'] },
  normalize: { mode: 'passthrough', clamp: true },
  ttlMs: 300_000,
};

function makeRegistry(mapping = COMPLETION_MAPPING) {
  const dir = mkdtempSync(join(tmpdir(), 'crt-'));
  const path = join(dir, 'r.json');
  writeFileSync(path, JSON.stringify({ integrations: [], sourceMappings: [mapping] }), 'utf8');
  const state = loadRegistry(path);
  rmSync(dir, { recursive: true, force: true });
  return state;
}

/** Machine catalog entry with a dispatchable agent. */
const MACHINE: MachineRecord = {
  id: 'm-paging',
  name: 'Paging Decision Machine',
  metadata: {
    dispatchableAgent: 'paging-decision',
    aiTrigger: 'ces.terminal.paging',
    machineCode: 'PDM001',
    agentActions: ['escalate', 'notify', 'hold'],
  },
};

/** The merge op that represents a CES terminal event. */
const TERMINAL_OP: MergeOp = {
  machineId: 'm-paging',
  sequenceId: 'seq-critical',
  outputIndex: 0,
  region: { offset: 0, length: 4 },
  values: [1, 0, 0, 0],
  provenance: [],
  governance: { ragStatusCode: 'RED', processStatus: 'critical' },
};

/** Stub HTTP client — captures all PATCH calls. */
function stubHttp(onPost?: (url: string, body: unknown) => { status: number; data: unknown }) {
  const patches: Array<{ url: string; body: unknown }> = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  const patch = async (url: string, body: unknown, _cfg?: AxiosRequestConfig) => {
    patches.push({ url, body });
    return { status: 200, data: { success: true } };
  };
  const post = async (url: string, body: unknown, _cfg?: AxiosRequestConfig) => {
    posts.push({ url, body });
    return onPost ? onPost(url, body) : { status: 200, data: { success: true } };
  };
  return {
    http: { patch, post } as unknown as AxiosInstance,
    patches,
    posts,
  };
}

/** Build Dispatcher with an injectable pipeline, ledger, and machine map. */
function makeDispatcher(
  machineMap: Map<string, MachineRecord>,
  ledger: Ledger,
  pipeline?: { onRecord: (e: TriggerEnvelope, r: DispatchRecord) => void },
) {
  let seq = 0;
  const cfg: DispatcherConfig = {
    enabled: true,
    mode: 'https',
    graphqlEndpoint: 'http://localhost:4000/graphql',
    realityEngineUrl: 'http://localhost:3000',
  };
  const deps: DispatcherDeps = {
    getMachine: (id) => machineMap.get(id),
    broadcast: () => {},
    now: () => NOW,
    newId: (kind) => `${kind}-${++seq}`,
    ledger,
    pipeline,
  };
  return new Dispatcher(cfg, deps);
}

// ── helpers ───────────────────────────────────────────────────────────────────

const tick = () => new Promise<void>((r) => setImmediate(r));

// ── 1. Dispatcher → pipeline.onRecord ─────────────────────────────────────────

describe('Dispatcher → pipeline.onRecord', () => {
  it('fires pipeline.onRecord with the envelope and record after a qualifying step', () => {
    const ledger = new Ledger({ now: () => NOW });
    const fired: Array<{ envelope: TriggerEnvelope; record: DispatchRecord }> = [];

    const dispatcher = makeDispatcher(
      new Map([['m-paging', MACHINE]]),
      ledger,
      { onRecord: (e, r) => { fired.push({ envelope: e, record: r }); } },
    );

    const summary = dispatcher.dispatchStep({ mergeBatch: [TERMINAL_OP] });

    expect(summary.envelopesCreated).toBe(1);
    expect(summary.dispatchRecordsCreated).toBe(1);
    expect(fired).toHaveLength(1);

    const { envelope, record } = fired[0]!;
    expect(envelope.envelopeType).toBe('ces.terminal.event');
    expect(envelope.ces.machineId).toBe('m-paging');
    expect(envelope.dispatch.agent).toBe('paging-decision');
    expect(record.status).toBe('recorded');
    expect(record.machineId).toBe('m-paging');
    expect(ledger.get(record.id)).toBeDefined();
  });

  it('does not fire pipeline when the op has no governance', () => {
    const ledger = new Ledger({ now: () => NOW });
    const fired: unknown[] = [];
    const dispatcher = makeDispatcher(
      new Map([['m-paging', MACHINE]]),
      ledger,
      { onRecord: (e) => { fired.push(e); } },
    );

    dispatcher.dispatchStep({ mergeBatch: [{ ...TERMINAL_OP, governance: null }] });
    expect(fired).toHaveLength(0);
    expect(ledger.size()).toBe(0);
  });
});

// ── 2. AdapterPipeline → ledger PATCH ─────────────────────────────────────────

describe('AdapterPipeline → dispatch → ledger PATCH', () => {
  it('PATCHes the ledger record status=sent after adapter returns a sent receipt', async () => {
    const { http, patches } = stubHttp();
    const pipeline = new AdapterPipeline({ http, ledgerPatchBaseUrl: 'http://pe.test' });

    const capturedEnvelopes: TriggerEnvelope[] = [];
    const stubAdapter: ProviderAdapter = {
      kind: 'https',
      async init() {},
      async shutdown() {},
      async dispatch(env): Promise<DispatchReceipt> {
        capturedEnvelopes.push(env);
        return {
          provider: 'https', adapter: 'https', latencyMs: 5,
          status: 'sent', externalRunId: 'run-e2e-1',
          metadata: { model: 'paging-v1', cells: 4 },
        };
      },
    };
    pipeline.register(stubAdapter);

    const ledger = new Ledger({ now: () => NOW });
    const dispatcher = makeDispatcher(new Map([['m-paging', MACHINE]]), ledger, pipeline);
    dispatcher.dispatchStep({ mergeBatch: [TERMINAL_OP] });

    await tick(); await tick();

    expect(capturedEnvelopes).toHaveLength(1);
    expect(capturedEnvelopes[0]!.dispatch.agent).toBe('paging-decision');

    expect(patches).toHaveLength(1);
    const patchUrl = patches[0]!.url;
    expect(patchUrl).toMatch(/\/api\/dispatch\/records\//);

    const patchBody = patches[0]!.body as Record<string, unknown>;
    expect(patchBody['status']).toBe('sent');
    expect(patchBody['incrementAttempts']).toBe(true);
    expect(patchBody['externalRunId']).toBe('run-e2e-1');
    expect((patchBody['providerReceipt'] as Record<string, unknown>)['cells']).toBe(4);
  });

  it('PATCHes status=failed when the adapter throws', async () => {
    const { http, patches } = stubHttp();
    const errors: unknown[] = [];
    const pipeline = new AdapterPipeline({
      http,
      ledgerPatchBaseUrl: 'http://pe.test',
      onError: (err) => { errors.push(err); },
    });

    pipeline.register({
      kind: 'https',
      async init() {},
      async shutdown() {},
      async dispatch(): Promise<DispatchReceipt> { throw new Error('provider-timeout'); },
    });

    const ledger = new Ledger({ now: () => NOW });
    const dispatcher = makeDispatcher(new Map([['m-paging', MACHINE]]), ledger, pipeline);
    dispatcher.dispatchStep({ mergeBatch: [TERMINAL_OP] });

    await tick(); await tick();

    expect(errors).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect((patches[0]!.body as Record<string, unknown>)['status']).toBe('failed');
  });
});

// ── 3. resolveCompletion → PerceptionEngine ────────────────────────────────────

describe('resolveCompletion → PerceptionEngine → vector delta', () => {
  it('maps a completion body to a signal and the vector reflects the AI values', () => {
    const registry = makeRegistry();
    const engine = new PerceptionEngine(REGION.offset + REGION.length + 4);

    // Add the sensor source so assembleVector() sees it.
    engine.addSource({
      type: 'sensor',
      name: 'agent.paging-decision.completion',
      sensorId: 'agent.paging-decision.completion',
      region: REGION,
      active: true,
      lastValue: new Array(REGION.length).fill(0),
      lastUpdated: null,
      ttlMs: 300_000,
    });

    const before = engine.assembleVector().slice(REGION.offset, REGION.offset + REGION.length);
    expect(before).toEqual([0, 0, 0, 0]);

    // Simulate what the AI adapter produces and POSTs to /api/integrations/completions.
    const completionBody = {
      provider: 'https',
      agent: 'paging-decision',
      correlationId: 'corr-e2e',
      envelopeId: 'env-e2e',
      sourceMappingId: 'agent-completion-risk',
      values: [1, 0, 0.82, 0],   // completed=1, failed=0, confidence=0.82, actionClass=0
    };

    const result = resolveCompletion(completionBody, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { signal, ctx } = result;
    expect(signal.sensorId).toBe('agent.paging-decision.completion');
    expect(signal.region).toEqual(REGION);
    expect(signal.values).toEqual([1, 0, 0.82, 0]);
    expect(ctx.agent).toBe('paging-decision');
    expect(ctx.sourceMappingId).toBe('agent-completion-risk');

    const updated = engine.updateSensorValue(signal.sensorId, signal.values);
    expect(updated).toBe(true);

    const after = engine.assembleVector().slice(REGION.offset, REGION.offset + REGION.length);
    // Clamped to [0,1] per PerceptionEngine.assembleVector() semantics.
    expect(after[0]).toBe(1);       // completed
    expect(after[1]).toBe(0);       // failed
    expect(after[2]).toBeCloseTo(0.82, 5);  // confidence
    expect(after[3]).toBe(0);       // actionClass
  });

  it('vector at completion region is zero before the signal lands, non-zero after', () => {
    const registry = makeRegistry();
    const engine = new PerceptionEngine(REGION.offset + REGION.length + 4);

    engine.addSource({
      type: 'sensor',
      name: 'agent.paging-decision.completion',
      sensorId: 'agent.paging-decision.completion',
      region: REGION,
      active: true,
      lastValue: new Array(REGION.length).fill(0),
      lastUpdated: null,
      ttlMs: 300_000,
    });

    const before = engine.assembleVector();
    expect(before.slice(REGION.offset, REGION.offset + REGION.length).every((v) => v === 0)).toBe(true);

    const result = resolveCompletion({
      provider: 'https', agent: 'paging-decision',
      correlationId: 'c', envelopeId: 'e',
      sourceMappingId: 'agent-completion-risk',
      values: [1, 0, 0.9, 1],
    }, registry);
    if (!result.ok) throw new Error(result.error);

    engine.updateSensorValue(result.signal.sensorId, result.signal.values);

    const after = engine.assembleVector();
    const completionCells = after.slice(REGION.offset, REGION.offset + REGION.length);
    expect(completionCells.some((v) => v > 0)).toBe(true);

    // Cells outside the completion region are unchanged.
    const untouched = after.slice(0, REGION.offset);
    expect(untouched.every((v) => v === 0)).toBe(true);
  });
});

// ── 4. Full round-trip: Dispatcher → adapter → completion → engine ─────────────

describe('Full completion round-trip', () => {
  it('dispatches an envelope, stub adapter resolves completion, vector updates', async () => {
    const registry = makeRegistry();
    const engine = new PerceptionEngine(REGION.offset + REGION.length + 4);

    engine.addSource({
      type: 'sensor',
      name: 'agent.paging-decision.completion',
      sensorId: 'agent.paging-decision.completion',
      region: REGION,
      active: true,
      lastValue: new Array(REGION.length).fill(0),
      lastUpdated: null,
      ttlMs: 300_000,
    });

    const { http, patches } = stubHttp();
    const completionValues: number[][] = [];

    // This adapter simulates the full sync provider path:
    //   1. "calls" the AI (fabricated here)
    //   2. resolves the completion through SourceMapper in-process
    //   3. applies the signal directly to the engine
    const e2eAdapter: ProviderAdapter = {
      kind: 'https',
      async init() {},
      async shutdown() {},
      async dispatch(envelope): Promise<DispatchReceipt> {
        const aiOutput = [1, 0, 0.75, 0];  // what the AI returned
        const result = resolveCompletion({
          provider: 'https',
          agent: envelope.dispatch.agent,
          correlationId: envelope.correlationId,
          envelopeId: envelope.envelopeId,
          sourceMappingId: 'agent-completion-risk',
          values: aiOutput,
        }, registry);
        if (!result.ok) throw new Error(result.error);
        engine.updateSensorValue(result.signal.sensorId, result.signal.values);
        completionValues.push(result.signal.values.slice());
        return {
          provider: 'https', adapter: 'https', latencyMs: 12,
          status: 'sent', externalRunId: 'run-roundtrip-1',
          metadata: { cells: REGION.length },
        };
      },
    };

    const pipeline = new AdapterPipeline({ http, ledgerPatchBaseUrl: 'http://pe.test' });
    pipeline.register(e2eAdapter);

    const ledger = new Ledger({ now: () => NOW });
    const dispatcher = makeDispatcher(new Map([['m-paging', MACHINE]]), ledger, pipeline);

    // 1. Trigger the step — Dispatcher creates envelope and fires pipeline.
    const summary = dispatcher.dispatchStep({ mergeBatch: [TERMINAL_OP] });
    expect(summary.envelopesCreated).toBe(1);

    // 2. Let async dispatch complete.
    await tick(); await tick();

    // 3. Adapter fired and resolved the completion.
    expect(completionValues).toHaveLength(1);
    expect(completionValues[0]).toEqual([1, 0, 0.75, 0]);

    // 4. Ledger record was patched to 'sent'.
    expect(patches).toHaveLength(1);
    expect((patches[0]!.body as Record<string, unknown>)['status']).toBe('sent');
    expect((patches[0]!.body as Record<string, unknown>)['externalRunId']).toBe('run-roundtrip-1');

    // 5. The perceptual vector at the completion region now carries the AI values —
    //    this is the "machine transition" signal: on the next push to the RE, the
    //    machine's input at REGION.offset will be [1, 0, 0.75, 0] instead of zeros,
    //    driving the sequence forward (e.g. from idle → escalate).
    const vector = engine.assembleVector();
    const completionCells = vector.slice(REGION.offset, REGION.offset + REGION.length);
    expect(completionCells[0]).toBe(1);
    expect(completionCells[1]).toBe(0);
    expect(completionCells[2]).toBeCloseTo(0.75, 5);
    expect(completionCells[3]).toBe(0);
  });

  it('dispatches multiple machines in one step and updates independent completion regions', async () => {
    const REGION_A = { offset: 100, length: 2 };
    const REGION_B = { offset: 200, length: 2 };
    const mappingA = { ...COMPLETION_MAPPING, id: 'mapping-a', region: REGION_A };
    const mappingB = { ...COMPLETION_MAPPING, id: 'mapping-b', region: REGION_B };

    const dir = mkdtempSync(join(tmpdir(), 'crt-multi-'));
    const path = join(dir, 'r.json');
    writeFileSync(path, JSON.stringify({ integrations: [], sourceMappings: [mappingA, mappingB] }), 'utf8');
    const registry = loadRegistry(path);
    rmSync(dir, { recursive: true, force: true });

    const engine = new PerceptionEngine(300);
    for (const [sid, region, name] of [
      ['sensor.a', REGION_A, 'Agent A'],
      ['sensor.b', REGION_B, 'Agent B'],
    ] as const) {
      engine.addSource({
        type: 'sensor', name, sensorId: sid, region,
        active: true, lastValue: [0, 0], lastUpdated: null, ttlMs: 300_000,
      });
    }

    const machineA: MachineRecord = { id: 'ma', name: 'Machine A', metadata: { dispatchableAgent: 'agent-a', aiTrigger: 'x', machineCode: 'A', agentActions: [] } };
    const machineB: MachineRecord = { id: 'mb', name: 'Machine B', metadata: { dispatchableAgent: 'agent-b', aiTrigger: 'x', machineCode: 'B', agentActions: [] } };
    const opA: MergeOp = { machineId: 'ma', sequenceId: 's', region: REGION_A, values: [1, 0], governance: { ragStatusCode: 'RED' } };
    const opB: MergeOp = { machineId: 'mb', sequenceId: 's', region: REGION_B, values: [1, 0], governance: { ragStatusCode: 'RED' } };

    const capturedSensorIds: string[] = [];
    const { http } = stubHttp();
    const pipeline = new AdapterPipeline({ http, ledgerPatchBaseUrl: 'http://pe.test' });
    pipeline.register({
      kind: 'https',
      async init() {},
      async shutdown() {},
      async dispatch(env): Promise<DispatchReceipt> {
        const mappingId = env.dispatch.agent === 'agent-a' ? 'mapping-a' : 'mapping-b';
        const sensorId = env.dispatch.agent === 'agent-a' ? 'sensor.a' : 'sensor.b';
        const result = resolveCompletion({
          provider: 'https', agent: env.dispatch.agent,
          correlationId: env.correlationId, envelopeId: env.envelopeId,
          sourceMappingId: mappingId,
          sensorId,
          values: [0.9, 0.1],
        }, registry);
        if (!result.ok) throw new Error(result.error);
        engine.updateSensorValue(result.signal.sensorId, result.signal.values);
        capturedSensorIds.push(result.signal.sensorId);
        return { provider: 'https', adapter: 'https', latencyMs: 3, status: 'sent' };
      },
    });

    const ledger = new Ledger({ now: () => NOW });
    const dispatcher = makeDispatcher(new Map([['ma', machineA], ['mb', machineB]]), ledger, pipeline);
    const summary = dispatcher.dispatchStep({ mergeBatch: [opA, opB] });
    expect(summary.envelopesCreated).toBe(2);

    await tick(); await tick();

    expect(capturedSensorIds.sort()).toEqual(['sensor.a', 'sensor.b'].sort());

    const vector = engine.assembleVector();
    // Both regions independently updated.
    expect(vector[REGION_A.offset]).toBeCloseTo(0.9, 5);
    expect(vector[REGION_B.offset]).toBeCloseTo(0.9, 5);
    // Regions don't bleed into each other.
    expect(vector[REGION_A.offset + 10]).toBe(0);
  });
});

// ── 5. Ledger record state machine ───────────────────────────────────────────

describe('Dispatch record lifecycle', () => {
  it('transitions: recorded → sent after successful adapter dispatch', async () => {
    const { http } = stubHttp();
    const pipeline = new AdapterPipeline({ http, ledgerPatchBaseUrl: 'http://pe.test' });
    pipeline.register({
      kind: 'https',
      async init() {},
      async shutdown() {},
      async dispatch(): Promise<DispatchReceipt> {
        return { provider: 'https', adapter: 'https', latencyMs: 8, status: 'sent', externalRunId: 'run-state-1' };
      },
    });

    const ledger = new Ledger({ now: () => NOW });
    const dispatcher = makeDispatcher(new Map([['m-paging', MACHINE]]), ledger, pipeline);
    dispatcher.dispatchStep({ mergeBatch: [TERMINAL_OP] });

    // Before async dispatch completes, record is still 'recorded'.
    const [record] = ledger.list();
    expect(record).toBeDefined();
    expect(record!.status).toBe('recorded');
    expect(record!.attempts).toBe(0);

    await tick(); await tick();

    // After PATCH (via HTTP), the in-process ledger is NOT updated — the server's
    // own PATCH handler updates the shared ledger.  We verify the PATCH was issued
    // correctly instead (tested in AdapterPipeline.test.ts).
    // What we can confirm here is that the envelope remains immutable.
    const same = ledger.get(record!.id);
    expect(same!.envelope.envelopeId).toBe(record!.envelope.envelopeId);
    expect(same!.envelope.ces.machineId).toBe('m-paging');
  });

  it('replay creates a new record linked to the original (but does not re-fire the adapter pipeline)', () => {
    const ledger = new Ledger({ now: () => NOW });
    const fired: Array<{ envelope: TriggerEnvelope; record: DispatchRecord }> = [];
    const dispatcher = makeDispatcher(
      new Map([['m-paging', MACHINE]]),
      ledger,
      { onRecord: (e, r) => { fired.push({ envelope: e, record: r }); } },
    );
    dispatcher.dispatchStep({ mergeBatch: [TERMINAL_OP] });

    const original = ledger.list()[0]!;
    // freshIds:true mints new envelope/correlation IDs (new causal chain).
    const replayed = dispatcher.replay(original.id, { freshIds: true });
    expect(replayed).toBeDefined();
    expect(replayed!.replayOf).toBe(original.id);
    expect(replayed!.id).not.toBe(original.id);
    expect(replayed!.envelopeId).not.toBe(original.envelopeId);
    // replay() only appends to the ledger + broadcasts; it does NOT call
    // pipeline.onRecord (re-dispatch via the adapter is the caller's choice).
    expect(fired).toHaveLength(1);
    expect(ledger.size()).toBe(2);  // original + replay both in ledger
    expect(ledger.get(replayed!.id)!.mode).toBe('replay');
  });
});
