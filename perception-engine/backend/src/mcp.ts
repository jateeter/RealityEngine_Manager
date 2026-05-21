/**
 * MCP (Model Context Protocol) server for the Perception Engine.
 *
 * Exposes all current services as MCP tools and resources via a
 * session-managed Streamable HTTP transport mounted at /mcp:
 *
 *   POST   /mcp  — initialize session or dispatch JSON-RPC request
 *   GET    /mcp  — SSE stream for an existing session (notifications)
 *   DELETE /mcp  — close session
 *
 * Perception Engine tools operate in-process (direct engine access).
 * Reality Engine tools proxy over HTTP to REALITY_ENGINE_URL.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import type { Express } from 'express';
import type { PerceptionEngine } from './PerceptionEngine.js';
import type { SourceStore } from './SourceStore.js';
import type {
  PushResult, MatchAlgorithm,
  SimulatedSourceConfig, SensorSourceConfig, TestSourceConfig,
} from './types.js';
import type { Dispatcher } from './triggers/Dispatcher.js';
import type { Ledger } from './dispatch/Ledger.js';
import {
  checkPolicy, loadPolicyFromEnv, policyErrorResult,
  type PolicyConfig,
} from './mcpPolicy.js';

// ── Dependency interface ──────────────────────────────────────────────────

export interface McpDeps {
  engine: PerceptionEngine;
  store: SourceStore;
  /** Push assembled vector to Reality Engine and broadcast the result. */
  push: () => Promise<PushResult>;
  startAuto: (ms: number) => void;
  stopAuto: () => void;
  getAutoState: () => { running: boolean; intervalMs: number };
  getLastPush: () => number | null;
  /** Persist sources to disk and broadcast state-update to WS clients. */
  saveAndBroadcast: () => Promise<void>;
  /** engine.reset() + clear lastPush + broadcast state-update. */
  resetAndBroadcast: () => void;
  realityEngineUrl: string;
  /** Optional axios instance for outbound RE calls.  Pre-configured with
   *  a CA-aware https.Agent in TLS deployments — passing this in lets
   *  the PE→RE proxy tools validate the self-signed dev cert instead of
   *  erroring on every step.  Defaults to a fresh axios. */
  httpClient?: AxiosInstance;
  /** Trigger dispatcher — wires `trigger.replay`. */
  dispatcher?: Dispatcher;
  /** Dispatch ledger — wires `dispatch.read_ledger` and feeds `trigger.replay`. */
  ledger?: Ledger;
  /** Policy config; defaults to loadPolicyFromEnv(). */
  policy?: PolicyConfig;
}

// ── MCP server factory (one per session) ─────────────────────────────────

