// OpenClaw agents for workflow steps (localAssetStorageStack ROADMAP phase 8;
// localOpenClawStack#91). The driver that replaces the simulated agent and
// follows its pattern (agents.ts).
//
// - Per-clone agents (owner, 2026-11-04 and 2026-11-06): the step's agent is a
//   copy of the template machine's agent, loaded for the clone and unloaded
//   before it is recycled. localOpenClawStack's scripts/clone-agents.mjs makes
//   the change to openclaw.json; this component queues every load and unload
//   FIFO, one at a time, so two steps never interleave their edits.
// - Hooks: the prologue reads the frame and its documents with the step's
//   capability; the epilogue writes `return`. Both are this driver's, not the
//   agent's: the agent is given the documents in its turn and holds no
//   credential, so it cannot reach a document outside its frame, and it never
//   approves, records or publishes anything.
// - The unload removes the agent's config entry, waits until the gateway no
//   longer lists it, then removes its workspace and state.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import type { AxiosInstance } from 'axios';
import type { AgentDispatch, AgentDriver, AgentLifecycle, AgentResult } from './agents.js';

/** Runs queued actions one at a time, in arrival order. */
export class FifoQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** The openclaw.json side: load, unload (entry only) and purge one clone agent. */
export interface CloneAgents {
  load(templateId: string, cloneId: string): Promise<{ agentId: string; model: string }>;
  unload(cloneId: string): Promise<void>;
  purge(cloneId: string): Promise<void>;
}

/** The gateway: the agents it serves, and one turn with one of them. */
export interface Gateway {
  models(): Promise<string[]>;
  chat(model: string, messages: { role: 'system' | 'user'; content: string }[]): Promise<string>;
}

/** localOpenClawStack's scripts/clone-agents.mjs, every call through one FIFO queue. */
export function cliCloneAgents(cli: string, queue = new FifoQueue(), env: NodeJS.ProcessEnv = process.env): CloneAgents {
  const call = (args: string[]) => queue.run(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { env, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`clone-agents ${args[0]}: ${(stderr || err.message).trim()}`));
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop() || '{}')); } catch { reject(new Error(`clone-agents ${args[0]}: ${stdout}`)); }
    });
  }));
  return {
    async load(templateId, cloneId) {
      const r = await call(['load', '--template', templateId, '--clone', cloneId]);
      return { agentId: String(r.agentId), model: String(r.model) };
    },
    async unload(cloneId) { await call(['unload', '--clone', cloneId, '--entry-only']); },
    async purge(cloneId) { await call(['purge', '--clone', cloneId]); }
  };
}

export function httpGateway(url: string, token: string, client: AxiosInstance, timeoutMs = 300_000): Gateway {
  const auth = { headers: { authorization: `Bearer ${token}` } };
  return {
    async models() {
      const r = await client.get(new URL('/v1/models', url).href, { ...auth, timeout: 10_000, validateStatus: () => true });
      if (r.status !== 200) throw new Error(`gateway /v1/models: ${r.status}`);
      return ((r.data as { data?: { id: string }[] }).data || []).map((m) => m.id);
    },
    async chat(model, messages) {
      const r = await client.post(new URL('/v1/chat/completions', url).href, { model, messages },
        { ...auth, timeout: timeoutMs, validateStatus: () => true });
      if (r.status !== 200) throw new Error(`gateway chat ${model}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
      const content = (r.data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`gateway chat ${model}: no content`);
      return content;
    }
  };
}

const MAX_DOCUMENT_CHARS = 20_000;

/** The first JSON object in a model's answer, if any. */
export function firstJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(Boolean) as string[];
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* next */ } }
  return null;
}

export class OpenClawAgent implements AgentDriver {
  readonly name = 'openclaw';
  constructor(private readonly lifecycle: AgentLifecycle, private readonly agents: CloneAgents, private readonly gateway: Gateway,
    private readonly opts: { waitMs?: number; pollMs?: number } = {}) {}

  private async until(model: string, listed: boolean) {
    const deadline = Date.now() + (this.opts.waitMs ?? 15_000);
    for (;;) {
      if ((await this.gateway.models()).includes(model) === listed) return;
      if (Date.now() > deadline) throw new Error(`the gateway ${listed ? 'did not load' : 'still lists'} ${model}`);
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 100));
    }
  }

  async dispatch(d: AgentDispatch): Promise<AgentResult> {
    // ── prologue: the frame and its documents, with the step's capability ──
    const frame = await this.lifecycle.frame(d.frameId, d.capability);
    const documents: { uri: string; revision: string; sha256: string; matchesPin: boolean; bytes: number; text: string }[] = [];
    if (d.scopes.includes('pod:read')) {
      for (const doc of frame.documents) {
        const bytes = await this.lifecycle.readDocument(doc.uri, d.capability);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        documents.push({ uri: doc.uri, revision: doc.revision, sha256, matchesPin: sha256 === doc.sha256, bytes: bytes.length,
          text: bytes.toString('utf8').slice(0, MAX_DOCUMENT_CHARS) });
      }
    }

    // ── the clone's agent: loaded for this step, unloaded whatever happens ──
    const { agentId, model } = await this.agents.load(d.clone.templateId, d.clone.cloneId);
    let content: string;
    try {
      await this.until(model, true);
      content = await this.gateway.chat(model, [
        { role: 'system', content: [
          `You are the agent for one workflow step: template ${d.clone.templateId}, clone ${d.clone.cloneId}, continuation ${d.continuationId}.`,
          'Work only on the documents given below; you have no other access to them.',
          'You never approve, record or publish anything: the workflow and its reviewers decide that.',
          'Answer with one JSON object: {"summary": string, "findings": [string], "recommendation": string}.'
        ].join(' ') },
        { role: 'user', content: JSON.stringify({
          frame: d.frameId, action: frame.action ?? null,
          documents: documents.map(({ uri, revision, text }) => ({ uri, revision, text }))
        }) }
      ]);
    } finally {
      await this.agents.unload(d.clone.cloneId);
      await this.until(model, false).catch(() => undefined);
      await this.agents.purge(d.clone.cloneId);
    }

    // ── epilogue: the return ──
    const returned = {
      agent: this.name, agentId, model,
      template: d.clone.templateId, clone: d.clone.cloneId, continuation: d.continuationId,
      action: frame.action ?? null,
      documents: documents.map(({ text: _t, ...rest }) => rest),
      response: content,
      answer: firstJson(content)
    };
    await this.lifecycle.writeReturn(d.frameId, d.capability, returned);
    // The workflow's rule, as the simulated agent's: one independent review
    // before it continues. The agent's recommendation is recorded, not obeyed.
    return { requestReview: !frame.observed?.approved, returned };
  }
}
