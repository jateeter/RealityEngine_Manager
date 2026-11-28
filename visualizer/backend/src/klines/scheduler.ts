// K-line scheduling (RealityEngine_Manager#372; owner, 2026-11-27: schedules
// live in Manager's backend and survive a restart).
//
//   capture  turn capture on for the targets at a time or once a commit is
//            reached, and off again after a duration or a step count; repeat
//            if asked; archive the window when it closes if asked. Each window
//            records every target's RE commit at its start and end, which is
//            what a re-run reads.
//   rerun    recompute the analysis over records, never by driving an engine:
//            a capture window's commit ranges, or each target's latest N
//            commits; from the live store or the archive. One-shot or every N ms.
//
// State is one JSON file, rewritten atomically after every change. The tick is
// driven from outside (server.ts: a timer; tests: a fake clock).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

export type Targets = 'all' | string[];
export interface WindowCommits { [instance: string]: { start?: number; end?: number } }
export interface CaptureWindow { startedAt: number; endedAt?: number; commits: WindowCommits; archive?: unknown[]; errors: string[] }

export interface CaptureSchedule {
  id: string; kind: 'capture'; label?: string; targets: Targets;
  /** start: at a time (ms since epoch), or once the first target's RE commit reaches startCommit */
  startAt?: number; startCommit?: number;
  /** stop: after durationMs, or after steps commits on the first target; whichever comes first */
  durationMs?: number; steps?: number;
  repeatEveryMs?: number; archiveAtEnd: boolean;
  status: 'pending' | 'open' | 'done';
  windows: CaptureWindow[];
}
export interface RerunResult { at: number; windows: WindowCommits; perInstance: Record<string, unknown>; sideBySide?: unknown; errors: string[] }
export interface RerunSchedule {
  id: string; kind: 'rerun'; label?: string; targets: Targets; source: 'store' | 'archive';
  window: { captureId: string; index?: number } | { lastCommits: number };
  everyMs?: number; nextRunAt: number; status: 'pending' | 'done';
  results: RerunResult[];
}
export type Schedule = CaptureSchedule | RerunSchedule;

/** What the scheduler does to the world; the panel and archive in production. */
export interface Deps {
  instanceIds(): string[];
  setCapture(id: string, on: boolean): Promise<{ ok: boolean; errors: string[] }>;
  commitOf(id: string): Promise<number | null>;
  analyze(id: string, source: 'store' | 'archive', from: number, to: number): Promise<unknown>;
  compare(perInstance: Record<string, unknown>): unknown;
  archive(id: string): Promise<unknown[]>;
}

export const RESULTS_KEPT = 20;

export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KLINE_PANEL_STATE) return env.KLINE_PANEL_STATE;
  return join(env.RE_INSTANCE_STATE_DIR || join(homedir(), '.reality-engine'), 'manager', 'kline-panel.json');
}

export function validate(input: any): string | null {
  if (!input || (input.kind !== 'capture' && input.kind !== 'rerun')) return 'kind is capture or rerun';
  const t = input.targets;
  if (t !== 'all' && !(Array.isArray(t) && t.length && t.every((x: unknown) => typeof x === 'string'))) return 'targets is "all" or a list of instance ids';
  const pos = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
  if (input.kind === 'capture') {
    if (input.startAt === undefined && input.startCommit === undefined) return 'a capture window needs startAt or startCommit';
    if (input.durationMs === undefined && input.steps === undefined) return 'a capture window needs durationMs or steps';
    for (const k of ['startAt', 'startCommit', 'durationMs', 'steps', 'repeatEveryMs']) if (!pos(input[k])) return `${k} is a whole number`;
  } else {
    if (input.source !== 'store' && input.source !== 'archive') return 'source is store or archive';
    const w = input.window;
    if (!w || (typeof w.captureId !== 'string' && !(Number.isInteger(w.lastCommits) && w.lastCommits > 0))) {
      return 'window is {captureId} or {lastCommits: n}';
    }
    if (!pos(input.everyMs) || !pos(input.nextRunAt)) return 'everyMs and nextRunAt are whole numbers';
  }
  return null;
}

export class Scheduler {
  private schedules: Schedule[] = [];
  private running = false;

  constructor(private deps: Deps, private file: string | null, private now: () => number = () => Date.now()) {
    if (file && existsSync(file)) this.schedules = JSON.parse(readFileSync(file, 'utf8')).schedules ?? [];
  }

  list(): Schedule[] { return this.schedules; }
  get(id: string): Schedule | undefined { return this.schedules.find(s => s.id === id); }

  add(input: any): Schedule {
    const err = validate(input);
    if (err) throw new Error(err);
    const base = { id: randomUUID(), label: typeof input.label === 'string' ? input.label : undefined, targets: input.targets };
    const s: Schedule = input.kind === 'capture'
      ? { ...base, kind: 'capture', startAt: input.startAt, startCommit: input.startCommit, durationMs: input.durationMs,
          steps: input.steps, repeatEveryMs: input.repeatEveryMs, archiveAtEnd: input.archiveAtEnd === true,
          status: 'pending', windows: [] }
      : { ...base, kind: 'rerun', source: input.source, window: input.window, everyMs: input.everyMs,
          nextRunAt: input.nextRunAt ?? this.now(), status: 'pending', results: [] };
    this.schedules.push(s);
    this.save();
    return s;
  }

