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
const REALITY_ENGINE_URL = process.env.REALITY_ENGINE_URL || 'http://localhost:3000';
// Comma-separated list of allowed browser origins (no trailing slash).
const ALLOWED_ORIGINS: string[] = (
  process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,https://localhost:5173,http://localhost:3001,https://localhost:3001'
).split(',').map(o => o.trim()).filter(Boolean);
const certPath = process.env.TLS_CERT_PATH;
const keyPath  = process.env.TLS_KEY_PATH;
const tlsEnabled = !!(certPath && keyPath && existsSync(certPath) && existsSync(keyPath));

const app = express();

// ── CORS — restrict to configured origins ────────────────────────────────────
app.use(auditMiddleware(auditConfig));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  }
}));
app.use(express.json({ limit: '10mb' }));

const server = tlsEnabled
  ? https.createServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

// ── Rate limiting (per-IP in-memory token bucket) ─────────────────────────────
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
    if (bucket.count >= max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    bucket.count++;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(ip);
  }
}, 5 * 60_000);

app.use(rateLimit(200));

// ── Input validation helpers ──────────────────────────────────────────────────

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function upstreamError(res: Response, error: any, context: string): void {
  const status: number = (error.response?.status as number | undefined) ?? 500;
  console.error(`[${context}] upstream error (${status}):`, error.message);
  if (status === 404) {
    res.status(404).json({ error: 'Not found' });
  } else if (status >= 400 && status < 500) {
    res.status(status).json({ error: 'Bad request' });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Cache — short-TTL, size-bounded, O(1) group invalidation ─────────────────
const CACHE_TTL_MS = 500;
const CACHE_MAX    = 200;
interface CacheEntry { data: any; ts: number }
const responseCache = new Map<string, CacheEntry>();
const cacheIndex = new Map<string, Set<string>>();

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
    if (oldest !== undefined) {
      responseCache.delete(oldest);
      for (const group of cacheIndex.values()) group.delete(oldest);
    }
  }
  responseCache.set(key, { data, ts: Date.now() });
  let pos = 0;
  while (true) {
    const idx = key.indexOf(':', pos);
    if (idx < 0) break;
    const prefix = key.slice(0, idx + 1);
    let group = cacheIndex.get(prefix);
    if (!group) { group = new Set(); cacheIndex.set(prefix, group); }
    group.add(key);
    pos = idx + 1;
  }
}

function invalidateGroup(prefix: string): void {
  const group = cacheIndex.get(prefix);
  if (!group) return;
  for (const key of group) responseCache.delete(key);
  cacheIndex.delete(prefix);
}

setInterval(() => {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [key, entry] of responseCache) {
    if (entry.ts < cutoff) {
      responseCache.delete(key);
      for (const group of cacheIndex.values()) group.delete(key);
    }
  }
}, CACHE_TTL_MS * 4);

// ── Concurrency-limited Promise.all ──────────────────────────────────────────
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── Shared sequence→graph transform ──────────────────────────────────────────

