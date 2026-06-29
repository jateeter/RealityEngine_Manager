import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as https from 'https';
import { readFileSync, existsSync } from 'fs';
import { auditMiddleware, loadAuditConfig, logAuditEvent } from './auditLogger.js';

const PORT = parseInt(process.env.VIZ_PORT || '3001', 10);
const auditConfig = loadAuditConfig('visualizer-backend');
const RE_RUNTIME_URL_DEFAULT = process.env.RE_RUNTIME_URL || process.env.REALITY_ENGINE_URL || 'https://localhost:5001';
const PE_RUNTIME_URL_DEFAULT = process.env.PE_RUNTIME_URL || process.env.PERCEPTION_ENGINE_URL || 'https://localhost:3004';
const RE_REGISTRY_URL = process.env.RE_REGISTRY_URL ?? '';
const ALLOWED_ORIGINS: string[] = (
  process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,https://localhost:5173,http://localhost:3001,https://localhost:3001'
).split(',').map(o => o.trim()).filter(Boolean);
const certPath = process.env.TLS_CERT_PATH;
const keyPath  = process.env.TLS_KEY_PATH;
const tlsEnabled = !!(certPath && keyPath && existsSync(certPath) && existsSync(keyPath));
const RATE_LIMIT_MAX = parseInt(process.env.VIZ_RATE_LIMIT_MAX || '200', 10);
const MACHINES_RATE_LIMIT_MAX = parseInt(process.env.VIZ_MACHINES_RATE_LIMIT_MAX || '120', 10);

// ── Multi-engine registry ─────────────────────────────────────────────────

interface EngineInstance {
  id: string;
  runtime: string;
  re_url: string;
  pe_url: string;
  re_port: number;
  pe_port: number;
  pid_re: number | null;
  pid_pe: number | null;
  started_at: string;
  status: string;
}

let engineInstances: EngineInstance[] = [];
let activeEngineId: string | null = null;

function activeReUrl(): string {
  if (engineInstances.length > 0) {
    const inst = activeEngineId
      ? engineInstances.find(i => i.id === activeEngineId)
      : engineInstances[0];
    if (inst) return inst.re_url;
  }
  return RE_RUNTIME_URL_DEFAULT;
}

function activePeUrl(): string {
  if (engineInstances.length > 0) {
    const inst = activeEngineId
      ? engineInstances.find(i => i.id === activeEngineId)
      : engineInstances[0];
    if (inst) return inst.pe_url;
  }
  return PE_RUNTIME_URL_DEFAULT;
}


async function syncRegistry(): Promise<void> {
  if (!RE_REGISTRY_URL) return;
  try {
    const res = await axios.get(RE_REGISTRY_URL, { timeout: 3000 });
    const data = res.data as { instances?: EngineInstance[] };
    const fresh = data.instances ?? [];
    // Only replace the known-good list when the registry returns at least one
    // instance.  An empty response is treated as a transient outage so stale
    // URLs continue to be served rather than dropping all proxying.
    if (fresh.length === 0) return;
    engineInstances = fresh;
    if (!activeEngineId && engineInstances.length > 0) {
      activeEngineId = engineInstances[0].id;
    }
    // Remove activeEngineId if the instance has been deregistered
    if (activeEngineId && !engineInstances.find(i => i.id === activeEngineId)) {
      activeEngineId = engineInstances.length > 0 ? engineInstances[0].id : null;
    }
  } catch {
    // Registry offline — keep last known list; don't break existing proxying
  }
}

if (RE_REGISTRY_URL) {
  void syncRegistry();
  setInterval(() => { void syncRegistry(); }, 5_000);
  console.log(`Multi-engine registry: ${RE_REGISTRY_URL} (polling every 5 s)`);
} else {
  // Backward-compat: synthesise a single-entry registry from static env vars
  engineInstances = [{
    id: 'default',
    runtime: 'scala',
    re_url: RE_RUNTIME_URL_DEFAULT,
    pe_url: PE_RUNTIME_URL_DEFAULT,
    re_port: 0, pe_port: 0,
    pid_re: null, pid_pe: null,
    started_at: new Date().toISOString(),
    status: 'running',
  }];
  activeEngineId = 'default';
}

