import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as https from 'https';
import {
  RE_INSTANCE_HEADER, resolveBinding, runBound, boundInstance,
  bindingScope as computeScope, scopedKey as toScopedKey, unscope,
} from './engineBinding.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { auditMiddleware, loadAuditConfig, logAuditEvent } from './auditLogger.js';
import { scanCorpus, resolveSelection, loadMachines } from './corpus.js';
import { RateLimitRegistry, RATE_WINDOW_MS } from './rateLimit.js';

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
// Machine corpus root for the Load Machines modal (Manager#31). The default
// anchors on this module's location (dist/server.js), not the process CWD,
// so native starts resolve the sibling repo regardless of launch directory;
// scanCorpus accepts either the repo root or its machines/ subdirectory.
const MACHINES_DIR = process.env.MACHINES_DIR
  || fileURLToPath(new URL('../../../../RealityEngine_Machines', import.meta.url));

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

// ── Per-request engine binding ────────────────────────────────────────────────
//
// `activeEngineId` is process-global, and `POST /api/engines/active` reassigns
// it. Every concurrent client therefore shares one notion of "the" engine: a
// switch by one caller retargets requests already in flight for another, and
// the response cache below — keyed only by path — could serve one engine's
// machines to a request meant for a different one.
//
// That is not hypothetical. The Playwright suite hit it hard enough to look
// like flake: under parallel workers, specs that switch the engine
// (pe-api-equivalence walks cpp -> lsp -> scala) ran alongside specs reading
// /api/machines, and the pass count drifted 37 -> 32 -> 21 across three
// identical runs with 17 "deterministic" failures and 8 that flipped.
// RealityEngine_Manager#156 pinned the suite to one worker to stop the
// bleeding and said the durable fix belongs here. This is that fix.
//
// `X-RE-Instance: <instance id>` names the engine a request is addressed to,
// and it is pinned for the whole request. The binding lives in an
// AsyncLocalStorage rather than a module variable, which is the point:
// concurrent requests addressed to different engines cannot disturb each
// other, the same property localAIStack gets from a ContextVar in
// `core/bridge_binding.py`.
//
// A named instance that is not running resolves to NOTHING, never to a
// substitute. Falling back to whichever engine happens to be active is exactly
// the cross-talk this exists to prevent, so such a request is refused rather
// than answered by the wrong engine. Without the header the global active
// engine is used, so every existing caller behaves as before.
//
// The resolution and scoping logic lives in ./engineBinding so it can be unit
// tested; this module binds ports on import.

/** Which instance a cache entry belongs to. */
function bindingScope(): string {
  return computeScope(activeEngineId, engineInstances[0]?.id);
}

function activeReUrl(): string {
  const bound = boundInstance();
  if (bound) return bound.re_url;
  if (engineInstances.length > 0) {
    const inst = activeEngineId
      ? engineInstances.find(i => i.id === activeEngineId)
      : engineInstances[0];
    if (inst) return inst.re_url;
  }
  return RE_RUNTIME_URL_DEFAULT;
}