function transformSequenceToGraph(sequence: any): any {
  const nodes: any[] = [];
  const edges: any[] = [];
  (sequence.vectors || []).forEach((vector: any) => {
    nodes.push({
      id: vector.id,
      label: `V-${vector.id.substring(0, 8)}`,
      isInitial: vector.isInitial,
      isActive: vector.isActive || vector.state === 'ACTIVE',
      hasOutput: vector.outputVectors && vector.outputVectors.length > 0,
      wasJustMatched: vector.wasJustMatched || false,
      lastOutputVector: vector.lastOutputVector || null,
      elements: vector.elements,
      metadata: vector.metadata,
      outputVectors: vector.outputVectors || []
    });
    (vector.nextVectorIds || []).forEach((targetId: string) => {
      edges.push({ id: `${vector.id}-${targetId}`, source: vector.id, target: targetId });
    });
  });
  return {
    sequenceId: sequence.id,
    sequenceName: sequence.name,
    metadata: sequence.metadata,
    nodes,
    edges,
    stats: {
      totalVectors: nodes.length,
      activeVectors: nodes.filter((n: any) => n.isActive).length,
      initialVectors: nodes.filter((n: any) => n.isInitial).length,
      outputVectors: nodes.filter((n: any) => n.hasOutput).length
    }
  };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const clients = new Set<any>();
const pendingPong = new Set<any>();
const HEARTBEAT_INTERVAL = 30000;

wss.on('connection', (ws: WebSocket, req) => {
  const origin = (req as any).headers?.origin as string | undefined;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  console.log('WebSocket client connected');
  clients.add(ws);
  ws.on('pong', () => { pendingPong.delete(ws); });
  ws.on('close', () => { console.log('WebSocket client disconnected'); pendingPong.delete(ws); clients.delete(ws); });
  ws.on('error', (error) => { console.error('WebSocket error:', error); pendingPong.delete(ws); clients.delete(ws); });
});

const heartbeatInterval = setInterval(() => {
  for (const ws of pendingPong) { console.log('Terminating stale WebSocket connection'); clients.delete(ws); ws.terminate(); }
  pendingPong.clear();
  for (const ws of clients) { pendingPong.add(ws); ws.ping(); }
}, HEARTBEAT_INTERVAL);

// All WS fan-out is non-blocking: ws.send() queues to the socket buffer.
// Wrapping calls in setImmediate ensures the HTTP response is flushed first,
// decoupling broadcast latency from the request/response critical path.
function broadcast(data: any): void {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', service: 'reality-engine-visualizer', timestamp: Date.now() });
});

// ── RE step-stream subscriber ─────────────────────────────────────────────────
// The Visualizer Backend subscribes to the Reality Engine's SSE endpoint and
// fans out each step to connected frontend WebSocket clients.  This makes the
// VB a fully passive observer: it never sits in the PE→RE critical path and
// automatically skips ahead when it falls behind (RE uses dropHead buffering).
//
// Reconnect handling: a single in-flight reconnect timer is tracked so that
// overlapping error/close/end callbacks don't schedule multiple reconnects in
// parallel (which would otherwise cascade into an unbounded retry storm).

let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(reason: string, delayMs: number): void {
  if (reconnectTimer) return;
  console.warn(`[SSE] ${reason}, reconnecting in ${Math.round(delayMs / 1000)} s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToREStream();
  }, delayMs);
}

function connectToREStream(): void {
  const reUrl = new URL(`${REALITY_ENGINE_URL}/api/engine/stream`);
  const transport = reUrl.protocol === 'https:' ? https : http;

  // Load the internal CA so the self-signed Reality Engine cert is trusted.
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  const reqOpts: http.RequestOptions = {
    hostname: reUrl.hostname,
    port: reUrl.port ? parseInt(reUrl.port, 10) : (reUrl.protocol === 'https:' ? 443 : 80),
    path: reUrl.pathname,
    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    // Long-lived stream — disable any default request timeouts.
    timeout: 0,
    ...(reUrl.protocol === 'https:' && caPath && existsSync(caPath)
      ? { ca: readFileSync(caPath) }
      : {}),
  };

  const req = transport.get(
    reqOpts,
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleReconnect(`RE stream returned ${res.statusCode}`, 3000);
        return;
      }
      console.log('[SSE] Connected to Reality Engine step stream');
      // Heartbeat tracking — RE sends a comment line every 15 s; if we go
      // 45 s without any bytes, treat the connection as stale and reconnect.
      let lastByteAt = Date.now();
      const stallCheck = setInterval(() => {
        if (Date.now() - lastByteAt > 45_000) {
          clearInterval(stallCheck);
          req.destroy(new Error('stalled — no heartbeat for 45 s'));
        }
      }, 15_000);

      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        lastByteAt = Date.now();
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;       // skip heartbeats and other comment lines
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
      res.on('end', () => {
        clearInterval(stallCheck);
        scheduleReconnect('RE stream closed', 2000);
      });
      res.on('error', (e: Error) => {
        clearInterval(stallCheck);
        scheduleReconnect(`RE stream error: ${e.message}`, 2000);
      });
    }
  );

  // Disable socket-level idle timeout (long-lived stream).
  req.setTimeout(0);

  req.on('error', (e: Error) => {
    scheduleReconnect(`RE connection failed: ${e.message}`, 3000);
  });

  req.end();
}

// ── Legacy direct-perceive path ───────────────────────────────────────────────
// Retained for backward-compatibility (e.g. manual curl calls).  In production
// the PE calls RE directly and RE pushes steps to the VB via SSE.  Responses
// are sent before the WS broadcast so the caller is never blocked by fan-out.
app.post('/api/perceive', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceive`, req.body);
    const step = response.data;
    res.json({ success: true, step });
    if (step && typeof step.stepNumber === 'number') {
      setImmediate(() => broadcast({
        type: 'perceptual-simulation-stepped',
        step,
        data: { activeMachineIds: Object.keys(step.machineResults ?? {}) },
        timestamp: Date.now()
      }));
    }
  } catch (error: any) {
    upstreamError(res, error, 'perceive');
  }
});

