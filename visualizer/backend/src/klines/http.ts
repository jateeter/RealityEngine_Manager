// The K-line panel's routes (RealityEngine_Manager#372), under /api/kline-panel:
//
//   GET    /api/kline-panel                      every instance's two halves, voters and followers
//   POST   /api/kline-panel/capture              {on, instances?}  both halves, read back
//   PUT    /api/kline-panel/knobs/:id/:knob      {value}           a knob, read back
//   DELETE /api/kline-panel/knobs/:id/:knob                        the knob's declared default
//   GET    /api/kline-panel/analysis?instance=&source=store|archive&from=&to=
//   POST   /api/kline-panel/archive              {instances?}      export into the archive
//   GET    /api/kline-panel/archive              the catalog
//   GET    /api/kline-panel/schedules            POST to add; DELETE /:id; POST /:id/run
//
// Every engine call is lane TLS: the default axios instance carries the lane's
// mTLS agent (laneTls.installAxios in server.ts).

import axios from 'axios';
import type { Express, Request, Response } from 'express';
import { analyzeCompositions, analyzeKlines, sideBySide, type KlineAnalysis } from './analysis.js';
import { archiveOne, archiveRoot, archivedRecords, readCatalog, type Kind } from './archive.js';
import { instanceStatus, paged, roleOf, setCapture, setKnob, validKnob, PE_KNOBS, RE_KNOBS, type Http, type Instance, type Knob } from './panel.js';
import { Scheduler, stateFile, type Deps } from './scheduler.js';

const keep = { validateStatus: () => true, timeout: 30_000 };

export const axiosHttp: Http = {
  get: async url => { const r = await axios.get(url, keep); return { status: r.status, data: r.data }; },
  put: async (url, body) => { const r = await axios.put(url, body, keep); return { status: r.status, data: r.data }; },
  patch: async (url, body) => { const r = await axios.patch(url, body, keep); return { status: r.status, data: r.data }; },
  delete: async url => { const r = await axios.delete(url, keep); return { status: r.status, data: r.data }; },
  postText: async (url, body) => {
    const r = await axios.post(url, body, { ...keep, timeout: 300_000, responseType: 'text', transformResponse: x => x });
    return { status: r.status, text: String(r.data ?? '') };
  },
};

/** The panel's view of one instance's records over [from, to]: both halves analysed. */
export async function analyzeInstance(http: Http, inst: Instance, source: 'store' | 'archive', from: number, to: number,
                                      root = archiveRoot()): Promise<{ klines: KlineAnalysis; compositions: ReturnType<typeof analyzeCompositions> | null }> {
  let klines: any[], comps: any[] | null = null;
  if (source === 'store') {
    klines = (await paged(http, `${inst.re_url.replace(/\/+$/, '')}/api/klines`, 'since', 'klines', from))
      .filter(k => (k?.close?.commit ?? 0) <= to);
    if (inst.pe_url) {
      try { comps = await paged(http, `${inst.pe_url.replace(/\/+$/, '')}/api/isre-composition`, 'from', 'records', from, to); }
      catch { comps = null; }
    }
  } else {
    const participant = async (url: string, path: string) =>
      String((await http.get(`${url.replace(/\/+$/, '')}${path}`)).data?.instance ?? '').toLowerCase();
    klines = archivedRecords(root, await participant(inst.re_url, '/api/engine/clock'), 'klines', from, to);
    if (inst.pe_url) comps = archivedRecords(root, await participant(inst.pe_url, '/api/clock'), 'isre', from, to);
  }
  return { klines: analyzeKlines(klines), compositions: comps === null ? null : analyzeCompositions(comps) };
}

/** The voters' K-line analyses side by side; followers are shown, never compared. */
export function compareVoters(instances: Instance[], perInstance: Record<string, any>) {
  const voters: Record<string, KlineAnalysis | null> = {};
  for (const inst of instances) if (roleOf(inst) === 'voter') voters[inst.id] = perInstance[inst.id]?.klines ?? null;
  return sideBySide(voters);
}

