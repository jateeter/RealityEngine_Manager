// The instantiation component's HTTP side: its clients for the lifecycle
// service and the engine instances, and the routes Manager serves
// (localAssetStorageStack ROADMAP phase 9).
//
// Every call is lane TLS: the default axios instance carries the lane's mTLS
// agent for internal peers (laneTls.installAxios in server.ts).
import axios, { type AxiosInstance } from 'axios';
import type { Express, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { SimulatedAgent, type AgentDriver, type AgentLifecycle } from './agents.js';
import { InstantiationController, type Clone, type Engines, type Lifecycle, type Reply } from './controller.js';
import type { TemplateMachine } from './successor.js';

const keep = { validateStatus: () => true };
const reply = <T>(r: { status: number; data: unknown }): Reply<T> => ({ status: r.status, body: r.data as T });

export function httpLifecycle(baseUrl: string, engineToken: string, client: AxiosInstance = axios): Lifecycle & AgentLifecycle {
  const url = (p: string) => new URL(p, baseUrl).href;
  const engine = { headers: { authorization: `Bearer ${engineToken}` }, ...keep };
  const agent = (capability: string) => ({ headers: { authorization: `Bearer ${capability}` }, ...keep });
  return {
    async openFrames() {
      const r = await client.get(url('/frames?status=open'), engine);
      if (r.status !== 200) throw new Error(`lifecycle GET /frames: ${r.status}`);
      return (r.data as { frames: never[] }).frames;
    },
    async liveLanes() {
      const r = await client.get(url('/lanes'), engine);
      if (r.status !== 200) throw new Error(`lifecycle GET /lanes: ${r.status}`);
      return (r.data as { live: never[] }).live;
    },
    resume: async (f, k, generation) => reply(await client.post(url(`/frames/${f}/continuations/${k}/resume`), { generation }, engine)),
    capability: async (f, k) => reply(await client.post(url(`/frames/${f}/continuations/${k}/capability`), {}, engine)),
    lanes: async (f, clone: Clone) => reply(await client.post(url(`/frames/${f}/clones`), clone, engine)),
    freeLanes: async (f, cloneId, g) => reply(await client.delete(url(`/frames/${f}/clones/${encodeURIComponent(cloneId)}?generation=${g}`), engine)),
    capture: async (f, body) => reply(await client.post(url(`/frames/${f}/continuations`), body, engine)),
    close: async (f) => reply(await client.post(url(`/frames/${f}/close`), {}, engine)),
    // The agent's side: its capability, nothing else.
    async frame(f, capability) {
      const r = await client.get(url(`/frames/${f}`), agent(capability));
      if (r.status !== 200) throw new Error(`frame ${f}: ${r.status}`);
      return r.data as never;
    },
    async readDocument(uri, capability) {
      const r = await client.get(url(`/pod?url=${encodeURIComponent(uri)}`), { ...agent(capability), responseType: 'arraybuffer' });
      if (r.status !== 200) throw new Error(`/pod ${uri}: ${r.status}`);
      return Buffer.from(r.data as ArrayBuffer);
    },
    async writeReturn(f, capability, value) {
      const r = await client.put(url(`/frames/${f}/return`), { return: value }, agent(capability));
      if (r.status !== 200) throw new Error(`return ${f}: ${r.status} ${JSON.stringify(r.data)}`);
    }
  };
}

export interface RegistryInstance { id: string; re_url: string; status?: string }

export function httpEngines(instances: () => RegistryInstance[], client: AxiosInstance = axios): Engines {
  const re = (engineId: string) => {
    const i = instances().find((x) => x.id === engineId && (x.status ?? 'running') === 'running');
    if (!i) throw new Error(`engine instance ${engineId} is not in the instance registry`);
    return i.re_url;
  };
  return {
    clone: async (e, t, asset, envelope) =>
      reply(await client.post(`${re(e)}/api/engine/clone/machine/${encodeURIComponent(t)}?asset=${encodeURIComponent(asset)}&envelope=${encodeURIComponent(envelope)}`, undefined, keep)),
    recycle: async (e, cloneId, g) =>
      reply(await client.post(`${re(e)}/api/engine/recycle/machine/${encodeURIComponent(cloneId)}?generation=${g}`, undefined, keep)),
    async machine(e, id) {
      const r = await client.get(`${re(e)}/api/machines/${encodeURIComponent(id)}`, keep);
      if (r.status !== 200) throw new Error(`machine ${id} on ${e}: ${r.status}`);
      return (r.data as { machine: TemplateMachine }).machine;
    }
  };
}

/** Prometheus lines for the asset-workflow dashboard (RealityEngine_CI#723). */
export function metricsText(c: InstantiationController): string {
  const s = c.status();
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    '# HELP re_instantiation_queue_depth Workflow steps waiting for a clone (FIFO).',
    '# TYPE re_instantiation_queue_depth gauge',
    `re_instantiation_queue_depth ${s.queue.length}`,
    '# HELP re_instantiation_live_clones Live workflow clones, by engine instance and template.',
    '# TYPE re_instantiation_live_clones gauge',
    ...Object.entries(s.liveByTemplate).map(([k, n]) => {
      const [engine, template] = k.split('|');
      return `re_instantiation_live_clones{engine="${esc(engine)}",template="${esc(template)}"} ${n}`;
    }),
    '# HELP re_instantiation_pool_use Live workflow clones per engine instance, of the 1024 blocks in its clone band.',
    '# TYPE re_instantiation_pool_use gauge',
    ...Object.entries(s.liveByEngine).map(([e, n]) => `re_instantiation_pool_use{engine="${esc(e)}"} ${(n / 1024).toFixed(6)}`),
    '# HELP re_instantiation_steps_total Workflow steps by outcome.',
    '# TYPE re_instantiation_steps_total counter',
    ...Object.entries(s.counts).map(([o, n]) => `re_instantiation_steps_total{outcome="${o}"} ${n}`)
  ];
  return `${lines.join('\n')}\n`;
}

