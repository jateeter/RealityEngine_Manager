import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeCompositions, analyzeKlines, canonical, nearMissBin, sideBySide } from '../klines/analysis.js';
import { archiveOne, archivedRecords, cursor, readCatalog, verifyBundle } from '../klines/archive.js';
import { instanceStatus, setCapture, setKnob, validKnob, type Http, type Instance } from '../klines/panel.js';
import { Scheduler, validate, type Deps } from '../klines/scheduler.js';

// A stub engine pair that serves the K-line surfaces the way the voters do.
class Engine {
  capture = false; isre = false; hops = 3; reBytes = 2147483648; peBytes = 2147483648;
  taxonomy: string | null = 're-source-kinds/2';
  klines: any[] = []; comps: any[] = []; commit = 0;
  constructor(public reUuid: string, public peUuid: string, public supportsKlines = true, public hasPe = true) {}
  add(c: number, outcome = 'completed', extra: any = {}) {
    this.commit = c;
    this.klines.push({ format: 're-kline/1', id: `${this.reUuid}:${c}`, focal: { machine: 'M', sequence: 's' },
      open: { step: c - 1 }, close: { step: c, commit: c }, outcome, path: [{ event: 'e1', step: c - 1 }, { event: 'e2', step: c }], ...extra });
    this.comps.push({ format: 're-isre-composition/1', taxonomy: 're-source-kinds/2', re: { commit: c, step: c },
      sources: [{ cells: [10, 13], kind: 'test', class: 'deterministic', causedBy: null }] });
  }
  bundle(fmt: string, source: string, rows: any[]) {
    const body = rows.map(r => JSON.stringify(r) + '\n').join('');
    return JSON.stringify({ format: fmt, source: { instance: source }, count: rows.length,
      sha256: createHash('sha256').update(body).digest('hex') }) + '\n' + body;
  }
  http(): Http {
    const ok = (data: any) => ({ status: 200, data });
    return {
      get: async url => {
        const path = url.replace(/^https:\/\/(re|pe)\.invalid/, '');
        const q = new URL(url).searchParams;
        if (url.startsWith('https://re.invalid')) {
          if (path === '/api/engine/config') return ok({ controls: [
            ...(this.supportsKlines ? [{ name: 'klineCapture', value: this.capture }, { name: 'klineFeedbackHops', value: this.hops },
              { name: 'klineStoreMaxBytes', value: this.reBytes }] : []), { name: 'historyLimit', value: 250 }] });
          if (!this.supportsKlines) return { status: 404, data: { error: 'Not found' } };
          if (path === '/api/klines/stats') return ok({ segments: 1, bytes: 10, budget: this.reBytes, warnings: [], byOutcome: {} });
          if (path === '/api/klines/open') return ok({ commit: this.commit, open: [{}, {}] });
          if (path === '/api/engine/clock') return ok({ instance: this.reUuid, commit: this.commit });
          if (path.startsWith('/api/klines?')) {
            const since = Number(q.get('since'));
            return ok({ klines: this.klines.filter(k => k.close.commit >= since), next: null });
          }
        } else if (this.hasPe) {
          if (path === '/api/isre-composition/stats') return ok({ isreCapture: this.isre, taxonomy: this.taxonomy, budget: this.peBytes, segments: 1, bytes: 5, warnings: [], records: this.comps.length });
          if (path === '/api/clock') return ok({ instance: this.peUuid });
          if (path.startsWith('/api/isre-composition?')) {
            const from = Number(q.get('from')), to = Number(q.get('to') ?? Infinity);
            return ok({ records: this.comps.filter(r => r.re.commit >= from && r.re.commit <= to), next: null });
          }
        }
        return { status: 404, data: { error: 'Not found' } };
      },
      put: async (url, body: any) => {
        if (url.endsWith('/klineCapture')) { this.capture = body.value; return ok({}); }
        if (url.endsWith('/klineFeedbackHops')) { if (body.value > 16) return { status: 400, data: { error: 'range' } }; this.hops = body.value; return ok({}); }
        if (url.endsWith('/klineStoreMaxBytes')) { this.reBytes = body.value; return ok({}); }
        return { status: 404, data: {} };
      },
      patch: async (_url, body: any) => {
        if (body.isreCapture === true && !this.taxonomy) return { status: 409, data: { error: 'isreCapture requires re-source-kinds/2 in the corpus' } };
        if ('isreCapture' in body) this.isre = body.isreCapture;
        if ('isreStoreMaxBytes' in body) this.peBytes = body.isreStoreMaxBytes;
        return ok({ success: true });
      },
      delete: async url => {
        if (url.endsWith('/klineFeedbackHops')) this.hops = 3;
        if (url.endsWith('/klineStoreMaxBytes')) this.reBytes = 2147483648;
        return ok({});
      },
      postText: async (url, body: any) => {
        if (url.endsWith('/api/klines/export')) return { status: 200, text: this.bundle('re-kline-bundle/1', this.reUuid, this.klines.filter(k => k.close.commit >= body.since)) };
        if (url.endsWith('/api/isre-composition/export')) return { status: 200, text: this.bundle('re-isre-bundle/1', this.peUuid, this.comps.filter(r => r.re.commit >= body.from)) };
        return { status: 404, text: '' };
      },
    };
  }
}
const inst = (id = 'cpp-1', runtime = 'cpp', extra: Partial<Instance> = {}): Instance =>
  ({ id, runtime, re_url: 'https://re.invalid', pe_url: 'https://pe.invalid', status: 'running', ...extra });