function activePeUrl(): string {
  const bound = boundInstance();
  if (bound) return bound.pe_url;
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

// Resolve the addressed engine once, and run the rest of the request inside
// that binding. Registered before the routes so every handler — and every
// cache read and write they make — sees the same engine for the whole request.
app.use((req: Request, res: Response, next: NextFunction): void => {
  const raw = req.headers[RE_INSTANCE_HEADER];
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (!id) { next(); return; }

  if (!isValidId(id)) {
    res.status(400).json({ error: `Invalid ${RE_INSTANCE_HEADER} header` });
    return;
  }

  const inst = engineInstances.find(i => i.id === id);
  if (!inst) {
    // Named but not running. Answering from the active engine would be the
    // cross-talk this whole mechanism exists to prevent: the caller addressed
    // a specific engine, and silently substituting another makes the mismatch
    // invisible at the call site and downstream.
    res.status(404).json({
      error: `Engine instance '${id}' is not registered`,
      available: engineInstances.map(i => i.id),
    });
    return;
  }

  runBound({ id: inst.id, re_url: inst.re_url, pe_url: inst.pe_url }, next);
});

const server = tlsEnabled
  ? https.createServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

// ── Rate limiting ─────────────────────────────────────────────────────────────
// The budget logic lives in ./rateLimit so it can be unit tested; this module
// binds ports on import, which is why the defect it carried went untested.
const rateLimits = new RateLimitRegistry(RATE_WINDOW_MS);

function rateLimit(max: number, scope = 'global') {
  const limiter = rateLimits.limiter(max, scope);
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (limiter.check(ip) === 429) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

setInterval(() => rateLimits.sweep(), 5 * 60_000);

app.use(rateLimit(RATE_LIMIT_MAX));

// ── Input validation ──────────────────────────────────────────────────────────
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function isValidId(id: string | string[] | undefined): id is string { return typeof id === 'string' && ID_RE.test(id); }

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

// Cache keys are scoped by engine instance. Callers pass the logical key
// ('machines:list'); the stored key is '<instance> machines:list'. Doing it
// here rather than at ~10 call sites means a new cached route cannot forget to
// scope itself — and forgetting would mean serving one engine's data for
// another, which is silent and looks like an engine divergence.
function scopedKey(key: string): string {
  return toScopedKey(bindingScope(), key);
}

function getCached(key: string): any | null {
  const scoped = scopedKey(key);
  const entry = responseCache.get(scoped);
  if (!entry) return null;
  if (Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  responseCache.delete(scoped);
  return null;
}

function setCached(key: string, data: any): void {
  if (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(scopedKey(key), { data, ts: Date.now() });
}

// Invalidates the prefix across EVERY instance, not just the bound one. A
// corpus load or a machine mutation changes what all engines should report, and
// scoping the invalidation to the caller's engine would leave the others
// serving stale entries until the TTL expired.
function invalidate(prefix: string): void {
  for (const key of responseCache.keys()) {
    if (unscope(key).startsWith(prefix)) responseCache.delete(key);
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

// The engine collection. Plural names the set; singular `/api/engine/:id/...`
// names one engine's resources — a vector or sequence id is only meaningful in
// the context of the engine that minted it (RealityEngine_CI#397).
//
// `engines` is the list a caller wants: the instances currently registered and
// running, each with the urls needed to address it, and which one is active.
// `instances` and `activeId` are kept beside it because the Visualizer frontend
// already reads them, and renaming a field the UI depends on is not what this
// route is for.
//
// `status` is the instance registry's own word for the instance. This route
// does not probe liveness — `/api/engine/:id/health` does that, per engine, and
// reports `unreachable` when the engine does not answer.
app.get('/api/engines', (_req: Request, res: Response) => {
  const engines = engineInstances.map(i => ({
    id:      i.id,
    runtime: i.runtime,
    re_url:  i.re_url,
    pe_url:  i.pe_url,
    status:  i.status,
    active:  i.id === activeEngineId,
  }));
  res.json({ engines, count: engines.length, activeId: activeEngineId, instances: engineInstances });
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
// Trajectory histories — SURFACE_SPEC.md, "Trajectory histories". Proxied so a
// probe reaches them through the Manager on whichever engine is active, the
// same as it would reach the engine directly (RealityEngine_CI#148).
app.get('/api/engine/osre-history',           (req, res) => proxyGet(req, res, activeReUrl(), '/api/engine/osre-history',           null,          'getOsreHistory'));
app.get('/api/engine/isre-history',           (req, res) => proxyGet(req, res, activeReUrl(), '/api/engine/isre-history',           null,          'getIsreHistory'));
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
// ── Engine-qualified resource reads ──────────────────────────────────────────
//
// A vector id and a sequence id are BOTH engine-scoped: each runtime keeps its
// own store, so the same id can name different documents on different engines,
// or exist on exactly one. A bare `/api/vectors/:id` answers from whichever
// engine happens to be active, and the caller cannot tell which answer they
// got — so an id read from one engine and used against another silently
// returns the wrong thing, or a 404 for something that does exist.
//
// These routes are the external surface: the id is always used in the context
// of the engine that minted it. The engines' own unqualified routes stay as the
// internal surface these proxy to. RealityEngine_CI#397.
//
// An unknown instance is refused, never substituted — the same rule the
// X-RE-Instance binding follows, and for the same reason.
async function readFromEngine(
  req: Request, res: Response, upstream: (base: string) => string, context: string,
): Promise<void> {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid instance id' }); return; }

  const inst = engineInstances.find(i => i.id === id);
  if (!inst) {
    res.status(404).json({
      error: `Engine instance '${id}' is not registered`,
      available: engineInstances.map(i => i.id),
    });
    return;
  }

  try {
    const r = await axios.get(upstream(inst.re_url));
    res.json(r.data);
  } catch (e: any) {
    // A 404 from the engine means that engine does not hold the id. Passed
    // through with the engine named, so "no such id" and "not on this engine"
    // stay distinguishable to the caller.
    const status = e?.response?.status;
    if (status === 404) {
      res.status(404).json({
        error: e?.response?.data?.error ?? 'Not found',
        engine: inst.id,
      });
      return;
    }
    upstreamError(res, e, context);
  }
}

app.get('/api/engine/:id/vectors/:vectorId', async (req: Request, res: Response) => {
  const { vectorId } = req.params;
  if (!isValidId(vectorId)) { res.status(400).json({ error: 'Invalid vector id' }); return; }
  await readFromEngine(req, res,
    base => `${base}/api/vectors/${encodeURIComponent(vectorId)}`,
    'engineVectorRead');
});

app.get('/api/engine/:id/sequences/:sequenceId', async (req: Request, res: Response) => {
  const { sequenceId } = req.params;
  if (!isValidId(sequenceId)) { res.status(400).json({ error: 'Invalid sequence id' }); return; }
  await readFromEngine(req, res,
    base => `${base}/api/sequences/${encodeURIComponent(sequenceId)}`,
    'engineSequenceRead');
});

// ── Engine configuration, the settable/gettable pathway ─────────────────────
//
// `/api/engine/config` is the single place a runtime control is read or written
// (RealityEngine_CI#271). All three engines implement it; none of it was
// reachable from here, so the Visualizer — the pathway's main consumer — had no
// route to it and no configuration surface at all.
//
// Qualified by engine for the same reason reads are: a control value belongs to
// one runtime. `historyLimit` is 100 on cpp, 250 on lsp and 1000 on scala today,
// so "the current value" is not a question that can be asked without naming the
// engine.
//
// Writes go through `writeToEngine`, which differs from the read helper only in
// forwarding a body and a method — kept separate rather than overloading the
// reader, because a write that silently lands on the wrong engine is the failure
// this qualification exists to prevent.
async function writeToEngine(
  req: Request, res: Response,
  method: 'put' | 'delete',
  upstream: (base: string) => string,
  context: string,
): Promise<void> {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid instance id' }); return; }

  const inst = engineInstances.find(i => i.id === id);
  if (!inst) {
    res.status(404).json({
      error: `Engine instance '${id}' is not registered`,
      available: engineInstances.map(i => i.id),
    });
    return;
  }

  try {
    const url = upstream(inst.re_url);
    const r = method === 'put'
      ? await axios.put(url, req.body)
      : await axios.delete(url);
    // A control write changes what the engine reports; drop cached reads of it
    // rather than let a stale value outlive the change.
    invalidate('re:config');
    res.json(r.data);
  } catch (e: any) {
    const status = e?.response?.status;
    if (status === 404 || status === 400) {
      res.status(status).json({
        error: e?.response?.data?.error ?? (status === 404 ? 'Not found' : 'Bad request'),
        engine: inst.id,
      });
      return;
    }
    upstreamError(res, e, context);
  }
}

app.get('/api/engine/:id/config', async (req: Request, res: Response) => {
  await readFromEngine(req, res, base => `${base}/api/engine/config`, 'engineConfigRead');
});

app.get('/api/engine/:id/config/:control', async (req: Request, res: Response) => {
  const { control } = req.params;
  if (!isValidId(control)) { res.status(400).json({ error: 'Invalid control name' }); return; }
  await readFromEngine(req, res,
    base => `${base}/api/engine/config/${encodeURIComponent(control)}`,
    'engineControlRead');
});

app.put('/api/engine/:id/config/:control', async (req: Request, res: Response) => {
  const { control } = req.params;
  if (!isValidId(control)) { res.status(400).json({ error: 'Invalid control name' }); return; }
  await writeToEngine(req, res, 'put',
    base => `${base}/api/engine/config/${encodeURIComponent(control)}`,
    'engineControlWrite');
});

// DELETE is "restore the declared default", not "remove the control" —
// SURFACE_SPEC is explicit that controls cannot be created or destroyed over
// the API.
app.delete('/api/engine/:id/config/:control', async (req: Request, res: Response) => {
  const { control } = req.params;
  if (!isValidId(control)) { res.status(400).json({ error: 'Invalid control name' }); return; }
  await writeToEngine(req, res, 'delete',
    base => `${base}/api/engine/config/${encodeURIComponent(control)}`,
    'engineControlReset');
});

app.get('/api/engine/:id/health', async (req: Request, res: Response) => {
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

// OWL semantic identity (roadmap M4) — proxy to the active RE so the
// Visualizer plane can compare semanticsIri/semanticsHash across engines.
app.get('/api/machines/semantics/:name', (req, res) => proxyGet(req, res, activeReUrl(), `/api/machines/semantics/${encodeURIComponent(req.params.name)}`, null, 'getMachineSemantics'));

// Semantic audit trail (roadmap M5) — proxy the active RE's re:SequenceObservation
// records so the Visualizer can show the evidence chain behind a dispatch.
app.get('/api/audit/semantics', (req, res) => proxyGet(req, res, activeReUrl(), `/api/audit/semantics${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`, null, 'getSemanticAudit'));

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
// ── Machine corpus catalog + domain-scoped load (Manager#31) ────────────────

// Identity keys for corpus-vs-engine presence checks: corpus files carry no
// machine id (engines assign one at import), so match by name as well.
async function activeEngineMachineKeys(): Promise<{ keys: Set<string>; count: number }> {
  const r = await axios.get(`${activeReUrl()}/api/machines`);
  const machines: any[] = Array.isArray(r.data?.machines) ? r.data.machines : [];
  const keys = new Set<string>();
  for (const m of machines) {
    if (m.id) keys.add(String(m.id));
    if (m.name) keys.add(String(m.name));
  }
  return { keys, count: machines.length };
}

app.get('/api/corpus/tree', async (_req: Request, res: Response) => {
  try {
    const scan = scanCorpus(MACHINES_DIR);
    let loadedIds = new Set<string>();
    let engineCount = 0;
    let engineReachable = true;
    try {
      const em = await activeEngineMachineKeys();
      loadedIds = em.keys;
      engineCount = em.count;
    } catch { engineReachable = false; /* engine down — tree still useful */ }
    const annotate = (node: any): any => ({
      ...node,
      loadedCount:
        node.machines.filter((m: any) => loadedIds.has(m.id) || loadedIds.has(m.name)).length +
        (node.children ?? []).reduce(
          (n: number, c: any) => n + annotate(c).loadedCount, 0),
      machines: node.machines.map((m: any) => ({ ...m, loaded: loadedIds.has(m.id) || loadedIds.has(m.name) })),
      children: (node.children ?? []).map(annotate),
    });
    res.json({
      machinesDir: scan.machinesDir,
      scannedAt: scan.scannedAt,
      totalMachines: scan.totalMachines,
      engineMachineCount: engineCount,
      engineReachable,
      tree: scan.tree.map(annotate),
    });
  } catch (error: any) { upstreamError(res, error, 'corpusTree'); }
});

app.post('/api/corpus/load', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const nodeKeys: string[] = Array.isArray(body.domains) ? body.domains.map(String) : [];
  const machineIds: string[] = Array.isArray(body.machineIds) ? body.machineIds.map(String) : [];
  if (nodeKeys.length === 0 && machineIds.length === 0) {
    res.status(400).json({ error: 'domains (tree node keys) or machineIds required' });
    return;
  }
  try {
    const scan = scanCorpus(MACHINES_DIR);
    const selection = resolveSelection(scan, nodeKeys, machineIds);
    if (selection.length === 0) {
      res.status(404).json({ error: 'selection matched no corpus machines' });
      return;
    }
    // Loads target the active engine; --all-engines is an explicit opt-in
    // that repeats the load against every registry instance (Manager#31
    // Phase 4 guardrail: never implicit).
    const targets: Array<{ id: string; re_url: string }> =
      body.allEngines === true && engineInstances.length > 0
        ? engineInstances.map(i => ({ id: i.id, re_url: i.re_url }))
        : [{ id: activeEngineId ?? 'active', re_url: activeReUrl() }];

    const perEngine: Array<Record<string, unknown>> = [];
    let results: Awaited<ReturnType<typeof loadMachines>> = [];
    for (const t of targets) {
      const r = await axios.get(`${t.re_url}/api/machines`);
      const machines: any[] = Array.isArray(r.data?.machines) ? r.data.machines : [];
      const existing = new Set<string>();
      for (const m of machines) {
        if (m.id) existing.add(String(m.id));
        if (m.name) existing.add(String(m.name));
      }
      const engineResults = await loadMachines(
        selection,
        existing,
        async raw => {
          await axios.post(`${t.re_url}/api/machines`, raw, {
            headers: { 'Content-Type': 'application/json' },
          });
        },
        body.replace === true,
      );
      perEngine.push({
        engine: t.id,
        re_url: t.re_url,
        loaded: engineResults.filter(x => x.status === 'loaded').length,
        skipped: engineResults.filter(x => x.status === 'skipped').length,
        failed: engineResults.filter(x => x.status === 'failed').length,
      });
      results = engineResults; // active/last engine's detail records
    }
    const reUrl = targets[targets.length - 1].re_url;

    let peBootstrap: unknown = null;
    if (body.bootstrapPeSources === true) {
      try {
        const r = await axios.post(`${activePeUrl()}/api/sources/bootstrap-from-machines`, {});
        peBootstrap = r.data;
      } catch (e: any) {
        peBootstrap = { error: String(e?.message ?? e).slice(0, 200) };
      }
    }

    responseCache.delete('machines:list');
    const summary = {
      loaded: results.filter(r => r.status === 'loaded').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
    };
    logAuditEvent(auditConfig, 'corpus-load', {
      engine: reUrl, ...summary, domains: nodeKeys, machineIds: machineIds.length,
    });
    res.json({ engine: reUrl, ...summary, results, engines: perEngine, peBootstrap });
  } catch (error: any) { upstreamError(res, error, 'corpusLoad'); }
});

app.get('/api/machines', rateLimit(MACHINES_RATE_LIMIT_MAX, 'machines'), async (req: Request, res: Response) => {
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