export interface InstantiationConfig {
  enabled: boolean;
  lifecycleUrl: string;
  engineToken: string;
  pollMs: number;
  agent: string;
}

export function instantiationConfig(env: NodeJS.ProcessEnv = process.env): InstantiationConfig {
  const tokenFile = env.LIFECYCLE_ENGINE_TOKEN_FILE;
  return {
    enabled: env.INSTANTIATION_ENABLED === 'true',
    lifecycleUrl: env.LIFECYCLE_URL ?? '',
    engineToken: tokenFile ? readFileSync(tokenFile, 'utf8').trim() : (env.LIFECYCLE_ENGINE_TOKEN ?? ''),
    pollMs: Number(env.INSTANTIATION_POLL_MS ?? 2000),
    agent: env.INSTANTIATION_AGENT ?? 'simulated'
  };
}

/**
 * Serves the routes and, when enabled, runs the component. The clone,
 * recycle and clones routes pass through to the named engine instance,
 * resolved from the instance registry; nothing else answers for it.
 */
export function mountInstantiation(app: Express, instances: () => RegistryInstance[], config: InstantiationConfig, client: AxiosInstance = axios) {
  const engines = httpEngines(instances, client);
  let controller: InstantiationController | null = null;
  if (config.enabled) {
    if (!config.lifecycleUrl || !config.engineToken) throw new Error('INSTANTIATION_ENABLED needs LIFECYCLE_URL and LIFECYCLE_ENGINE_TOKEN');
    const lifecycle = httpLifecycle(config.lifecycleUrl, config.engineToken, client);
    const drivers: Record<string, () => AgentDriver> = { simulated: () => new SimulatedAgent(lifecycle) };
    const make = drivers[config.agent];
    if (!make) throw new Error(`INSTANTIATION_AGENT ${config.agent} is not one of ${Object.keys(drivers).join(', ')}`);
    controller = new InstantiationController({ lifecycle, engines, agent: make() });
    const c = controller;
    const loop = async () => {
      try { await c.tick(); } catch (e) { console.error(`instantiation: ${(e as Error).message}`); }
      setTimeout(loop, config.pollMs).unref();
    };
    setTimeout(loop, 0).unref();
    console.log(`Instantiation: enabled (lifecycle ${config.lifecycleUrl}, agent ${config.agent}, every ${config.pollMs} ms)`);
  }

  const pass = async (res: Response, run: () => Promise<Reply>) => {
    try { const r = await run(); res.status(r.status).json(r.body); }
    catch (e) { res.status(404).json({ error: (e as Error).message }); }
  };
  app.get('/api/instantiation/status', (_req: Request, res: Response) => {
    res.json({ enabled: config.enabled, agent: config.agent, ...(controller ? controller.status() : {}) });
  });
  app.get('/api/instantiation/metrics', (_req: Request, res: Response) => {
    res.type('text/plain; version=0.0.4').send(controller ? metricsText(controller) : '');
  });
  app.get('/api/engine/:id/clones', (req: Request, res: Response) => pass(res, async () => {
    const url = instances().find((x) => x.id === req.params.id)?.re_url;
    if (!url) throw new Error(`engine instance ${req.params.id} is not in the instance registry`);
    return reply(await client.get(`${url}/api/engine/clones`, keep));
  }));
  app.post('/api/engine/:id/clone/machine/:machineId', (req: Request, res: Response) => pass(res, () =>
    engines.clone(String(req.params.id), String(req.params.machineId), String(req.query.asset ?? ''), String(req.query.envelope ?? ''))));
  app.post('/api/engine/:id/recycle/machine/:cloneId', (req: Request, res: Response) => pass(res, async () => {
    const url = instances().find((x) => x.id === req.params.id)?.re_url;
    if (!url) throw new Error(`engine instance ${req.params.id} is not in the instance registry`);
    const g = req.query.generation === undefined ? '' : `?generation=${encodeURIComponent(String(req.query.generation))}`;
    return reply(await client.post(`${url}/api/engine/recycle/machine/${encodeURIComponent(String(req.params.cloneId))}${g}`, undefined, keep));
  }));
  return controller;
}