const RE = '01a2aaaa-0000-7000-8000-00000000b001', PE = '01a2aaaa-0000-7000-8000-00000000b002';

describe('the panel: both halves through the engines\' own controls', () => {
  it('reads both halves, and a voter from a follower', async () => {
    const e = new Engine(RE, PE);
    const s = await instanceStatus(e.http(), inst());
    expect(s.role).toBe('voter');
    expect(s.re).toMatchObject({ supported: true, capture: false, feedbackHops: 3, open: 2 });
    expect(s.pe).toMatchObject({ supported: true, capture: false, taxonomy: 're-source-kinds/2' });
    expect((await instanceStatus(e.http(), inst('rust-1', 'rust', { role: 'follower' }))).role).toBe('follower');
  });

  it('marks a half that does not capture unsupported, never off', async () => {
    const e = new Engine(RE, PE, false, false);
    const s = await instanceStatus(e.http(), inst('go-1', 'go', { role: 'follower' }));
    expect(s.re.supported).toBe(false);
    expect(s.pe.supported).toBe(false);
    expect(s.re.capture).toBeUndefined();
  });

  it('turns both halves on and off together, and reads them back', async () => {
    const e = new Engine(RE, PE);
    const on = await setCapture(e.http(), inst(), true);
    expect(on.ok).toBe(true);
    expect([e.capture, e.isre]).toEqual([true, true]);
    expect(on.status.re.capture && on.status.pe.capture).toBe(true);
    await setCapture(e.http(), inst(), false);
    expect([e.capture, e.isre]).toEqual([false, false]);
  });

  it('reports a refusal rather than hiding it', async () => {
    const e = new Engine(RE, PE);
    e.taxonomy = null;
    const r = await setCapture(e.http(), inst(), true);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/PE isreCapture 409/);
    expect(e.capture).toBe(true); // the RE half took it; the panel says the PE did not
  });

  it('validates knobs as the engines do, sets them, and restores defaults', async () => {
    expect(validKnob('klineFeedbackHops', 17)).toMatch(/\[0, 16\]/);
    expect(validKnob('klineFeedbackHops', 1.5)).toMatch(/whole number/);
    expect(validKnob('nope', 1)).toMatch(/unknown knob/);
    const e = new Engine(RE, PE);
    expect((await setKnob(e.http(), inst(), 'klineFeedbackHops', 5)).ok).toBe(true);
    expect(e.hops).toBe(5);
    expect((await setKnob(e.http(), inst(), 'isreStoreMaxBytes', 1000)).ok).toBe(true);
    expect(e.peBytes).toBe(1000);
    await setKnob(e.http(), inst(), 'klineFeedbackHops', null);
    await setKnob(e.http(), inst(), 'isreStoreMaxBytes', null);
    expect([e.hops, e.peBytes]).toEqual([3, 2147483648]);
  });
});