  /** Remove a schedule. An open capture window is closed first, so capture is never left on by a deleted schedule. */
  async remove(id: string): Promise<boolean> {
    const s = this.get(id);
    if (!s) return false;
    if (s.kind === 'capture' && s.status === 'open') await this.closeWindow(s);
    this.schedules = this.schedules.filter(x => x.id !== id);
    this.save();
    return true;
  }

  /** Run a re-run now, outside its schedule. */
  async runNow(id: string): Promise<RerunResult> {
    const s = this.get(id);
    if (!s || s.kind !== 'rerun') throw new Error(`no re-run ${id}`);
    const r = await this.rerun(s);
    this.save();
    return r;
  }

  /** One pass over every schedule. Not re-entrant: a slow pass is not overlapped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of [...this.schedules]) {
        if (s.kind === 'capture') await this.tickCapture(s);
        else if (s.status === 'pending' && this.now() >= s.nextRunAt) {
          await this.rerun(s);
          if (s.everyMs) s.nextRunAt = this.now() + s.everyMs;
          else s.status = 'done';
          this.save();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private targets(t: Targets): string[] {
    const known = this.deps.instanceIds();
    return t === 'all' ? known : t.filter(id => known.includes(id));
  }

  private async tickCapture(s: CaptureSchedule): Promise<void> {
    const ids = this.targets(s.targets);
    if (!ids.length) return;
    if (s.status === 'pending') {
      const due = s.startAt !== undefined ? this.now() >= s.startAt
        : ((await this.deps.commitOf(ids[0])) ?? -1) >= (s.startCommit ?? 0);
      if (due) await this.openWindow(s, ids);
    } else if (s.status === 'open') {
      const w = s.windows[s.windows.length - 1];
      const byTime = s.durationMs !== undefined && this.now() - w.startedAt >= s.durationMs;
      let bySteps = false;
      if (s.steps !== undefined) {
        const c = await this.deps.commitOf(ids[0]);
        const c0 = w.commits[ids[0]]?.start;
        bySteps = c !== null && c0 !== undefined && c - c0 >= s.steps;
      }
      if (byTime || bySteps) await this.closeWindow(s);
    }
  }

  private async openWindow(s: CaptureSchedule, ids: string[]): Promise<void> {
    const w: CaptureWindow = { startedAt: this.now(), commits: {}, errors: [] };
    for (const id of ids) {
      const r = await this.deps.setCapture(id, true);
      w.errors.push(...r.errors.map(e => `${id}: ${e}`));
      const c = await this.deps.commitOf(id);
      // Records close after the commit capture began at.
      w.commits[id] = { start: c === null ? undefined : c + 1 };
    }
    s.windows.push(w);
    s.status = 'open';
    this.save();
  }

  private async closeWindow(s: CaptureSchedule): Promise<void> {
    const w = s.windows[s.windows.length - 1];
    for (const id of Object.keys(w.commits)) {
      const r = await this.deps.setCapture(id, false);
      w.errors.push(...r.errors.map(e => `${id}: ${e}`));
      const c = await this.deps.commitOf(id);
      w.commits[id].end = c ?? undefined;
    }
    w.endedAt = this.now();
    if (s.archiveAtEnd) {
      w.archive = [];
      for (const id of Object.keys(w.commits)) {
        try { w.archive.push(...await this.deps.archive(id)); } catch (e: any) { w.errors.push(`${id}: archive: ${e?.message ?? e}`); }
      }
    }
    if (s.repeatEveryMs) {
      // The next window opens repeatEveryMs after this one opened. A window
      // first triggered by a commit repeats by time from then on.
      s.status = 'pending';
      s.startAt = w.startedAt + s.repeatEveryMs;
      s.startCommit = undefined;
    } else {
      s.status = 'done';
    }
    this.save();
  }

  private async rerun(s: RerunSchedule): Promise<RerunResult> {
    const result: RerunResult = { at: this.now(), windows: {}, perInstance: {}, errors: [] };
    let ids = this.targets(s.targets);
    let ranges: WindowCommits = {};
    if ('captureId' in s.window) {
      const cap = this.get(s.window.captureId);
      const w = cap?.kind === 'capture' ? cap.windows[s.window.index ?? cap.windows.length - 1] : undefined;
      if (!w) { result.errors.push(`capture ${s.window.captureId} has no window`); return this.keep(s, result); }
      ranges = w.commits;
      ids = ids.filter(id => id in ranges);
    } else {
      for (const id of ids) {
        const c = await this.deps.commitOf(id);
        if (c !== null) ranges[id] = { start: Math.max(0, c - s.window.lastCommits + 1), end: c };
      }
    }
    for (const id of ids) {
      const r = ranges[id];
      if (!r || r.start === undefined) { result.errors.push(`${id}: no commit range`); continue; }
      result.windows[id] = r;
      try {
        result.perInstance[id] = await this.deps.analyze(id, s.source, r.start, r.end ?? Number.MAX_SAFE_INTEGER);
      } catch (e: any) {
        result.errors.push(`${id}: ${e?.message ?? e}`);
      }
    }
    result.sideBySide = this.deps.compare(result.perInstance);
    return this.keep(s, result);
  }

  private keep(s: RerunSchedule, r: RerunResult): RerunResult {
    s.results = [...s.results, r].slice(-RESULTS_KEPT);
    return r;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schedules: this.schedules }, null, 2));
    renameSync(tmp, this.file);
  }
}
