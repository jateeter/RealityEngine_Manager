import { describe, expect, it } from 'vitest';
import { SimulatedAgent, type AgentLifecycle } from '../instantiation/agents.js';
import { InstantiationController, envelopeOf, type Clone, type Continuation, type Engines, type FrameSummary, type Lifecycle } from '../instantiation/controller.js';
import { machineIdOf, successorOf, type TemplateMachine } from '../instantiation/successor.js';

const last = <T>(xs: T[]): T => xs[xs.length - 1];

const handoff = (source: string, target: string, assetTypeId?: string) =>
  ({ type: 'document-workflow-handoff', sourceMachine: source, targetMachine: target, ...(assetTypeId ? { assetTypeId } : {}) });

// Two IFRS-like templates: the verifier hands off to the arbiter, which hands off to nothing.
const TEMPLATES: Record<string, TemplateMachine> = {
  [machineIdOf('IFRS_Sec01_Verifier')]: { id: machineIdOf('IFRS_Sec01_Verifier'), metadata: { interconnections: [
    { type: 'published-domain-bus-producer', targetMachineFile: 'X.json' },
    handoff('IFRS_Sec01_Verifier', 'IFRS_Sec03_Arbiter', 'COMPLIANCE-REVIEW'),
    handoff('IFRS_Sec01_Verifier', 'IFRS_Sec09_Checklist', 'DISCLOSURE-CHECKLIST'),
    handoff('Someone_Else', 'IFRS_Elsewhere')
  ] } },
  [machineIdOf('IFRS_Sec03_Arbiter')]: { id: machineIdOf('IFRS_Sec03_Arbiter'), metadata: { interconnections: [] } }
};

describe('successorOf', () => {
  it('follows the template’s own handoff for the frame’s asset type', () => {
    const t = TEMPLATES[machineIdOf('IFRS_Sec01_Verifier')];
    expect(machineIdOf('IFRS_Sec01_Verifier')).toBe('machine-ifrs-sec01-verifier');
    expect(successorOf(t, { assetType: 'COMPLIANCE-REVIEW' })).toBe('machine-ifrs-sec03-arbiter');
    expect(successorOf(t, { assetType: 'DISCLOSURE-CHECKLIST' })).toBe('machine-ifrs-sec09-checklist');
    expect(successorOf(t, { assetType: 'OTHER' })).toBeNull();
    expect(successorOf(t, {})).toBe('machine-ifrs-sec03-arbiter'); // first in declared order
  });
  it('is null for a template that hands off to nothing: the last step', () => {
    expect(successorOf(TEMPLATES[machineIdOf('IFRS_Sec03_Arbiter')], { assetType: 'COMPLIANCE-REVIEW' })).toBeNull();
    expect(successorOf({ id: 'machine-x' }, {})).toBeNull();
  });
});

// ── fakes ─────────────────────────────────────────────────────────────────────

interface FakeFrame extends FrameSummary { continuations: Continuation[]; observed: { approved: boolean }; returns: unknown[]; closed: boolean }