const app = express();

app.use(auditMiddleware(auditConfig));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error(`Origin ${origin} not allowed by CORS`));
  }
}));
app.use(express.json({ limit: '10mb' }));

const server = tlsEnabled
  ? https.createServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

// ── Rate limiting ─────────────────────────────────────────────────────────────
interface RateBucket { count: number; resetAt: number }
const rateBuckets = new Map<string, RateBucket>();
const RATE_WINDOW_MS = 60_000;

function rateLimit(max: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateBuckets.set(ip, bucket);
    }
    if (bucket.count >= max) { res.status(429).json({ error: 'Too many requests' }); return; }
    bucket.count++;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) { if (bucket.resetAt < now) rateBuckets.delete(ip); }
}, 5 * 60_000);

app.use(rateLimit(RATE_LIMIT_MAX));

// ── Input validation ──────────────────────────────────────────────────────────
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function isValidId(id: string): boolean { return ID_RE.test(id); }

function upstreamError(res: Response, error: any, context: string): void {
  const status: number = (error.response?.status as number | undefined) ?? 500;
  console.error(`[${context}] upstream error (${status}):`, error.message);
  if (status === 404) res.status(404).json({ error: 'Not found' });
  else if (status >= 400 && status < 500) res.status(status).json({ error: 'Bad request' });
  else res.status(500).json({ error: 'Internal server error' });
}

// ── Short-TTL cache ───────────────────────────────────────────────────────────
const CACHE_TTL_MS = parseInt(process.env.VIZ_CACHE_TTL_MS || '500', 10);
const CACHE_MAX    = 100;
interface CacheEntry { data: any; ts: number }
const responseCache = new Map<string, CacheEntry>();

function getCached(key: string): any | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  responseCache.delete(key);
  return null;
}

function setCached(key: string, data: any): void {
  if (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { data, ts: Date.now() });
}

function invalidate(prefix: string): void {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}

setInterval(() => {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [key, entry] of responseCache) {
    if (entry.ts < cutoff) responseCache.delete(key);
  }
}, CACHE_TTL_MS * 4);

// ── WebSocket ─────────────────────────────────────────────────────────────────
const clients = new Set<any>();
const pendingPong = new Set<any>();
const HEARTBEAT_INTERVAL = 30000;

wss.on('connection', (ws: WebSocket, req) => {
  const origin = (req as any).headers?.origin as string | undefined;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) { ws.close(4001, 'Unauthorized'); return; }
  clients.add(ws);
  ws.on('pong', () => { pendingPong.delete(ws); });
  ws.on('close', () => { pendingPong.delete(ws); clients.delete(ws); });
  ws.on('error', () => { pendingPong.delete(ws); clients.delete(ws); });
});

const heartbeatInterval = setInterval(() => {
  for (const ws of pendingPong) { clients.delete(ws); ws.terminate(); }
  pendingPong.clear();
  for (const ws of clients) { pendingPong.add(ws); ws.ping(); }
}, HEARTBEAT_INTERVAL);

function broadcast(data: any): void {
  const message = JSON.stringify(data);
  clients.forEach((client) => { if (client.readyState === 1) client.send(message); });
}

// ── RE SSE step stream — fan out to browser WS clients ───────────────────────
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(reason: string, delayMs: number): void {
  if (reconnectTimer) return;
  console.warn(`[SSE] ${reason}, reconnecting in ${Math.round(delayMs / 1000)} s`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToREStream(); }, delayMs);
}