describe('analysis: computed over records, never by driving an engine', () => {
  const ks = [
    { format: 're-kline/1', focal: { machine: 'A', sequence: 'x' }, close: { step: 1, commit: 5 }, outcome: 'completed', path: [1, 2] },
    { format: 're-kline/1', focal: { machine: 'A', sequence: 'x' }, close: { step: 1, commit: 5 }, outcome: 'abandoned', path: [1],
      difference: { value: 0.2, threshold: 0.5 } },
    { format: 're-kline/1', focal: { machine: 'B', sequence: 'y' }, close: { step: 2, commit: 6 }, outcome: 'interrupted', reason: 'reset', path: [1] },
    { format: 're-kline-event/1' },
  ];
  it('counts outcomes, paths, closes per step and near-misses', () => {
    const a = analyzeKlines(ks);
    expect(a.klines).toBe(3);
    expect(a.byOutcome).toEqual({ completed: 1, abandoned: 1, 'interrupted/reset': 1 });
    expect(a.byMachine.A).toEqual({ completed: 1, abandoned: 1 });
    expect(a.closedPerStep).toEqual({ 1: 2, 2: 1 });
    expect(a.pathLengths).toEqual({ 1: 2, 2: 1 });
    expect(a.nearMiss).toEqual({ '0.3-0.4': 1 });
    expect(a.commits).toEqual([5, 6]);
    expect(nearMissBin({ value: 3, threshold: 0.5 })).toBe('1.0+');
    expect(nearMissBin({ value: 1, threshold: null })).toBeNull();
  });
  it('sums cells won per kind/provider/class', () => {
    const c = analyzeCompositions([{ format: 're-isre-composition/1', taxonomy: 're-source-kinds/2', re: { commit: 3 },
      sources: [{ cells: [0, 3], kind: 'sensor', provider: 'healthkit', class: 'measured', causedBy: { instance: 'i', lamport: 1 } },
                { cells: [4, 4], kind: 'feedback', class: 'deterministic', causedBy: null }] }]);
    expect(c.cellsByEntry).toEqual({ 'sensor/healthkit/measured': 4, 'feedback/deterministic': 1 });
    expect(c.causedByRecords).toBe(1);
  });
  it('puts voters side by side with no reference, and names a voter that did not answer', () => {
    const a = analyzeKlines(ks), b = analyzeKlines(ks);
    const c = analyzeKlines(ks.slice(0, 2));
    expect(sideBySide({ cpp: a, lsp: b, scala: a }).differ).toEqual([]);
    const split = sideBySide({ cpp: a, lsp: b, scala: c });
    expect(split.differ).toContain('byOutcome');
    expect(split.differ).toContain('byMachine'); // nested counts are compared, not dropped
    const gone = sideBySide({ cpp: a, lsp: b, scala: null });
    expect(gone.missing).toEqual(['scala']);
    expect(gone.agree).toEqual([]);
    expect(canonical({ b: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"b":{"x":2,"y":1}}');
  });
});

describe('the archive: CI\'s contract, written by Manager', () => {
  it('archives incrementally, read-only, verified, and reads back by commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kline-archive-'));
    const e = new Engine(RE, PE);
    [1, 2, 3].forEach(c => e.add(c));
    const entries = readCatalog(root);
    const r1 = await archiveOne(e.http(), root, entries, inst(), 'klines');
    expect(r1).toMatchObject({ result: 'archived', commits: [1, 3], records: 3 });
    expect(statSync(join(root, r1.file!)).mode & 0o222).toBe(0);
    expect((await archiveOne(e.http(), root, entries, inst(), 'klines')).result).toBe('nothing new');
    e.add(4);
    expect((await archiveOne(e.http(), root, entries, inst(), 'klines')).commits).toEqual([4, 4]);
    expect(cursor(readCatalog(root), RE, 'klines')).toBe(5);
    await archiveOne(e.http(), root, entries, inst(), 'isre');
    expect(archivedRecords(root, RE, 'klines', 2, 3).map(k => k.close.commit)).toEqual([2, 3]);
    expect(archivedRecords(root, PE, 'isre').length).toBe(4);
    // One catalog line per bundle, keys sorted, as CI's kline_archive.py writes it.
    const line = readFileSync(join(root, 'catalog.jsonl'), 'utf8').split('\n')[0];
    expect(line).toBe(canonical(JSON.parse(line)));
  });
  it('refuses a bundle whose body does not match its sha256, and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kline-archive-'));
    const e = new Engine(RE, PE);
    e.add(1);
    const h = e.http();
    const bad: Http = { ...h, postText: async (u, b) => { const r = await h.postText(u, b); return { ...r, text: r.text.replace('completed', 'abandoned') }; } };
    await expect(archiveOne(bad, root, [], inst(), 'klines')).rejects.toThrow(/sha256/);
    expect(readCatalog(root)).toEqual([]);
    expect(() => verifyBundle('{"format":"re-kline-bundle/1"}', 're-kline-bundle/1')).toThrow();
  });
});