function world(opts: { maxActive?: number } = {}) {
  const calls: string[] = [];
  const frames = new Map<string, FakeFrame>();
  const lanes: { frameId: string; cloneId: string; engineId: string; generation: number }[] = [];
  let caps = 0;
  const issued = new Set<string>();
  const live = new Map<string, Clone>();
  let full = false;
  const generations: number[] = [];

  const lifecycle: Lifecycle & AgentLifecycle = {
    async openFrames() { return [...frames.values()].filter((f) => !f.closed).map((f) => ({ ...f, current: last(f.continuations)! })); },
    async liveLanes() { return lanes; },
    async resume(fid, kid, generation) {
      calls.push(`resume ${kid}`);
      const f = frames.get(fid)!; const c = last(f.continuations)!;
      if (c.continuationId !== kid || c.generation !== generation || c.status === 'resumed') return { status: 409, body: { outcome: 'refused' } };
      if (c.next.templateId === 'machine-gone') {
        c.status = 'superseded';
        f.continuations.push({ ...c, continuationId: `k${f.continuations.length}`, generation: generation + 1, status: 'captured', next: { engineId: 'cpp-1', templateId: 'machine-ifrs-sec01-verifier' } });
        return { status: 200, body: { outcome: 'escape', reason: 'engine cpp-1 does not carry machine-gone' } };
      }
      c.status = 'resumed'; issued.add(kid);
      caps += 1;
      return { status: 200, body: { outcome: 'resume', next: c.next, capability: `cap-${caps}`, continuation: { scopes: ['frame:read', 'frame:return', 'pod:read'] } } };
    },
    async capability(fid, kid) {
      calls.push(`capability ${kid}`);
      if (issued.has(kid)) return { status: 409, body: { capability: '', scopes: [] } };
      issued.add(kid); caps += 1;
      return { status: 200, body: { capability: `cap-${caps}`, scopes: ['frame:read', 'frame:return', 'pod:read'] } };
    },
    async lanes(fid, clone) { calls.push(`lanes ${clone.cloneId}`); lanes.push({ frameId: fid, cloneId: clone.cloneId, engineId: clone.engineInstance, generation: clone.generation }); return { status: 201, body: {} }; },
    async freeLanes(fid, cloneId, g) {
      calls.push(`free ${cloneId} g${g}`);
      const i = lanes.findIndex((l) => l.cloneId === cloneId); if (i >= 0) lanes.splice(i, 1);
      return { status: 200, body: {} };
    },
    async capture(fid, body: any) {
      const f = frames.get(fid)!; const c = last(f.continuations)!;
      calls.push(`capture ${body.next.templateId}${body.park ? ' parked' : ''}`);
      f.continuations.push({ continuationId: `k${f.continuations.length}`, status: body.park ? 'parked' : 'captured', generation: c.generation + 1,
        next: body.next, resumableBy: body.resumableBy ?? { role: 'engine' } });
      return { status: 201, body: {} };
    },
    async close(fid) { calls.push('close'); frames.get(fid)!.closed = true; return { status: 200, body: {} }; },
    async frame(fid) { const f = frames.get(fid)!; return { documents: [{ uri: 'https://pod/a.html', sha256: 'x', revision: 'r1' }], action: 'prepare', observed: f.observed }; },
    async readDocument() { return Buffer.from('doc'); },
    async writeReturn(fid, _cap, value) { frames.get(fid)!.returns.push(value); }
  };
  const engines: Engines = {
    async clone(engineId, templateId, asset, envelope) {
      const cloneId = `${templateId}.${engineId}.${envelope}`;
      const held = live.get(cloneId);
      if (held) return { status: 200, body: held };
      if (full || live.size >= (opts.maxActive ?? 8)) return { status: 409, body: { error: 'template is at clone.maxActive' } as never };
      const block = [...Array(1024).keys()].find((k) => ![...live.values()].some((c) => c.block.index === k))!;
      const c: Clone = { cloneId, machineId: templateId, engineInstance: engineId, envelopeId: envelope, assetId: asset, generation: generations[block] ?? 0,
        block: { index: block }, input: { offset: 20480 + 64 * block, length: 8 } };
      live.set(cloneId, c); calls.push(`clone ${cloneId}`);
      return { status: 201, body: c };
    },
    async recycle(_e, cloneId, g) {
      calls.push(`recycle ${cloneId} g${g}`);
      const c = live.get(cloneId)!; live.delete(cloneId); generations[c.block.index] = (generations[c.block.index] ?? 0) + 1;
      return { status: 200, body: {} };
    },
    async machine(_e, id) { return TEMPLATES[id] ?? { id, metadata: {} }; }
  };
  const add = (frameId: string, templateId = machineIdOf('IFRS_Sec01_Verifier')) => {
    const f: FakeFrame = { frameId, status: 'open', case: { delimiter: 'ifrs-approval-case', assetType: 'COMPLIANCE-REVIEW' }, current: undefined as never,
      continuations: [{ continuationId: 'k0', status: 'captured', generation: 1, next: { engineId: 'cpp-1', templateId }, resumableBy: { role: 'engine' } }],
      observed: { approved: false }, returns: [], closed: false };
    frames.set(frameId, f); return f;
  };
  const approve = (frameId: string) => {
    const f = frames.get(frameId)!; const c = last(f.continuations)!;
    c.status = 'resumed'; f.observed.approved = true;
  };
  const controller = new InstantiationController({ lifecycle, engines, agent: new SimulatedAgent(lifecycle) });
  return { calls, frames, lanes, live, controller, add, approve, setFull: (v: boolean) => { full = v; } };
}