function connectToREStream(): void {
  const reUrl = new URL(`${activeReUrl()}/api/engine/stream`);
  const transport = reUrl.protocol === 'https:' ? https : http;
  const caPath = process.env.NODE_EXTRA_CA_CERTS;

  const req = transport.get(
    {
      hostname: reUrl.hostname,
      port: reUrl.port ? parseInt(reUrl.port, 10) : (reUrl.protocol === 'https:' ? 443 : 80),
      path: reUrl.pathname,
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      timeout: 0,
      ...(reUrl.protocol === 'https:' && caPath && existsSync(caPath) ? { ca: readFileSync(caPath) } : {}),
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleReconnect(`RE stream returned ${res.statusCode}`, 3000);
        return;
      }
      console.log('[SSE] Connected to RE step stream');
      let lastByteAt = Date.now();
      const stallCheck = setInterval(() => {
        if (Date.now() - lastByteAt > 45_000) { clearInterval(stallCheck); req.destroy(new Error('stalled')); }
      }, 15_000);

      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        lastByteAt = Date.now();
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trimStart();
          if (!payload) continue;
          try {
            const step = JSON.parse(payload);
            broadcast({
              type: 'perceptual-simulation-stepped',
              step,
              data: { activeMachineIds: Object.keys(step.machineResults ?? {}) },
              timestamp: Date.now(),
            });
          } catch { /* ignore malformed events */ }
        }
      });
      res.on('end', () => { clearInterval(stallCheck); scheduleReconnect('RE stream closed', 2000); });
      res.on('error', (e: Error) => { clearInterval(stallCheck); scheduleReconnect(`RE stream error: ${e.message}`, 2000); });
    }
  );

  req.setTimeout(0);
  req.on('error', (e: Error) => { scheduleReconnect(`RE connection failed: ${e.message}`, 3000); });
  req.end();
}

// ── Generic read proxy helper ─────────────────────────────────────────────────