// Log ingestion
app.post('/api/logs/ingest', async (req: Request, res: Response) => {
  try {
    const { logs } = req.body;
    if (!logs || !Array.isArray(logs)) {
      return res.status(400).json({ error: 'Invalid logs format. Expected { logs: [...] }' });
    }
    const streams = logs.map((log: any) => ({
      stream: {
        app: 'reality-engine', service: 'visualizer-frontend', environment: 'production',
        log_type: log.type || 'perceptual-sequence', log_level: log.level || 'info',
        queue_type: log.data?.queueType || 'unknown'
      },
      values: [[
        `${log.timestamp * 1000000}`,
        JSON.stringify({ message: log.message, level: log.level, type: log.type, ...log.data })
      ]]
    }));
    const lokiUrl = process.env.LOKI_URL || 'http://loki:3100';
    await axios.post(`${lokiUrl}/loki/api/v1/push`, { streams });
    res.json({ success: true, logsIngested: logs.length });
  } catch (error: any) {
    console.error('Error ingesting logs to Loki:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sequence graph endpoints
app.get('/api/viz/sequences', async (_req: Request, res: Response) => {
  const cached = getCached('viz:sequences');
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/sequences`);
    const graphData = { sequences: (response.data.sequences || []).map(transformSequenceToGraph) };
    setCached('viz:sequences', graphData);
    res.json(graphData);
  } catch (error: any) { upstreamError(res, error, 'getSequences'); }
});

app.get('/api/viz/sequences/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const cacheKey = `viz:sequences:${id}`;
  const cached = getCached(cacheKey);
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/sequences/${id}`);
    const graphData = transformSequenceToGraph(response.data.sequence);
    setCached(cacheKey, graphData);
    res.json(graphData);
  } catch (error: any) { upstreamError(res, error, 'getSequence'); }
});

// Demo endpoints — respond first, broadcast change notification asynchronously
app.get('/api/demo/data-center', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/demo/data-center`);
    invalidateGroup('machines:'); invalidateGroup('viz:sequences'); responseCache.delete('machine-graph');
    res.json(response.data);
    setImmediate(() => broadcast({ type: 'demo-loaded', metadata: response.data.metadata, timestamp: Date.now() }));
  } catch (error: any) { upstreamError(res, error, 'loadDataCenterDemo'); }
});

app.get('/api/demo/multi-step', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/demo/multi-step`);
    invalidateGroup('machines:'); invalidateGroup('viz:sequences'); responseCache.delete('machine-graph');
    res.json(response.data);
    setImmediate(() => broadcast({ type: 'demo-loaded', metadata: response.data.metadata, machine: response.data.machine, timestamp: Date.now() }));
  } catch (error: any) { upstreamError(res, error, 'loadMultiStepDemo'); }
});

app.get('/api/demo/kleene-star', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/demo/kleene-star`);
    invalidateGroup('machines:'); invalidateGroup('viz:sequences'); responseCache.delete('machine-graph');
    res.json(response.data);
    setImmediate(() => broadcast({ type: 'demo-loaded', metadata: response.data.metadata, machine: response.data.machine, timestamp: Date.now() }));
  } catch (error: any) { upstreamError(res, error, 'loadKleeneStarDemo'); }
});

// ── Machine management ────────────────────────────────────────────────────────

app.get('/api/machines/json/list', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/machines/json/list`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'listMachineJSONFiles'); }
});