describe('the scheduler: capture windows and re-runs that survive a restart', () => {
  const setup = () => {
    let now = 1_000_000;
    const commits: Record<string, number> = { 'cpp-1': 10, 'lsp-1': 20 };
    const calls: string[] = [];
    const deps: Deps = {
      instanceIds: () => ['cpp-1', 'lsp-1'],
      setCapture: async (id, on) => { calls.push(`${id}:${on ? 'on' : 'off'}`); return { ok: true, errors: [] }; },
      commitOf: async id => commits[id],
      analyze: async (id, source, from, to) => ({ id, source, from, to }),
      compare: per => ({ compared: Object.keys(per) }),
      archive: async id => [{ id, result: 'archived' }],
    };
    const file = join(mkdtempSync(join(tmpdir(), 'kline-panel-')), 'state.json');
    return { deps, file, calls, commits, clock: () => now, advance: (ms: number) => { now += ms; } };
  };

  it('opens a window at its time, closes it after its duration, records commits and archives', async () => {
    const t = setup();
    const s = new Scheduler(t.deps, t.file, t.clock);
    const cap = s.add({ kind: 'capture', targets: 'all', startAt: 1_000_500, durationMs: 60_000, archiveAtEnd: true });
    await s.tick();
    expect(t.calls).toEqual([]);
    t.advance(600); await s.tick();
    expect(t.calls).toEqual(['cpp-1:on', 'lsp-1:on']);
    t.commits['cpp-1'] = 40; t.commits['lsp-1'] = 50;
    t.advance(60_000); await s.tick();
    expect(t.calls.slice(2)).toEqual(['cpp-1:off', 'lsp-1:off']);
    const done = s.get(cap.id) as any;
    expect(done.status).toBe('done');
    expect(done.windows[0].commits).toEqual({ 'cpp-1': { start: 11, end: 40 }, 'lsp-1': { start: 21, end: 50 } });
    expect(done.windows[0].archive).toHaveLength(2);
  });

  it('closes a window after a step count, and repeats', async () => {
    const t = setup();
    const s = new Scheduler(t.deps, t.file, t.clock);
    const cap = s.add({ kind: 'capture', targets: ['cpp-1'], startCommit: 10, steps: 5, repeatEveryMs: 3_600_000 });
    await s.tick();
    expect((s.get(cap.id) as any).status).toBe('open');
    t.commits['cpp-1'] = 15; await s.tick();
    expect((s.get(cap.id) as any).status).toBe('open'); // 15 - 11 < 5
    t.commits['cpp-1'] = 16; await s.tick();
    const c = s.get(cap.id) as any;
    expect(c.status).toBe('pending');
    expect(c.startAt).toBe(1_000_000 + 3_600_000);
  });

  it('re-runs over a capture window\'s commits, and over the latest N, from the archive or the store', async () => {
    const t = setup();
    const s = new Scheduler(t.deps, t.file, t.clock);
    const cap = s.add({ kind: 'capture', targets: 'all', startAt: 0, durationMs: 1 });
    await s.tick(); t.commits['cpp-1'] = 30; t.advance(5); await s.tick();
    const rr = s.add({ kind: 'rerun', targets: 'all', source: 'archive', window: { captureId: cap.id } });
    const r = await s.runNow(rr.id);
    expect(r.perInstance['cpp-1']).toEqual({ id: 'cpp-1', source: 'archive', from: 11, to: 30 });
    expect(r.sideBySide).toEqual({ compared: ['cpp-1', 'lsp-1'] });
    const latest = s.add({ kind: 'rerun', targets: ['cpp-1'], source: 'store', window: { lastCommits: 10 }, everyMs: 1000 });
    await s.tick();
    expect((s.get(latest.id) as any).results[0].perInstance['cpp-1']).toMatchObject({ from: 21, to: 30 });
    expect((s.get(latest.id) as any).nextRunAt).toBe(t.clock() + 1000);
  });

  it('survives a restart, and a deleted open window turns capture off', async () => {
    const t = setup();
    const s = new Scheduler(t.deps, t.file, t.clock);
    const cap = s.add({ kind: 'capture', targets: 'all', startAt: 0, durationMs: 3_600_000 });
    await s.tick();
    const again = new Scheduler(t.deps, t.file, t.clock);
    expect((again.get(cap.id) as any).status).toBe('open');
    await again.remove(cap.id);
    expect(t.calls.slice(-2)).toEqual(['cpp-1:off', 'lsp-1:off']);
    expect(new Scheduler(t.deps, t.file, t.clock).list()).toEqual([]);
  });

  it('validates what it is given', () => {
    expect(validate({ kind: 'capture', targets: 'all', durationMs: 1 })).toMatch(/startAt or startCommit/);
    expect(validate({ kind: 'capture', targets: [], startAt: 1, durationMs: 1 })).toMatch(/targets/);
    expect(validate({ kind: 'rerun', targets: 'all', source: 'disk', window: { lastCommits: 1 } })).toMatch(/source/);
    expect(validate({ kind: 'rerun', targets: 'all', source: 'store', window: { lastCommits: 0 } })).toMatch(/window/);
  });
});