async function proxyGet(
  req: Request, res: Response,
  baseUrl: string, upstreamPath: string,
  cacheKey: string | null,
  context: string,
): Promise<void> {
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) { res.json(cached); return; }
  }
  try {
    const url = `${baseUrl}${upstreamPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
    const response = await axios.get(url);
    if (cacheKey) setCached(cacheKey, response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, context); }
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', service: 'reality-engine-visualizer', timestamp: Date.now() });
});

// ── Engine registry endpoints ─────────────────────────────────────────────

app.get('/api/engines', (_req: Request, res: Response) => {
  res.json({ instances: engineInstances, activeId: activeEngineId });
});

app.post('/api/engines/active', (req: Request, res: Response) => {
  const { id } = req.body as { id?: string };
  if (!id || typeof id !== 'string') { res.status(400).json({ error: 'id required' }); return; }
  const inst = engineInstances.find(i => i.id === id);
  if (!inst) { res.status(404).json({ error: `Instance '${id}' not found` }); return; }
  activeEngineId = id;
  invalidate('machine-graph');
  invalidate('machines:');
  // Reconnect SSE stream to the new active RE instance
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connectToREStream();
  console.log(`[engines] active instance switched to: ${id} (${inst.re_url})`);
  res.json({ activeId: activeEngineId, re_url: inst.re_url, pe_url: inst.pe_url });
});

// ── RE status & runtime routes (proxied from RE surface) ─────────────────────

app.get('/api/health',                        (req, res) => proxyGet(req, res, activeReUrl(), '/api/health',                        're:health',   'getREHealth'));
app.get('/api/engine/stats',                  (req, res) => proxyGet(req, res, activeReUrl(), '/api/engine/stats',                  're:estats',   'getEngineStats'));
app.get('/api/engine/active',                 (req, res) => proxyGet(req, res, activeReUrl(), '/api/engine/active',                 're:eactive',  'getEngineActive'));
app.get('/api/engine/history',                (req, res) => proxyGet(req, res, activeReUrl(), '/api/engine/history',                null,          'getEngineHistory'));
app.get('/api/runtime/metrics',               (req, res) => proxyGet(req, res, activeReUrl(), '/api/runtime/metrics',               're:rmetrics', 'getRuntimeMetrics'));
app.get('/api/runtime/vector-space',          (req, res) => proxyGet(req, res, activeReUrl(), '/api/runtime/vector-space',          're:rvspace',  'getVectorSpace'));
app.get('/api/runtime/storage-footprint',     (req, res) => proxyGet(req, res, activeReUrl(), '/api/runtime/storage-footprint',     null,          'getStorageFootprint'));
app.get('/api/perceptual-simulation/state',   (req, res) => proxyGet(req, res, activeReUrl(), '/api/perceptual-simulation/state',   're:simstate', 'getSimState'));
app.get('/api/perceptual-simulation/history', (req, res) => proxyGet(req, res, activeReUrl(), '/api/perceptual-simulation/history', null,          'getSimHistory'));
app.get('/api/config',                        (req, res) => proxyGet(req, res, activeReUrl(), '/api/config',                        're:config',   'getConfig'));
app.get('/api/governance/route',              (req, res) => proxyGet(req, res, activeReUrl(), '/api/governance/route',              null,          'getGovernanceRoute'));
app.get('/api/sampler/stats',                 (req, res) => proxyGet(req, res, activeReUrl(), '/api/sampler/stats',                 null,          'getSamplerStats'));

// ── PE proxy routes — all under /api/pe/* → PE runtime /api/* ────────────────
//    Keeps the PE surface segregated so the Manager can talk to both runtimes

app.get('/api/pe/health',                    (req, res) => proxyGet(req, res, activePeUrl(), '/api/health',                 'pe:health',   'getPEHealth'));
app.get('/api/pe/state',                     (req, res) => proxyGet(req, res, activePeUrl(), '/api/state',                  'pe:state',    'getPEState'));
app.get('/api/pe/sources',                   (req, res) => proxyGet(req, res, activePeUrl(), '/api/sources',                'pe:sources',  'getPESources'));
app.get('/api/pe/dispatch/ledger',           (req, res) => proxyGet(req, res, activePeUrl(), '/api/dispatch/ledger',        null,          'getPEDispatchLedger'));
app.get('/api/pe/dispatch/records/:id',      (req, res) => proxyGet(req, res, activePeUrl(), `/api/dispatch/records/${req.params.id}`, null, 'getPEDispatchRecord'));
app.get('/api/pe/triggers/status',           (req, res) => proxyGet(req, res, activePeUrl(), '/api/triggers/status',        'pe:triggers', 'getPETriggers'));
app.get('/api/pe/integrations/status',       (req, res) => proxyGet(req, res, activePeUrl(), '/api/integrations/status',    'pe:intstatus','getPEIntegrationsStatus'));
app.get('/api/pe/integrations/ollama/status',(req, res) => proxyGet(req, res, activePeUrl(), '/api/integrations/ollama/status', null,     'getPEOllamaStatus'));
app.get('/api/pe/integrations/localai/status',(req,res) => proxyGet(req, res, activePeUrl(), '/api/integrations/localai/status', null,    'getPELocalAIStatus'));
app.get('/api/pe/integrations/healthkit/status',(req,res)=>proxyGet(req, res, activePeUrl(), '/api/integrations/healthkit/status', null,  'getPEHealthKitStatus'));
app.get('/api/pe/integrations/carekit/status',(req,res) => proxyGet(req, res, activePeUrl(), '/api/integrations/carekit/status', null,    'getPECareKitStatus'));
app.get('/api/pe/mqtt/status',    (req, res) => proxyGet(req, res,  activePeUrl(), '/api/mqtt/status',    'pe:mqtt',  'getPEMqttStatus'));
app.get('/api/pe/mqtt/mappings',  (req, res) => proxyGet(req, res,  activePeUrl(), '/api/mqtt/mappings',  'pe:mqtt',  'getPEMqttMappings'));
app.get('/api/pe/mqtt/example',   (req, res) => proxyGet(req, res,  activePeUrl(), '/api/mqtt/example',   'pe:mqtt',  'getPEMqttExample'));
app.post('/api/pe/mqtt/enable',  (req, res) => proxyPost(req, res, activePeUrl(), '/api/mqtt/enable',  'peEnableMqtt',  'pe:mqtt'));
app.post('/api/pe/mqtt/disable', (req, res) => proxyPost(req, res, activePeUrl(), '/api/mqtt/disable', 'peDisableMqtt', 'pe:mqtt'));
app.put('/api/pe/mqtt/mappings',  (req, res) => proxyPut(req, res,  activePeUrl(), '/api/mqtt/mappings', 'pePutMqttMappings',    'pe:mqtt'));
app.get('/api/pe/machines',                  (req, res) => proxyGet(req, res, activePeUrl(), '/api/machines',               null,          'getPEMachines'));

// ── PE mutation routes — proxied to PE runtime ────────────────────────────────

async function proxyPost(req: Request, res: Response, baseUrl: string, path: string, context: string, invalidatePrefix?: string): Promise<void> {
  try {
    const r = await axios.post(`${baseUrl}${path}`, req.body);
    if (invalidatePrefix) invalidate(invalidatePrefix);
    res.json(r.data);
  } catch (e: any) { upstreamError(res, e, context); }
}

async function proxyPatch(req: Request, res: Response, baseUrl: string, path: string, context: string, invalidatePrefix?: string): Promise<void> {
  try {
    const r = await axios.patch(`${baseUrl}${path}`, req.body);
    if (invalidatePrefix) invalidate(invalidatePrefix);
    res.json(r.data);
  } catch (e: any) { upstreamError(res, e, context); }
}

async function proxyPut(req: Request, res: Response, baseUrl: string, path: string, context: string, invalidatePrefix?: string): Promise<void> {
  try {
    const r = await axios.put(`${baseUrl}${path}`, req.body);
    if (invalidatePrefix) invalidate(invalidatePrefix);
    res.json(r.data);
  } catch (e: any) { upstreamError(res, e, context); }
}

async function proxyDelete(req: Request, res: Response, baseUrl: string, path: string, context: string, invalidatePrefix?: string): Promise<void> {
  try {
    await axios.delete(`${baseUrl}${path}`);
    if (invalidatePrefix) invalidate(invalidatePrefix);
    res.json({ success: true });
  } catch (e: any) { upstreamError(res, e, context); }
}

app.post('/api/pe/push',   (req, res) => proxyPost(req, res, activePeUrl(), '/api/push',         'pePush',   'pe:'));
app.post('/api/pe/reset',  (req, res) => proxyPost(req, res, activePeUrl(), '/api/reset',        'peReset',  'pe:'));
app.post('/api/pe/auto/start', (req, res) => proxyPost(req, res, activePeUrl(), '/api/auto/start', 'peAutoStart'));
app.post('/api/pe/auto/stop',  (req, res) => proxyPost(req, res, activePeUrl(), '/api/auto/stop',  'peAutoStop'));
app.patch('/api/pe/config',    (req, res) => proxyPatch(req, res, activePeUrl(), '/api/config',    'pePatchConfig', 'pe:'));
app.post('/api/pe/sources/bootstrap-from-machines', (req, res) => proxyPost(req, res, activePeUrl(), '/api/sources/bootstrap-from-machines', 'peBootstrap', 'pe:'));

app.post('/api/pe/sources', async (req: Request, res: Response) => {
  try {
    const r = await axios.post(`${activePeUrl()}/api/sources`, req.body);
    invalidate('pe:');
    res.json(r.data);
  } catch (e: any) { upstreamError(res, e, 'peAddSource'); }
});

app.patch('/api/pe/sources/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const r = await axios.patch(`${activePeUrl()}/api/sources/${id}`, req.body);
    invalidate('pe:');
    res.json(r.data);
  } catch (e: any) { upstreamError(res, e, 'peUpdateSource'); }
});

app.delete('/api/pe/sources/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    await axios.delete(`${activePeUrl()}/api/sources/${id}`);
    invalidate('pe:');
    res.json({ success: true });
  } catch (e: any) { upstreamError(res, e, 'peDeleteSource'); }
});

// Per-instance health check — proxied so the browser never makes cross-origin
// requests to arbitrary engine host:port addresses.  Callers use the instance
// id (from /api/engines) so the browser only ever talks to the visualizer backend.
app.get('/api/engines/:id/health', async (req: Request, res: Response) => {
  const { id } = req.params;
  const inst = engineInstances.find(i => i.id === id);
  if (!inst) { res.status(404).json({ error: 'Instance not found' }); return; }
  try {
    const r = await axios.get(`${inst.re_url}/api/health`, { timeout: 3000 });
    res.json(r.data);
  } catch {
    res.status(503).json({ status: 'unreachable' });
  }
});

// Machine JSON import routes — proxy to RE (must precede /api/machines/:id)
app.get('/api/machines/json/list', (req, res) => proxyGet(req, res, activeReUrl(), '/api/machines/json/list', null, 'listMachineJSON'));

app.get('/api/machines/json/:name', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidId(name)) { res.status(400).json({ error: 'Invalid name' }); return; }
  return proxyGet(req, res, activeReUrl(), `/api/machines/json/${name}`, null, 'loadMachineJSON');
});

app.post('/api/machines/json/import', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${activeReUrl()}/api/machines/json/import`, req.body);
    invalidate('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'importMachineJSON'); }
});