app.get('/api/machines/json/:name', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidId(name)) { res.status(400).json({ error: 'Invalid name' }); return; }
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/machines/json/${name}`);
    invalidateGroup('machines:');
    res.json(response.data);
    setImmediate(() => broadcast({ type: 'machine-loaded', machine: response.data.machine, timestamp: Date.now() }));
  } catch (error: any) { upstreamError(res, error, 'loadMachineFromJSON'); }
});

app.post('/api/machines/json/import', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/machines/json/import`, req.body);
    invalidateGroup('machines:');
    res.json(response.data);
    setImmediate(() => broadcast({ type: 'machine-imported', machine: response.data.machine, timestamp: Date.now() }));
  } catch (error: any) { upstreamError(res, error, 'importMachineJSON'); }
});

app.get('/api/machines/:id/export', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const pretty = req.query.pretty === 'false' ? 'false' : 'true';
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/machines/${id}/export?pretty=${pretty}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', response.headers['content-disposition'] || 'attachment; filename="machine.json"');
    res.send(response.data);
  } catch (error: any) { upstreamError(res, error, 'exportMachine'); }
});

app.get('/api/machines', rateLimit(120), async (req: Request, res: Response) => {
  if (req.query.expand === 'sequences') {
    const cacheKey = 'machines:expanded';
    const cached = getCached(cacheKey);
    if (cached) { res.json(cached); return; }
    try {
      const machinesResp = await axios.get(`${REALITY_ENGINE_URL}/api/machines`);
      const machines: any[] = machinesResp.data.machines ?? [];
      const expanded = await pooled(
        machines.map((m: any) => async () => {
          try {
            const detailResp = await axios.get(`${REALITY_ENGINE_URL}/api/machines/${m.id}`);
            const machine = detailResp.data.machine ?? detailResp.data;
            const sequenceIds: string[] = machine.sequenceIds ?? [];
            const sequences = await pooled(
              sequenceIds.map((seqId: string) => async () => {
                try {
                  const seqResp = await axios.get(`${REALITY_ENGINE_URL}/api/sequences/${seqId}`);
                  return transformSequenceToGraph(seqResp.data.sequence ?? seqResp.data);
                } catch { return null; }
              }),
              8
            );
            return { id: machine.id, name: machine.name, description: machine.description ?? '', metadata: machine.metadata ?? {}, isExample: machine.isExample ?? false, perceptualMapping: machine.perceptualMapping ?? null, sequences: sequences.filter(Boolean) };
          } catch {
            return { id: m.id, name: m.name, description: m.description ?? '', metadata: m.metadata ?? {}, isExample: m.isExample ?? false, sequences: [] };
          }
        }),
        8
      );
      const result = { machines: expanded };
      setCached(cacheKey, result);
      res.json(result);
    } catch (error: any) { upstreamError(res, error, 'getMachinesExpanded'); }
    return;
  }
  const cacheKey = 'machines:list';
  const cached = getCached(cacheKey);
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/machines`);
    setCached(cacheKey, response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMachines'); }
});

app.get('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const cacheKey = `machines:${id}`;
  const cached = getCached(cacheKey);
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/machines/${id}`);
    setCached(cacheKey, response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMachine'); }
});

app.post('/api/machines', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/machines`, req.body);
    invalidateGroup('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'createMachine'); }
});

app.patch('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const response = await axios.patch(`${REALITY_ENGINE_URL}/api/machines/${id}`, req.body);
    invalidateGroup('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'patchMachine'); }
});

app.put('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const response = await axios.put(`${REALITY_ENGINE_URL}/api/machines/${id}`, req.body);
    invalidateGroup('machines:');
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'putMachine'); }
});

app.delete('/api/machines/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidId(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    await axios.delete(`${REALITY_ENGINE_URL}/api/machines/${id}`);
    invalidateGroup('machines:');
    res.json({ success: true });
  } catch (error: any) { upstreamError(res, error, 'deleteMachine'); }
});

// ── Simulation endpoints ──────────────────────────────────────────────────────

app.get('/api/machine-graph', async (_req: Request, res: Response) => {
  const cached = getCached('machine-graph');
  if (cached) { res.json(cached); return; }
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/machine-graph`);
    setCached('machine-graph', response.data);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMachineGraph'); }
});