export function mountKlinePanel(app: Express, instances: () => Instance[], http: Http = axiosHttp,
                                options: { stateFile?: string | null; tickMs?: number } = {}): Scheduler {
  const find = (id: string) => instances().find(i => i.id === id);
  const pick = (ids: unknown): Instance[] =>
    Array.isArray(ids) && ids.length ? instances().filter(i => (ids as unknown[]).includes(i.id)) : instances();

  const archive = async (inst: Instance) => {
    const root = archiveRoot();
    const entries = readCatalog(root);
    const out = [];
    for (const kind of ['klines', 'isre'] as Kind[]) {
      try { out.push(await archiveOne(http, root, entries, inst, kind)); }
      catch (e: any) { out.push({ instance: inst.id, kind, result: `refused: ${e?.message ?? e}` }); }
    }
    return out;
  };

  const deps: Deps = {
    instanceIds: () => instances().map(i => i.id),
    setCapture: async (id, on) => {
      const inst = find(id);
      if (!inst) return { ok: false, errors: [`${id} is not registered`] };
      const r = await setCapture(http, inst, on);
      return { ok: r.ok, errors: r.errors };
    },
    commitOf: async id => {
      const inst = find(id);
      if (!inst) return null;
      const r = await http.get(`${inst.re_url.replace(/\/+$/, '')}/api/engine/clock`);
      return r.status === 200 && typeof r.data?.commit === 'number' ? r.data.commit : null;
    },
    analyze: async (id, source, from, to) => {
      const inst = find(id);
      if (!inst) throw new Error(`${id} is not registered`);
      return analyzeInstance(http, inst, source, from, to);
    },
    compare: per => compareVoters(instances(), per as Record<string, any>),
    archive: async id => { const inst = find(id); return inst ? archive(inst) : []; },
  };
  const scheduler = new Scheduler(deps, options.stateFile === undefined ? stateFile() : options.stateFile);
  if (options.tickMs !== 0) setInterval(() => { void scheduler.tick(); }, options.tickMs ?? 10_000).unref();

  const fail = (res: Response, e: any) => res.status(502).json({ error: String(e?.message ?? e) });

  app.get('/api/kline-panel', async (_req: Request, res: Response) => {
    try {
      const status = await Promise.all(instances().map(i => instanceStatus(http, i)));
      res.json({
        instances: status,
        // What this universe was started with (startUniverse.sh exports it to Manager); null if unknown.
        bootCapture: process.env.RE_KLINE_CAPTURE === undefined ? null : ['1', 'on', 'true'].includes(process.env.RE_KLINE_CAPTURE),
        knobs: { re: RE_KNOBS, pe: PE_KNOBS },
        archive: archiveRoot(),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/kline-panel/capture', async (req: Request, res: Response) => {
    const on = req.body?.on;
    if (typeof on !== 'boolean') { res.status(400).json({ error: 'on requires a boolean' }); return; }
    const targets = pick(req.body?.instances);
    if (!targets.length) { res.status(404).json({ error: 'no such instance' }); return; }
    try {
      const results = await Promise.all(targets.map(i => setCapture(http, i, on)));
      res.status(results.every(r => r.ok) ? 200 : 207).json({ results });
    } catch (e) { fail(res, e); }
  });

  const knob = async (req: Request, res: Response, value: number | null) => {
    const id = String(req.params.id), name = String(req.params.knob) as Knob;
    const inst = find(id);
    if (!inst) { res.status(404).json({ error: `instance ${id} is not registered` }); return; }
    const err = validKnob(name, value === null ? ((RE_KNOBS as any)[name] ?? (PE_KNOBS as any)[name])?.default : value);
    if (err) { res.status(400).json({ error: err }); return; }
    try {
      const r = await setKnob(http, inst, name, value);
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) { fail(res, e); }
  };
  app.put('/api/kline-panel/knobs/:id/:knob', (req, res) => knob(req, res, req.body?.value));
  app.delete('/api/kline-panel/knobs/:id/:knob', (req, res) => knob(req, res, null));

  app.get('/api/kline-panel/analysis', async (req: Request, res: Response) => {
    const source = req.query.source === 'archive' ? 'archive' : 'store';
    const whole = (v: unknown, d: number) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : d);
    const from = whole(req.query.from, 0), to = whole(req.query.to, Number.MAX_SAFE_INTEGER);
    const ids = typeof req.query.instance === 'string' ? [req.query.instance] : undefined;
    const targets = pick(ids);
    try {
      const perInstance: Record<string, any> = {};
      const errors: string[] = [];
      await Promise.all(targets.map(async inst => {
        try { perInstance[inst.id] = await analyzeInstance(http, inst, source, from, to); }
        catch (e: any) { errors.push(`${inst.id}: ${e?.message ?? e}`); }
      }));
      res.json({ source, from, to, perInstance, sideBySide: compareVoters(instances(), perInstance), errors });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/kline-panel/archive', async (req: Request, res: Response) => {
    try {
      const results = [];
      for (const inst of pick(req.body?.instances)) results.push(...await archive(inst));
      const refused = results.some(r => r.result.startsWith('refused') || r.result.startsWith('export '));
      res.status(refused ? 207 : 200).json({ root: archiveRoot(), results });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/kline-panel/archive', (_req: Request, res: Response) => {
    res.json({ root: archiveRoot(), catalog: readCatalog(archiveRoot()) });
  });

  app.get('/api/kline-panel/schedules', (_req, res) => { res.json({ schedules: scheduler.list() }); });
  app.post('/api/kline-panel/schedules', (req: Request, res: Response) => {
    try { res.status(201).json(scheduler.add(req.body)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/kline-panel/schedules/:id', async (req: Request, res: Response) => {
    (await scheduler.remove(String(req.params.id))) ? res.json({ removed: String(req.params.id) }) : res.status(404).json({ error: 'no such schedule' });
  });
  app.post('/api/kline-panel/schedules/:id/run', async (req: Request, res: Response) => {
    try { res.json(await scheduler.runNow(String(req.params.id))); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  return scheduler;
}