// Machines — list and detail
app.get('/api/machines', rateLimit(MACHINES_RATE_LIMIT_MAX), async (req: Request, res: Response) => {
  const cacheKey = 'machines:list';
  const cached = getCached(cacheKey);
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${activeReUrl()}/api/machines`);
    setCached(cacheKey, response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMachines'); }
});

// Full machine export (with sequences + vectors) — used by the interconnection
// tooltip to populate the embedded CES graph.  Must precede the generic /:id route.
app.get('/api/machines/:id/export', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const response = await axios.get(`${activeReUrl()}/api/machines/${id}/export`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'exportMachine'); }
});

app.get('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const cacheKey = `machines:${id}`;
  const cached = getCached(cacheKey);
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${activeReUrl()}/api/machines/${id}`);
    setCached(cacheKey, response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMachine'); }
});

// Machine graph — the interconnect view data
app.get('/api/machine-graph', async (_req: Request, res: Response) => {
  const cached = getCached('machine-graph');
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${activeReUrl()}/api/machine-graph`);
    setCached('machine-graph', response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMachineGraph'); }
});

// Mutations invalidate the machine cache so the next list/detail fetch is fresh
app.post('/api/machines', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${activeReUrl()}/api/machines`, req.body);
    invalidate('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'createMachine'); }
});