app.post('/api/perceptual-simulation/configure/chunk', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceptual-simulation/configure/chunk`, req.body, { maxContentLength: Infinity, maxBodyLength: Infinity });
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'appendChunk'); }
});

app.post('/api/perceptual-simulation/configure/commit', async (_req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceptual-simulation/configure/commit`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'commitConfig'); }
});

app.post('/api/perceptual-simulation/start', async (_req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceptual-simulation/start`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'startSimulation'); }
});

app.post('/api/perceptual-simulation/stop', async (_req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceptual-simulation/stop`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'stopSimulation'); }
});

// Manual step — respond before broadcasting so the UI button isn't blocked by fan-out.
app.post('/api/perceptual-simulation/step', async (_req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceptual-simulation/step`);
    res.json(response.data);
    if (response.data.success && response.data.step) {
      const step = response.data.step;
      setImmediate(() => broadcast({
        type: 'perceptual-simulation-stepped',
        step,
        data: { activeMachineIds: Object.keys(step.machineResults ?? {}) },
        timestamp: Date.now()
      }));
    }
  } catch (error: any) { upstreamError(res, error, 'stepSimulation'); }
});

// Reset — respond before broadcasting.
app.post('/api/perceptual-simulation/reset', async (_req: Request, res: Response) => {
  try {
    const response = await axios.post(`${REALITY_ENGINE_URL}/api/perceptual-simulation/reset`);
    res.json(response.data);
    setImmediate(() => broadcast({ type: 'perceptual-simulation-reset', timestamp: Date.now() }));
  } catch (error: any) { upstreamError(res, error, 'resetSimulation'); }
});

app.get('/api/perceptual-simulation/state', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/perceptual-simulation/state`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getSimulationState'); }
});

app.get('/api/perceptual-simulation/history', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/perceptual-simulation/history`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getSimulationHistory'); }
});

// ── Universe monitor / control surface ───────────────────────────────────────
//
// Reads the RE /api/metrics Prometheus text and extracts the most recent
// paging decisions per (machine, sequence, ownerTeam, ragStatusCode).  The
// frontend doesn't have to parse Prom text directly — this endpoint returns
// JSON with a derived ordering by counter magnitude (most-active first).
app.get('/api/viz/paging-decisions', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${REALITY_ENGINE_URL}/api/metrics`, {
      responseType: 'text',
      transformResponse: [data => data],   // skip axios auto-JSON parse
    });
    const text: string = response.data;
    const decisions: Array<{
      runtime: string;
      ownerTeam: string;
      processStatus: string;
      ragStatusCode: string;
      machineId: string;
      count: number;
    }> = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('ces_paging_decisions_total{')) continue;
      // ces_paging_decisions_total{owner_team="...",process_status="...",rag_status_code="...",machine_id="...",runtime="ai"} 42
      const m = line.match(/^ces_paging_decisions_total\{([^}]+)\}\s+(\d+(?:\.\d+)?)/);
      if (!m) continue;
      const labels: Record<string, string> = {};
      for (const kv of m[1].split(',')) {
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1).replace(/^"/, '').replace(/"$/, '').replace(/\\"/g, '"');
        labels[k] = v;
      }
      decisions.push({
        runtime:        labels.runtime ?? 'unknown',
        ownerTeam:      labels.owner_team ?? 'unrouted',
        processStatus:  labels.process_status ?? 'unknown',
        ragStatusCode:  labels.rag_status_code ?? 'unknown',
        machineId:      labels.machine_id ?? '',
        count:          Number(m[2]),
      });
    }
    decisions.sort((a, b) => b.count - a.count);
    res.json({ decisions, total: decisions.length });
  } catch (error: any) { upstreamError(res, error, 'getPagingDecisions'); }
});

