// Manager's workflow instantiation component (localAssetStorageStack ROADMAP
// phase 9, RealityEngine_Manager#323; RealityEngine_CI
// docs/CONTINUATIONS_APPROVAL_CHAIN.md, "How a step runs").
//
// It runs every workflow step as a clone of a template machine:
// - prologue: resume the frame's current continuation (the lifecycle checks
//   the generation, the pin and that the engine still carries the template),
//   clone `next` on its engine instance for this assetID, hand the clone to
//   the lifecycle (which allocates the frame's lanes in its reserved cells),
//   and dispatch the step's agent;
// - epilogue: name the successor from the template's handoff interconnections
//   (successor.ts), recycle the clone with its generation and free its lanes,
//   then capture the successor, park it for a reviewer when the agent asks
//   for review, or close the frame when there is none (termination closes the
//   workflow head, D11).
//
// A step that a person resumed (a reviewer's approve) is picked up the same
// way and runs with the capability the lifecycle issues for it. A full pool
// (clone.maxActive, or no free block) queues the step, first in, first out. It
// works from the lifecycle's open frames, so a restart picks up where the
// frames stand. It never requires another engine to agree: parity is a
// regression result.
import type { AgentDriver, AgentResult } from './agents.js';
import { successorOf, type FrameCase, type TemplateMachine } from './successor.js';

export interface Continuation {
  continuationId: string;
  status: string;
  generation: number;
  next: { engineId: string; templateId: string };
  resumableBy: { role: string };
}
export interface FrameSummary { frameId: string; status: string; case: FrameCase; current: Continuation }
export interface Clone {
  cloneId: string; machineId: string; engineInstance: string; envelopeId: string; assetId: string;
  generation: number; block: { index: number }; input: { offset: number; length: number };
}
export interface Reply<T = unknown> { status: number; body: T }

export interface Lifecycle {
  openFrames(): Promise<FrameSummary[]>;
  liveLanes(): Promise<{ frameId: string; cloneId: string; engineId: string; generation: number }[]>;
  resume(frameId: string, kid: string, generation: number): Promise<Reply<{ outcome: string; capability?: string; next?: Continuation['next']; reason?: string; continuation?: { scopes?: string[] } }>>;
  capability(frameId: string, kid: string): Promise<Reply<{ capability: string; scopes: string[] }>>;
  lanes(frameId: string, clone: Clone): Promise<Reply>;
  freeLanes(frameId: string, cloneId: string, generation: number): Promise<Reply>;
  capture(frameId: string, body: object): Promise<Reply>;
  close(frameId: string): Promise<Reply>;
}
export interface Engines {
  clone(engineId: string, templateId: string, asset: string, envelope: string): Promise<Reply<Clone & { error?: string }>>;
  recycle(engineId: string, cloneId: string, generation: number): Promise<Reply>;
  machine(engineId: string, machineId: string): Promise<TemplateMachine>;
}

type Kind = 'resume' | 'dispatch';
interface Job { frameId: string; kind: Kind; continuationId: string; queuedAt: number }
export type StepOutcome = 'done' | 'escaped' | 'full' | 'failed';
export interface StepRecord { frameId: string; continuationId: string; outcome: StepOutcome; detail: string; at: number }

/** The envelope a step's clone takes: one per frame and continuation generation, so a retried dispatch reuses its clone. */
export const envelopeOf = (frameId: string, generation: number): string =>
  `env-${frameId.replace(/^frame-/, '').slice(0, 8)}-g${generation}`;

export class InstantiationController {
  private readonly queue: Job[] = [];
  private readonly running = new Set<string>();
  readonly live = new Map<string, { frameId: string; engineId: string; templateId: string; generation: number; since: number }>();
  readonly history: StepRecord[] = [];
  readonly counts: Record<StepOutcome, number> = { done: 0, escaped: 0, full: 0, failed: 0 };
  private draining = false;

  constructor(private readonly deps: { lifecycle: Lifecycle; engines: Engines; agent: AgentDriver; now?: () => number; historyLimit?: number }) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  get queued(): readonly Job[] { return this.queue; }

