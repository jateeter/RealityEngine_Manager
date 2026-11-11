import { describe, expect, it } from 'vitest';
import type { AgentDispatch, AgentLifecycle } from '../instantiation/agents.js';
import { FifoQueue, OpenClawAgent, firstJson, type CloneAgents, type Gateway } from '../instantiation/openclaw.js';

const CAPABILITY = 'eyJhbGciOiJFZERTQSJ9.capability-for-frame-1.sig';
const dispatchOf = (over: Partial<AgentDispatch> = {}): AgentDispatch => ({
  frameId: 'frame-1', continuationId: 'k0', capability: CAPABILITY, scopes: ['frame:read', 'frame:return', 'pod:read'],
  clone: { cloneId: 'machine-t1.cpp-1.env-1', engineId: 'cpp-1', templateId: 'machine-t1', envelopeId: 'env-1' }, ...over
});

function world({ approved = false, chatFails = false } = {}) {
  const ops: string[] = [];
  const listed = new Set<string>();
  const seen: string[] = [];
  let written: unknown = null;
  const lifecycle: AgentLifecycle = {
    async frame(id, cap) { ops.push(`frame ${id}`); expect(cap).toBe(CAPABILITY); return { documents: [{ uri: 'https://pod/a.html', sha256: 'x', revision: 'r1' }], action: 'prepare', observed: { approved } }; },
    async readDocument(uri) { ops.push(`read ${uri}`); return Buffer.from('<p>Going concern: Q1–Q3.</p>'); },
    async writeReturn(id, cap, value) { ops.push('return'); expect(cap).toBe(CAPABILITY); written = value; }
  };
  const agents: CloneAgents = {
    async load(t, c) { ops.push(`load ${t} ${c}`); listed.add('openclaw/clone-abc'); return { agentId: 'clone-abc', model: 'openclaw/clone-abc' }; },
    async unload(c) { ops.push(`unload ${c}`); listed.delete('openclaw/clone-abc'); },
    async purge(c) { ops.push(`purge ${c}`); }
  };
  const gateway: Gateway = {
    async models() { return ['openclaw/main', ...listed]; },
    async chat(model, messages) {
      ops.push(`chat ${model}`);
      seen.push(JSON.stringify(messages));
      if (chatFails) throw new Error('gateway chat: 500');
      return 'Here is my answer:\n```json\n{"summary":"Q4 missing","findings":["no Q4"],"recommendation":"rework"}\n```';
    }
  };
  return { ops, seen, lifecycle, agents, gateway, written: () => written };
}

describe('FifoQueue', () => {
  it('runs queued actions one at a time, in arrival order', async () => {
    const q = new FifoQueue();
    const log: string[] = [];
    let active = 0;
    const job = (n: number, ms: number) => q.run(async () => {
      active += 1; expect(active).toBe(1);
      log.push(`start ${n}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${n}`);
      active -= 1; return n;
    });
    const failing = q.run(async () => { throw new Error('boom'); });
    expect(await Promise.all([job(1, 15), job(2, 1), job(3, 5)])).toEqual([1, 2, 3]);
    await expect(failing).rejects.toThrow('boom');
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });
});

describe('OpenClawAgent', () => {
  it('reads the frame, runs the clone agent, unloads it, then writes the return; the agent never sees the capability', async () => {
    const w = world();
    const agent = new OpenClawAgent(w.lifecycle, w.agents, w.gateway, { pollMs: 1 });
    const r = await agent.dispatch(dispatchOf());
    expect(w.ops).toEqual(['frame frame-1', 'read https://pod/a.html', 'load machine-t1 machine-t1.cpp-1.env-1',
      'chat openclaw/clone-abc', 'unload machine-t1.cpp-1.env-1', 'purge machine-t1.cpp-1.env-1', 'return']);
    expect(w.seen.join('')).not.toContain(CAPABILITY);
    expect(w.seen.join('')).toContain('Going concern: Q1–Q3.');
    const returned = w.written() as Record<string, unknown>;
    expect(returned).toMatchObject({ agent: 'openclaw', agentId: 'clone-abc', template: 'machine-t1', clone: 'machine-t1.cpp-1.env-1',
      answer: { summary: 'Q4 missing', findings: ['no Q4'], recommendation: 'rework' } });
    expect(JSON.stringify(returned)).not.toContain('Going concern'); // the documents' text stays out of the return
    expect(r.requestReview).toBe(true);
  });

  it('asks for no second review once the frame was approved, whatever the agent recommends', async () => {
    const w = world({ approved: true });
    expect((await new OpenClawAgent(w.lifecycle, w.agents, w.gateway, { pollMs: 1 }).dispatch(dispatchOf())).requestReview).toBe(false);
  });

  it('unloads and purges the agent when its turn fails, and writes no return', async () => {
    const w = world({ chatFails: true });
    await expect(new OpenClawAgent(w.lifecycle, w.agents, w.gateway, { pollMs: 1 }).dispatch(dispatchOf())).rejects.toThrow('500');
    expect(w.ops.slice(-2)).toEqual(['unload machine-t1.cpp-1.env-1', 'purge machine-t1.cpp-1.env-1']);
    expect(w.ops).not.toContain('return');
  });

  it('reads no document without pod:read', async () => {
    const w = world();
    await new OpenClawAgent(w.lifecycle, w.agents, w.gateway, { pollMs: 1 }).dispatch(dispatchOf({ scopes: ['frame:read', 'frame:return'] }));
    expect(w.ops.some((o) => o.startsWith('read '))).toBe(false);
  });
});

describe('firstJson', () => {
  it('finds the object in a fenced block or in prose, and null when there is none', () => {
    expect(firstJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(firstJson('Sure. {"a":2} Done.')).toEqual({ a: 2 });
    expect(firstJson('no json here')).toBeNull();
  });
});

describe('instantiationConfig: the OpenClaw gateway', () => {
  it('uses its own names first, and the ACP gateway URL in its http(s) form as the fallback', async () => {
    const { instantiationConfig } = await import('../instantiation/http.js');
    expect(instantiationConfig({ INSTANTIATION_OPENCLAW_URL: 'http://127.0.0.1:18899', OPENCLAW_GATEWAY_URL: 'wss://127.0.0.1:18789', INSTANTIATION_OPENCLAW_TOKEN: 't1', OPENCLAW_GATEWAY_TOKEN: 't2' }).openclaw)
      .toMatchObject({ gatewayUrl: 'http://127.0.0.1:18899', token: 't1' });
    expect(instantiationConfig({ OPENCLAW_GATEWAY_URL: 'wss://127.0.0.1:18789', OPENCLAW_GATEWAY_TOKEN: 't2' }).openclaw)
      .toMatchObject({ gatewayUrl: 'https://127.0.0.1:18789', token: 't2' });
  });
});