// ── PE backend proxy (MQTT + sensor freshness) ──────────────────────────────
//
// The visualizer's frontend already hits perception-engine-backend through
// nginx in container deployments, but for dev outside containers the same
// routes need to work through the visualizer-backend's host.  These passthroughs
// keep the frontend's PE_BASE_URL consistent regardless of deployment mode.
const PERCEPTION_ENGINE_URL = process.env.PERCEPTION_ENGINE_URL || 'http://localhost:3004';
app.get('/api/perception/mqtt/status', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${PERCEPTION_ENGINE_URL}/api/mqtt/status`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMqttStatus'); }
});
app.get('/api/perception/mqtt/mappings', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${PERCEPTION_ENGINE_URL}/api/mqtt/mappings`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getMqttMappings'); }
});
// Mapping-editor control surface — proxies the PE's PUT.  Body shape is
// the same { defaults?, mappings: [...] } registry contract that
// MappingRegistry.fromJson accepts.  Returns warnings on overlap.
app.put('/api/perception/mqtt/mappings', async (req: Request, res: Response) => {
  try {
    const response = await axios.put(`${PERCEPTION_ENGINE_URL}/api/mqtt/mappings`, req.body);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'putMqttMappings'); }
});
app.get('/api/perception/sources', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${PERCEPTION_ENGINE_URL}/api/sources`);
    res.json(response.data);
  } catch (error: any) { upstreamError(res, error, 'getPerceptionSources'); }
});

// ── PE WebSocket subscription (forward mqtt-ingest events) ──────────────────
//
// The PE backend emits per-message `mqtt-ingest` events on its own /ws when
// the MQTT bridge accepts a PUBLISH.  We subscribe as a WS client and
// forward those events to our own clients so the visualizer's universe
// monitor can render a live ingest stream without polling.  Reconnects on
// drop (same shape as connectToREStream).

let peWs: WebSocket | null = null;
let peWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
function connectToPEStream(): void {
  const peWsUrl = (PERCEPTION_ENGINE_URL.replace(/^http/, 'ws')) + '/ws';
  try {
    peWs = new WebSocket(peWsUrl);
  } catch (e: any) {
    console.error(`[PE WS] connect failed: ${e?.message ?? e}`);
    schedulePEReconnect(3000);
    return;
  }
  peWs.on('open',  () => { console.log(`[PE WS] connected to ${peWsUrl}`); });
  peWs.on('error', (err: Error) => { console.error(`[PE WS] error: ${err.message}`); });
  peWs.on('close', () => { console.log('[PE WS] closed'); schedulePEReconnect(3000); });
  peWs.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      // Forward MQTT-related events; ignore PE state updates (we don't
      // want to duplicate the existing RE-SSE → VB-WS pipe here).
      if (msg && (msg.type === 'mqtt-ingest' || msg.type === 'mqtt-status' || msg.type === 'mqtt-mappings-reloaded')) {
        broadcast(msg);
      }
    } catch { /* ignore malformed PE events */ }
  });
}
function schedulePEReconnect(delayMs: number): void {
  if (peWsReconnectTimer) return;
  peWsReconnectTimer = setTimeout(() => { peWsReconnectTimer = null; connectToPEStream(); }, delayMs);
}

// ── Start server ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const protocol = tlsEnabled ? 'https' : 'http';
  const wsProtocol = tlsEnabled ? 'wss' : 'ws';
  console.log(`Reality Engine Visualizer Backend running on port ${PORT} (${protocol.toUpperCase()})`);
  console.log(`WebSocket server available at ${wsProtocol}://localhost:${PORT}/ws`);
  console.log(`Proxying to Reality Engine at ${REALITY_ENGINE_URL}`);
  console.log(`Perception Engine WS source: ${PERCEPTION_ENGINE_URL}/ws`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  logAuditEvent(auditConfig, 'startup', {
    audit_enabled: auditConfig.enabled,
    audit_level:   auditConfig.level,
    port:          PORT,
  });
  // Subscribe to RE's SSE step stream — VB is a passive observer of the PE.x.RE.x.PE cycle.
  connectToREStream();
  // Subscribe to PE's WS — forwards mqtt-ingest events to VB clients.
  connectToPEStream();
});

process.on('SIGTERM', () => { console.log('SIGTERM received, shutting down gracefully...'); clearInterval(heartbeatInterval); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { console.log('SIGINT received, shutting down gracefully...');  clearInterval(heartbeatInterval); server.close(() => process.exit(0)); });