  private record(r: Omit<StepRecord, 'at'>): void {
    this.counts[r.outcome] += 1;
    this.history.push({ ...r, at: this.now() });
    const limit = this.deps.historyLimit ?? 200;
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
  }

  /** Finds the steps the open frames are waiting on, queues them, and runs the queue. */
  async tick(): Promise<void> {
    const frames = await this.deps.lifecycle.openFrames();
    const lanes = await this.deps.lifecycle.liveLanes();
    for (const f of frames) {
      const c = f.current;
      if (!c || this.running.has(f.frameId) || this.queue.some((j) => j.frameId === f.frameId)) continue;
      // Waiting for the engine side to run it.
      if (c.status === 'captured' && c.resumableBy.role === 'engine') this.enqueue(f.frameId, 'resume', c.continuationId);
      // Resumed by a person, and no clone holds it yet.
      else if (c.status === 'resumed' && c.resumableBy.role !== 'engine' && !lanes.some((l) => l.frameId === f.frameId)) {
        this.enqueue(f.frameId, 'dispatch', c.continuationId);
      }
    }
    await this.drain();
  }

  private enqueue(frameId: string, kind: Kind, continuationId: string): void {
    this.queue.push({ frameId, kind, continuationId, queuedAt: this.now() });
  }

  /** Runs queued steps in order. A full pool stops the queue at its head: first in, first out. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        this.running.add(job.frameId);
        let outcome: StepOutcome;
        try { outcome = await this.step(job); }
        catch (e) {
          outcome = 'failed';
          this.record({ frameId: job.frameId, continuationId: job.continuationId, outcome, detail: (e as Error).message });
        } finally { this.running.delete(job.frameId); }
        if (outcome === 'full') break;
        this.queue.shift();
      }
    } finally { this.draining = false; }
  }

  private async step(job: Job): Promise<StepOutcome> {
    const { lifecycle, engines, agent } = this.deps;
    const frames = await lifecycle.openFrames();
    const f = frames.find((x) => x.frameId === job.frameId);
    if (!f || f.current.continuationId !== job.continuationId) {
      this.record({ frameId: job.frameId, continuationId: job.continuationId, outcome: 'escaped', detail: 'the frame moved on before its step ran' });
      return 'escaped';
    }
    const c = f.current;
    let capability: string;
    let scopes: string[];
    let next = c.next;

    // ── prologue ──
    if (job.kind === 'resume') {
      // A full pool is found before the resume: a resume is one-shot, and a
      // resumed step must have its clone.
      const probe = await this.cloneFor(f, next, c.generation, true);
      if (probe === 'full') return this.full(job);
      const r = await lifecycle.resume(f.frameId, c.continuationId, c.generation);
      if (r.status !== 200) throw new Error(`resume ${c.continuationId}: ${r.status} ${JSON.stringify(r.body)}`);
      if (r.body.outcome !== 'resume') {
        this.record({ frameId: f.frameId, continuationId: c.continuationId, outcome: 'escaped', detail: r.body.reason ?? 'escape' });
        if (probe) await this.release(f.frameId, probe, false);
        return 'escaped';
      }
      capability = r.body.capability!;
      scopes = r.body.continuation?.scopes ?? [];
      next = r.body.next ?? next;
    } else {
      // The clone first: the step capability is one-shot, and a full pool must
      // not spend it.
      const held = await this.cloneFor(f, next, c.generation, false);
      if (held === 'full') return this.full(job);
      const r = await lifecycle.capability(f.frameId, c.continuationId);
      if (r.status !== 200) {
        await this.release(f.frameId, held!, false);
        throw new Error(`step capability ${c.continuationId}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      capability = r.body.capability;
      scopes = r.body.scopes;
    }
    // Retried with the same envelope: the clone the probe (or the line above)
    // made, answered 200.
    const clone = await this.cloneFor(f, next, c.generation, false);
    if (clone === 'full') return this.full(job);
    const lanes = await lifecycle.lanes(f.frameId, clone!);
    if (lanes.status !== 201) {
      await this.release(f.frameId, clone!, false);
      throw new Error(`lanes for ${clone!.cloneId}: ${lanes.status} ${JSON.stringify(lanes.body)}`);
    }

    // ── the step ──
    let result: AgentResult;
    try {
      result = await agent.dispatch({ frameId: f.frameId, continuationId: c.continuationId, capability, scopes,
        clone: { cloneId: clone!.cloneId, engineId: next.engineId, templateId: next.templateId, envelopeId: clone!.envelopeId } });
    } catch (e) {
      await this.release(f.frameId, clone!, true);
      throw new Error(`agent ${agent.name}: ${(e as Error).message}`);
    }

    // ── epilogue ──
    const template = await engines.machine(next.engineId, next.templateId);
    const successor = successorOf(template, f.case);
    await this.release(f.frameId, clone!, true);
    if (successor === null) {
      const closed = await lifecycle.close(f.frameId);
      if (closed.status !== 200) throw new Error(`close: ${closed.status} ${JSON.stringify(closed.body)}`);
      this.record({ frameId: f.frameId, continuationId: c.continuationId, outcome: 'done', detail: `${next.templateId}: last step; frame closed` });
      return 'done';
    }
    const following = { engineId: next.engineId, templateId: successor };
    const body = result.requestReview
      ? { next: following, resumableBy: { role: 'reviewer' }, park: true }
      : { next: following };
    const captured = await lifecycle.capture(f.frameId, body);
    if (captured.status !== 201 && captured.status !== 200) throw new Error(`capture: ${captured.status} ${JSON.stringify(captured.body)}`);
    this.record({ frameId: f.frameId, continuationId: c.continuationId, outcome: 'done',
      detail: `${next.templateId} → ${successor}${result.requestReview ? ' (parked for review)' : ''}` });
    return 'done';
  }

  /** Clones `next` for the frame's step: the clone, or 'full'. A dry run recycles nothing and only probes. */
  private async cloneFor(f: FrameSummary, next: Continuation['next'], generation: number, probe: boolean): Promise<Clone | 'full' | null> {
    const envelope = envelopeOf(f.frameId, generation);
    const r = await this.deps.engines.clone(next.engineId, next.templateId, f.frameId, envelope);
    if (r.status === 409 && /maxActive|no free block/.test(r.body.error ?? '')) return 'full';
    if (r.status !== 201 && r.status !== 200) {
      if (probe) return null; // the resume will say why (rule 7 takes the escape path)
      throw new Error(`clone ${next.templateId} on ${next.engineId}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    this.live.set(r.body.cloneId, { frameId: f.frameId, engineId: next.engineId, templateId: next.templateId, generation: r.body.generation, since: this.now() });
    return r.body;
  }

  private async release(frameId: string, clone: Clone, lanes: boolean): Promise<void> {
    await this.deps.engines.recycle(clone.engineInstance, clone.cloneId, clone.generation);
    if (lanes) await this.deps.lifecycle.freeLanes(frameId, clone.cloneId, clone.generation);
    this.live.delete(clone.cloneId);
  }

  private full(_job: Job): StepOutcome {
    this.counts.full += 1;
    return 'full';
  }

  /** For the dashboard (RealityEngine_CI#723): live clones by engine and template, and the queue. */
  status() {
    const byEngine: Record<string, number> = {};
    const byTemplate: Record<string, number> = {};
    for (const c of this.live.values()) {
      byEngine[c.engineId] = (byEngine[c.engineId] ?? 0) + 1;
      byTemplate[`${c.engineId}|${c.templateId}`] = (byTemplate[`${c.engineId}|${c.templateId}`] ?? 0) + 1;
    }
    return { queue: this.queue.map((j) => ({ ...j })), running: [...this.running], live: [...this.live.entries()].map(([cloneId, v]) => ({ cloneId, ...v })),
      liveByEngine: byEngine, liveByTemplate: byTemplate, counts: { ...this.counts }, history: this.history.slice(-50) };
  }
}