describe('InstantiationController', () => {
  it('runs the IFRS chain: prepare → parked for review → approved step → last step closes the frame', async () => {
    const w = world();
    const f = w.add('frame-aaaaaaaa-1');
    await w.controller.tick();
    // Prepare: probe clone, resume, the same clone (same envelope), lanes, agent, epilogue.
    const env1 = envelopeOf(f.frameId, 1);
    const clone1 = `machine-ifrs-sec01-verifier.cpp-1.${env1}`;
    expect(w.calls).toEqual([
      `clone ${clone1}`, 'resume k0', `lanes ${clone1}`,
      `recycle ${clone1} g0`, `free ${clone1} g0`,
      'capture machine-ifrs-sec03-arbiter parked'
    ]);
    expect(f.returns).toHaveLength(1);
    expect((f.returns[0] as any).documents[0]).toMatchObject({ uri: 'https://pod/a.html', bytes: 3 });
    // Parked: nothing runs until a reviewer acts.
    w.calls.length = 0;
    await w.controller.tick();
    expect(w.calls).toEqual([]);
    // The reviewer approves (in the lifecycle). The approved step runs with the
    // capability the lifecycle issues for it, then the arbiter hands off to
    // nothing: termination closes the frame.
    w.approve(f.frameId);
    await w.controller.tick();
    const clone2 = `machine-ifrs-sec03-arbiter.cpp-1.${envelopeOf(f.frameId, 2)}`;
    expect(w.calls).toEqual([`clone ${clone2}`, 'capability k1', `lanes ${clone2}`, `recycle ${clone2} g1`, `free ${clone2} g1`, 'close']);
    expect(f.closed).toBe(true);
    expect(w.live.size).toBe(0);
    expect(w.lanes).toHaveLength(0);
    expect(w.controller.counts.done).toBe(2);
  });

  it('a full pool queues the step first in, first out, and spends no resume or capability', async () => {
    const w = world();
    const a = w.add('frame-aaaaaaaa-a');
    const b = w.add('frame-bbbbbbbb-b');
    w.setFull(true);
    await w.controller.tick();
    expect(w.controller.queued.map((j) => j.frameId)).toEqual([a.frameId, b.frameId]);
    expect(w.calls.filter((c) => c.startsWith('resume') || c.startsWith('capability'))).toEqual([]);
    expect(w.controller.counts.full).toBe(1);
    w.setFull(false);
    await w.controller.drain();
    expect(w.controller.queued).toHaveLength(0);
    const resumed = w.calls.filter((c) => c.startsWith('resume'));
    expect(resumed).toEqual(['resume k0', 'resume k0']);
    expect(w.calls.findIndex((c) => c.includes(a.frameId.slice(6, 14)))).toBeLessThan(w.calls.findIndex((c) => c.includes(b.frameId.slice(6, 14))));
  });

  it('a person-resumed step waiting on a full pool keeps its one-shot capability', async () => {
    const w = world();
    const f = w.add('frame-cccccccc-c');
    await w.controller.tick(); // runs prepare, parks
    w.approve(f.frameId);
    w.setFull(true);
    w.calls.length = 0;
    await w.controller.tick();
    expect(w.calls.filter((c) => c.startsWith('capability'))).toEqual([]);
    w.setFull(false);
    await w.controller.drain();
    expect(w.calls.filter((c) => c.startsWith('capability'))).toEqual(['capability k1']);
    expect(f.closed).toBe(true);
  });

  it('an escape is recorded and its probe clone recycled; the escape continuation runs next', async () => {
    const w = world();
    const f = w.add('frame-dddddddd-d', 'machine-gone');
    await w.controller.tick();
    expect(w.controller.history[0]).toMatchObject({ outcome: 'escaped', detail: 'engine cpp-1 does not carry machine-gone' });
    expect(w.live.size).toBe(0);
    await w.controller.tick();
    expect(last(f.continuations)?.status).toBe('parked');
  });

  it('reports pool use and queue depth for the dashboard', async () => {
    const w = world();
    w.add('frame-eeeeeeee-e');
    w.setFull(true);
    await w.controller.tick();
    const s = w.controller.status();
    expect(s.queue).toHaveLength(1);
    expect(s.counts.full).toBe(1);
  });
});