app.patch('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const response = await axios.patch(`${activeReUrl()}/api/machines/${id}`, req.body);
    invalidate('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'patchMachine'); }
});

app.put('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const response = await axios.put(`${activeReUrl()}/api/machines/${id}`, req.body);
    invalidate('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'putMachine'); }
});

app.delete('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    await axios.delete(`${activeReUrl()}/api/machines/${id}`);
    invalidate('machines:');
    res.json({ success: true });
  } catch (error: any) { upstreamError(res, error, 'deleteMachine'); }
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const protocol   = tlsEnabled ? 'https' : 'http';
  const wsProtocol = tlsEnabled ? 'wss'   : 'ws';
  console.log(`Reality Engine Visualizer Backend  port=${PORT} (${protocol.toUpperCase()})`);
  console.log(`WebSocket: ${wsProtocol}://localhost:${PORT}/ws`);
  console.log(`RE runtime: ${activeReUrl()} (active)`);
  console.log(`PE runtime: ${activePeUrl()} (active)`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  logAuditEvent(auditConfig, 'startup', {
    audit_enabled: auditConfig.enabled,
    audit_level:   auditConfig.level,
    port:          PORT,
  });
  connectToREStream();
});

process.on('SIGTERM', () => { clearInterval(heartbeatInterval); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { clearInterval(heartbeatInterval); server.close(() => process.exit(0)); });