function buildMcpServer(deps: McpDeps): McpServer {
  const {
    engine, store, push, startAuto, stopAuto,
    getAutoState, getLastPush, saveAndBroadcast, resetAndBroadcast,
    realityEngineUrl, httpClient, dispatcher, ledger,
  } = deps;
  const http = httpClient ?? axios;
  const policy = deps.policy ?? loadPolicyFromEnv();

  const vectorSize = engine.vectorSize;

  // Region schema built dynamically so max values reflect the actual vector size.
  const regionSchema = {
    region_offset: z
      .number().int().min(0).max(vectorSize - 1)
      .describe(`Starting offset in the ${vectorSize}-cell perceptual vector`),
    region_length: z
      .number().int().min(1).max(vectorSize)
      .describe('Number of cells this source occupies'),
  };

  const server = new McpServer({
    name: 'reality-engine-perception',
    version: '1.0.0',
  });

  /** Convenience: prefix a Reality Engine API path. */
  const re = (path: string) => `${realityEngineUrl}/api${path}`;

  /** Wrap an async Reality Engine call with a standardised error response. */
  async function reCall(fn: () => Promise<unknown>) {
    try {
      const data = await fn();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err: any) {
      const message = err.response?.data?.error ?? err.message;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  // ── Resources ─────────────────────────────────────────────────────────

  server.resource(
    'perception-state',
    'perception://state',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(engine.getState(getLastPush(), getAutoState()), null, 2),
      }],
    }),
  );

  server.resource(
    'perception-sources',
    'perception://sources',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(engine.getSources(), null, 2),
      }],
    }),
  );

  server.resource(
    'perception-vector',
    'perception://vector',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(engine.assembleVector(), null, 2),
      }],
    }),
  );

  // ── Perception Engine — engine control ────────────────────────────────

  server.tool(
    'perception_get_state',
    `Return the full perception engine state: sources, assembled ${vectorSize}-cell vector, ` +
    'auto-push status, match algorithm, global step counter, and last push timestamp.',
    {},
    async () => {
      const state = engine.getState(getLastPush(), getAutoState());
      return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }] };
    },
  );

  server.tool(
    'perception_push',
    'Assemble the current perceptual vector from all active sources and push it to ' +
    'the Reality Engine for CES pattern matching. Returns the step result including ' +
    'which machines fired.',
    {},
    async () => {
      const result = await push();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'perception_start_auto',
    'Start automatic periodic pushing of the perceptual vector to the Reality Engine.',
    {
      interval_ms: z.number().int().min(100).max(60000).default(1000)
        .describe('Push interval in milliseconds (100–60000)'),
    },
    async ({ interval_ms }) => {
      startAuto(interval_ms);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, intervalMs: interval_ms }) }] };
    },
  );

  server.tool(
    'perception_stop_auto',
    'Stop automatic periodic pushing.',
    {},
    async () => {
      stopAuto();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
    },
  );

  server.tool(
    'perception_reset',
    'Reset the engine global step counter to 0 and restore all test sources to step 0 ' +
    '(re-activating any that were exhausted).',
    {},
    async () => {
      resetAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, globalStep: engine.globalStep }) }] };
    },
  );

  server.tool(
    'perception_set_match_algorithm',
    'Set the match algorithm used when pushing vectors to the Reality Engine.\n' +
    '  "gte"    — fire when input value >= CES threshold (default)\n' +
    '  "equals" — fire only on exact value match',
    {
      algorithm: z.enum(['gte', 'equals']),
    },
    async ({ algorithm }) => {
      engine.setMatchAlgorithm(algorithm as MatchAlgorithm);
      await saveAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, matchAlgorithm: algorithm }) }] };
    },
  );

  // ── Perception Engine — source management ─────────────────────────────

  server.tool(
    'sources_list',
    'List all perception sources registered with the engine, including their type, ' +
    'region, active status, and type-specific configuration.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(engine.getSources(), null, 2) }],
    }),
  );

  server.tool(
    'sources_add_simulated',
    `Add a simulated waveform source that generates synthetic signal patterns and ` +
    `writes them into a region of the ${vectorSize}-cell perceptual vector on every push.`,
    {
      name: z.string().describe('Human-readable source name'),
      ...regionSchema,
      active: z.boolean().optional().default(true),
      pattern: z.enum([
        'sine', 'sawtooth', 'square', 'linear-ramp',
        'constant', 'random-walk', 'gaussian-noise', 'binary',
      ]).describe('Waveform pattern'),
      frequency: z.number().min(0).default(1.0)
        .describe('Oscillation frequency in Hz (ignored for constant/binary)'),
      amplitude: z.number().min(0).max(1).default(0.5)
        .describe('Signal amplitude [0, 1]'),
      dc_offset: z.number().min(0).max(1).default(0.5)
        .describe('DC bias added to the signal [0, 1]'),
    },
    async ({ name, region_offset, region_length, active, pattern, frequency, amplitude, dc_offset }) => {
      const source = engine.addSource({
        type: 'simulated', name, active: active ?? true,
        region: { offset: region_offset, length: region_length },
        pattern, frequency, amplitude, dcOffset: dc_offset,
      } as Omit<SimulatedSourceConfig, 'id'>);
      await saveAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify(source, null, 2) }] };
    },
  );

  server.tool(
    'sources_add_sensor',
    'Add an HTTP-push sensor source. External systems push live values via ' +
    'POST /api/sensors/:sensorId { values: number[] }. Values expire after ttl_ms.',
    {
      name: z.string().describe('Human-readable source name'),
      sensor_id: z.string().describe('Unique sensor identifier (used in POST /api/sensors/:sensorId)'),
      ...regionSchema,
      active: z.boolean().optional().default(true),
      ttl_ms: z.number().int().min(100).default(30000)
        .describe('Time-to-live for pushed values in milliseconds'),
    },
    async ({ name, sensor_id, region_offset, region_length, active, ttl_ms }) => {
      const source = engine.addSource({
        type: 'sensor', name, active: active ?? true,
        region: { offset: region_offset, length: region_length },
        sensorId: sensor_id, lastValue: [], lastUpdated: null, ttlMs: ttl_ms,
      } as Omit<SensorSourceConfig, 'id'>);
      await saveAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify(source, null, 2) }] };
    },
  );

  server.tool(
    'sources_add_test',
    'Add a test sequence source that replays a fixed array of input vectors step-by-step. ' +
    'Use machines_list to browse available machine sequences.',
    {
      name: z.string().describe('Human-readable source name'),
      machine_id: z.string().describe('ID of the machine this test sequence belongs to'),
      machine_name: z.string().describe('Display name of the machine'),
      sequence_name: z.string().describe('Name of the input sequence within the machine'),
      inputs: z.array(z.array(z.number().min(0).max(1)))
        .describe('Ordered input vectors — each an array of floats [0, 1]'),
      ...regionSchema,
      active: z.boolean().optional().default(true),
      loop: z.boolean().optional().default(false)
        .describe('Loop sequence from the beginning after it is exhausted'),
    },
    async ({ name, machine_id, machine_name, sequence_name, inputs, region_offset, region_length, active, loop }) => {
      const source = engine.addSource({
        type: 'test', name, active: active ?? true,
        region: { offset: region_offset, length: region_length },
        machineId: machine_id, machineName: machine_name,
        sequenceName: sequence_name, inputs, loop: loop ?? false,
      } as Omit<TestSourceConfig, 'id'>);
      await saveAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify(source, null, 2) }] };
    },
  );

  server.tool(
    'sources_update',
    'Update the name or active state of an existing source. ' +
    'To change structural properties (region, pattern, etc.) delete and re-add the source.',
    {
      id: z.string().describe('Source ID — obtain from sources_list'),
      name: z.string().optional().describe('New display name'),
      active: z.boolean().optional().describe('Enable or disable the source'),
    },
    async ({ id, name, active }) => {
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch['name'] = name;
      if (active !== undefined) patch['active'] = active;

      const source = engine.updateSource(id, patch as any);
      if (!source) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Source not found: ${id}` }) }],
          isError: true,
        };
      }
      await saveAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify(source, null, 2) }] };
    },
  );

  server.tool(
    'sources_delete',
    'Delete a source by ID. Also removes it from persistent storage.',
    {
      id: z.string().describe('Source ID — obtain from sources_list'),
    },
    async ({ id }) => {
      const removed = engine.removeSource(id);
      if (!removed) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Source not found: ${id}` }) }],
          isError: true,
        };
      }
      await saveAndBroadcast();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }] };
    },
  );

  server.tool(
    'sensor_push_value',
    'Push a live value array to a sensor source identified by its sensorId. ' +
    'Values are written into the sensor\'s perceptual region and are valid until the source TTL expires.',
    {
      sensor_id: z.string().describe('The sensorId of the target sensor source'),
      values: z.array(z.number().min(0).max(1))
        .describe('Float values [0, 1] to write into the sensor\'s region'),
    },
    async ({ sensor_id, values }) => {
      const updated = engine.updateSensorValue(sensor_id, values);
      if (!updated) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `No sensor source with sensorId "${sensor_id}"` }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, sensorId: sensor_id, timestamp: Date.now() }) }],
      };
    },
  );

  // ── Reality Engine — health and machine management ────────────────────

  server.tool(
    'reality_engine_health',
    'Check health and stats for the Reality Engine backend.',
    {},
    async () => reCall(async () => {
      const [health, stats] = await Promise.all([
        http.get(re('/health')).then(r => r.data),
        http.get(re('/engine/stats')).then(r => r.data).catch(() => null),
      ]);
      return { health, stats };
    }),
  );

  server.tool(
    'machines_list',
    'List all machines currently loaded in the Reality Engine plus the available ' +
    'machine JSON files on disk.',
    {},
    async () => reCall(async () => {
      const [loaded, jsonFiles] = await Promise.all([
        http.get(re('/machines')).then(r => r.data),
        http.get(re('/machines/json/list')).then(r => r.data),
      ]);
      return { loaded, jsonFiles };
    }),
  );

  server.tool(
    'machines_load_json',
    'Load a machine from a JSON file into the Reality Engine and register it with the perceptual simulator.',
    {
      filename: z.string()
        .describe('Filename from machines_list.jsonFiles (e.g. "RSFlipFlop.json")'),
    },
    async ({ filename }) => reCall(async () => {
      const { data } = await http.get(re(`/machines/json/${encodeURIComponent(filename)}`));
      return data;
    }),
  );

  // ── Reality Engine — perceptual simulation control ────────────────────

  server.tool(
    'perceptual_sim_state',
    'Get the current state of the Reality Engine perceptual simulation: registered ' +
    'machines, perceptual space vector, current step, and running status.',
    {},
    async () => reCall(async () => {
      const { data } = await http.get(re('/perceptual-simulation/state'));
      return data;
    }),
  );

  server.tool(
    'perceptual_sim_step',
    'Advance the Reality Engine perceptual simulation by one step. Returns machine ' +
    'firing results and the updated perceptual space vector.',
    {},
    async () => reCall(async () => {
      const { data } = await http.post(re('/perceptual-simulation/step'));
      return data;
    }),
  );

  server.tool(
    'perceptual_sim_start',
    'Start automatic stepping of the Reality Engine perceptual simulation.',
    {
      step_delay_ms: z.number().int().min(50).default(500)
        .describe('Delay between automatic steps in milliseconds'),
    },
    async ({ step_delay_ms }) => reCall(async () => {
      const { data } = await http.post(re('/perceptual-simulation/start'), { stepDelayMs: step_delay_ms });
      return data;
    }),
  );

  server.tool(
    'perceptual_sim_stop',
    'Stop the automatic stepping of the Reality Engine perceptual simulation.',
    {},
    async () => reCall(async () => {
      const { data } = await http.post(re('/perceptual-simulation/stop'));
      return data;
    }),
  );

  server.tool(
    'perceptual_sim_reset',
    'Reset the Reality Engine perceptual simulation to its initial state.',
    {},
    async () => reCall(async () => {
      const { data } = await http.post(re('/perceptual-simulation/reset'));
      return data;
    }),
  );

  server.tool(
    'perceptual_sim_history',
    'Get the step history of the Reality Engine perceptual simulation.',
    {
      limit: z.number().int().min(1).max(200).optional().default(24)
        .describe('Maximum number of history entries to return'),
    },
    async ({ limit }) => reCall(async () => {
      const { data } = await http.get(re('/perceptual-simulation/history'), { params: { limit } });
      return data;
    }),
  );

  server.tool(
    'demo_load',
    'Load a built-in demonstration configuration into the Reality Engine.',
    {
      demo: z.enum(['data-center', 'multi-step', 'kleene-star'])
        .describe('Which demo to load'),
    },
    async ({ demo }) => reCall(async () => {
      const { data } = await http.get(re(`/demo/${demo}`));
      return data;
    }),
  );

  // ── Dotted-name canonical tools (Phase 5 — architecture-doc surface) ────
  // The legacy snake_case tools above remain as aliases for one minor
  // version so existing consumers keep working.  Mutating tools are gated
  // by `MCP_POLICY_ENFORCE` (see mcpPolicy.ts).

  // re.read_state — alias for perception_get_state.
  server.tool(
    're.read_state',
    'Canonical alias for perception_get_state. Returns full PE state.',
    {},
    async () => {
      const state = engine.getState(getLastPush(), getAutoState());
      return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }] };
    },
  );

  // re.list_machines — alias for machines_list.
  server.tool(
    're.list_machines',
    'Canonical alias for machines_list. Lists machines loaded in RE plus JSON files on disk.',
    {},
    async () => reCall(async () => {
      const [loaded, jsonFiles] = await Promise.all([
        http.get(re('/machines')).then(r => r.data),
        http.get(re('/machines/json/list')).then(r => r.data).catch(() => null),
      ]);
      return { loaded, jsonFiles };
    }),
  );

  // re.read_machine — NEW: read one machine by id (proxy to RE export endpoint).
  server.tool(
    're.read_machine',
    'Read one machine record from the Reality Engine (full JSON: metadata, sequences, perceptualMapping).',
    { machine_id: z.string().describe('Machine id (e.g. machine-agx051-...)') },
    async ({ machine_id }) => reCall(async () => {
      const { data } = await http.get(re(`/machines/${encodeURIComponent(machine_id)}/export`));
      return data;
    }),
  );

  // pe.list_sources — alias for sources_list.
  server.tool(
    'pe.list_sources',
    'Canonical alias for sources_list. Lists all perception sources.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(engine.getSources(), null, 2) }],
    }),
  );

  // pe.push_signal — alias for sensor_push_value (mutating).  The policy
  // check is inlined so the zod-validated arguments stay in scope.
  server.tool(
    'pe.push_signal',
    'Canonical alias for sensor_push_value. Pushes values to a sensor source ' +
    '(policy capability: "sources.write").',
    {
      sensor_id: z.string().describe('The sensorId of the target sensor source'),
      values: z.array(z.number().min(0).max(1)).describe('Float values [0,1] to write'),
    },
    async ({ sensor_id, values }) => {
      const decision = checkPolicy(policy, { mutates: true, capability: 'sources.write' });
      if (!decision.ok) return policyErrorResult(decision);
      const updated = engine.updateSensorValue(sensor_id, values);
      if (!updated) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `No sensor source with sensorId "${sensor_id}"` }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, sensorId: sensor_id, timestamp: Date.now() }) }],
      };
    },
  );

  // pe.enqueue_push — alias for perception_push (mutating).
  server.tool(
    'pe.enqueue_push',
    'Canonical alias for perception_push. Assembles the perceptual vector and pushes ' +
    'it to the Reality Engine (policy capability: "engine.control").',
    {},
    async () => {
      const decision = checkPolicy(policy, { mutates: true, capability: 'engine.control' });
      if (!decision.ok) return policyErrorResult(decision);
      const result = await push();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // dispatch.read_ledger — NEW: read in-process dispatch ledger.
  server.tool(
    'dispatch.read_ledger',
    'Return the current dispatch ledger (full record set in insertion order). ' +
    'Read-only — wire-compatible with GET /api/dispatch/ledger.',
    {
      limit: z.number().int().min(1).max(1000).optional()
        .describe('Optional client-side cap on the number of records returned (newest first when set).'),
    },
    async ({ limit }) => {
      if (!ledger || !dispatcher) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'dispatch ledger not wired into this MCP server' }) }],
          isError: true,
        };
      }
      const status = dispatcher.status();
      let records = ledger.list();
      if (typeof limit === 'number') {
        records = records.slice(-limit);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          enabled: status.enabled, mode: status.mode, records,
        }, null, 2) }],
      };
    },
  );

  // trigger.replay — NEW: re-emit an existing dispatch record's envelope.
  server.tool(
    'trigger.replay',
    'Replay an existing dispatch record by id — appends a new ledger entry with ' +
    'mode:"replay" and replayOf set.  Never mutates PE/RE state; never calls a ' +
    'provider.  Policy capability: "trigger.dispatch".',
    {
      dispatch_id: z.string().describe('Dispatch record id from dispatch.read_ledger.'),
      fresh_ids: z.boolean().optional().default(false)
        .describe('Mint new envelopeId+correlationId.  Default false (same causal chain).'),
    },
    async ({ dispatch_id, fresh_ids }) => {
      const decision = checkPolicy(policy, { mutates: true, capability: 'trigger.dispatch' });
      if (!decision.ok) return policyErrorResult(decision);
      if (!dispatcher) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'trigger dispatcher not wired into this MCP server' }) }],
          isError: true,
        };
      }
      const replayed = dispatcher.replay(dispatch_id, { freshIds: fresh_ids });
      if (!replayed) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Dispatch record not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true, replayOf: dispatch_id, freshIds: fresh_ids === true, record: replayed,
        }, null, 2) }],
      };
    },
  );

  return server;
}

// ── HTTP transport + session management ───────────────────────────────────

/**
 * Mount MCP endpoints on the Express app:
 *   POST   /mcp  — initialize or resume a session, dispatch JSON-RPC
 *   GET    /mcp  — SSE stream for an existing session
 *   DELETE /mcp  — explicitly close a session
 */
export function mountMcp(app: Express, deps: McpDeps): void {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // POST — new session initialization or existing session dispatch
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const mcpServer = buildMcpServer(deps);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET — SSE notification stream for an existing session
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing mcp-session-id header' });
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
  });

  // DELETE — explicit session teardown
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ success: true });
  });
}
