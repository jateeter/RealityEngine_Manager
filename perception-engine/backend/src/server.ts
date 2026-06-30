import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer } from 'http';
import { Agent as HttpsAgent, createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { PerceptionEngine } from './PerceptionEngine.js';
import { SourceStore } from './SourceStore.js';
import { mountMcp } from './mcp.js';
import { MqttBridge, fromEnvironment as mqttFromEnvironment } from './MqttBridge.js';
import type { IngestPayload } from './MqttBridge.js';
import type { SourceConfig, SensorSourceConfig, TestSourceConfig, PushResult, MatchAlgorithm } from './types.js';
import {
  emptyRegistryState,
  integrationStatus,
  loadRegistry,
  resolveRegistryPath,
} from './integrations/Registry.js';
import type { RegistryState } from './integrations/types.js';
import { resolveCompletion } from './integrations/SourceMapper.js';
import type { CompletionRequest, ResolvedSignal } from './integrations/SourceMapper.js';
import { Dispatcher } from './triggers/Dispatcher.js';
import type { MachineRecord } from './triggers/types.js';
import { Ledger } from './dispatch/Ledger.js';
import type { DispatchRecordPatch } from './dispatch/types.js';
import { AdapterPipeline } from './integrations/AdapterPipeline.js';
import { AcpAdapter, acpConfigFromRegistry } from './integrations/adapters/AcpAdapter.js';
import { OllamaAdapter } from './integrations/adapters/OllamaAdapter.js';
import { OpenAIAdapter } from './integrations/adapters/OpenAIAdapter.js';
import type { IntegrationEntry } from './integrations/types.js';
import { applyExtract, applyNormalize } from './integrations/extractors.js';
import type { ExtractSpec, NormalizeSpec } from './integrations/extractors.js';
import {
  resolveHKBatch, checkBridgeAuth,
} from './integrations/adapters/HealthKitBridge.js';
import type { HKBridgePayload } from './integrations/adapters/HealthKitBridge.js';
import {
  resolveCKBatch, checkCareKitAuth, buildCKStatusBody,
} from './integrations/adapters/CareKitBridge.js';
import type { CKIngestPayload } from './integrations/adapters/CareKitBridge.js';
import { verifyOpenAIWebhookSignature } from './integrations/openaiWebhookSignature.js';

// Bundled example mapping registry — served by GET /api/mqtt/example so
// the PE visualizer's MqttConfigModal can offer a "Load example" button
// without reaching out to the host filesystem (the file lives in
// RealityEngine_CPP, which the Docker PE container can't see).  Mirrors
// config/mqtt-mappings.yuma-agriculture.json from the CPP repo — the
// 16-rule yuma-agriculture demo registry.
const EXAMPLE_MAPPINGS_JSON = {
  defaults: { ttlMs: 60000, qos: 0, acceptRetained: true, pushMode: 'debounced', debounceMs: 500 },
  mappings: [
    { id: 'agx001-ph-ok',         topicFilter: 'LATERAL/WaterSuite/DEV0000001/SensorReadings/v1', sensorIdTemplate: 'agx001.water.ph.ok',         region: { offset: 40,  length: 1 }, extract: { type: 'json', pointer: '/data/wpH'         }, normalize: { mode: 'minmax', min: 6.5,  max: 8.5  } },
    { id: 'agx001-ec-ok',         topicFilter: 'LATERAL/WaterSuite/DEV0000001/SensorReadings/v1', sensorIdTemplate: 'agx001.water.ec.ok',         region: { offset: 41,  length: 1 }, extract: { type: 'json', pointer: '/data/wEC'         }, normalize: { mode: 'minmax', min: 0.5,  max: 3.0  } },
    { id: 'agx001-orp-ok',        topicFilter: 'LATERAL/WaterSuite/DEV0000001/SensorReadings/v1', sensorIdTemplate: 'agx001.water.orp.ok',        region: { offset: 42,  length: 1 }, extract: { type: 'json', pointer: '/data/wORP'        }, normalize: { mode: 'minmax', min: 200,  max: 600  } },
    { id: 'agx001-turbidity-ok',  topicFilter: 'LATERAL/WaterSuite/DEV0000001/SensorReadings/v1', sensorIdTemplate: 'agx001.water.turbidity.ok',  region: { offset: 43,  length: 1 }, extract: { type: 'json', pointer: '/data/wTurbidity'  }, normalize: { mode: 'minmax', min: 0,    max: 100  } },
    { id: 'agx005-do-ok',         topicFilter: 'LATERAL/DOSuite/DEV0000017/SensorReadings/v1',    sensorIdTemplate: 'agx005.do.level.ok',         region: { offset: 84,  length: 1 }, extract: { type: 'json', pointer: '/data/wDO'         }, normalize: { mode: 'minmax', min: 5,    max: 25   } },
    { id: 'agx005-do-temp-ok',    topicFilter: 'LATERAL/DOSuite/DEV0000017/SensorReadings/v1',    sensorIdTemplate: 'agx005.do.temp.ok',          region: { offset: 85,  length: 1 }, extract: { type: 'json', pointer: '/data/wDOTemp'     }, normalize: { mode: 'minmax', min: 60,   max: 85   } },
    { id: 'agx005-do-watch',      topicFilter: 'LATERAL/DOSuite/DEV0000017/SensorReadings/v1',    sensorIdTemplate: 'agx005.do.watch',            region: { offset: 86,  length: 1 }, extract: { type: 'json', pointer: '/data/wDO'         }, normalize: { mode: 'minmax', min: 3,    max: 5    } },
    { id: 'agx005-temp-watch',    topicFilter: 'LATERAL/DOSuite/DEV0000017/SensorReadings/v1',    sensorIdTemplate: 'agx005.do.temp.watch',       region: { offset: 87,  length: 1 }, extract: { type: 'json', pointer: '/data/wDOTemp'     }, normalize: { mode: 'minmax', min: 85,   max: 95   } },
    { id: 'agx026-temp-ok',       topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx026.temp.ok',           region: { offset: 184, length: 1 }, extract: { type: 'json', pointer: '/data/aTemp'       }, normalize: { mode: 'minmax', min: 65,   max: 85   } },
    { id: 'agx026-humidity-ok',   topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx026.humidity.ok',       region: { offset: 185, length: 1 }, extract: { type: 'json', pointer: '/data/aHum'        }, normalize: { mode: 'minmax', min: 40,   max: 70   } },
    { id: 'agx026-temp-watch',    topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx026.temp.watch',        region: { offset: 186, length: 1 }, extract: { type: 'json', pointer: '/data/aTemp'       }, normalize: { mode: 'minmax', min: 85,   max: 95   } },
    { id: 'agx026-humidity-watch',topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx026.humidity.watch',    region: { offset: 187, length: 1 }, extract: { type: 'json', pointer: '/data/aHum'        }, normalize: { mode: 'minmax', min: 20,   max: 40   } },
    { id: 'agx032-co2-ok',        topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx032.co2.ok',            region: { offset: 228, length: 1 }, extract: { type: 'json', pointer: '/data/aCO2'        }, normalize: { mode: 'minmax', min: 600,  max: 1500 } },
    { id: 'agx032-co2-watch',     topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx032.co2.watch',         region: { offset: 229, length: 1 }, extract: { type: 'json', pointer: '/data/aCO2'        }, normalize: { mode: 'minmax', min: 1500, max: 3000 } },
    { id: 'agx032-co2-danger',    topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx032.co2.danger',        region: { offset: 230, length: 1 }, extract: { type: 'json', pointer: '/data/aCO2'        }, normalize: { mode: 'minmax', min: 3000, max: 5000 } },
    { id: 'agx032-temp-ok',       topicFilter: 'LATERAL/AmbientSuite/DEV0000009/SensorReadings/v1', sensorIdTemplate: 'agx032.temp.ok',           region: { offset: 231, length: 1 }, extract: { type: 'json', pointer: '/data/aTemp'       }, normalize: { mode: 'minmax', min: 65,   max: 85   } },
  ],
};

// Bundled HealthKit bridge example registry — served by
// GET /api/integrations/healthkit/example so operators can load a starter
// config without hand-crafting source mappings for the 12 most common HK types.
// Offsets are illustrative placeholders for the home-health domain (302-390);
// adjust to match the actual perceptual vector layout of your universe.
const EXAMPLE_HK_REGISTRY_JSON = {
  version: '1.0',
  integrations: [
    { id: 'healthkit-home', kind: 'healthkit', enabled: true, apiKey: 'change-me-in-production' },
  ],
  sourceMappings: [
    { id: 'healthkit:HKQuantityTypeIdentifierHeartRate',                name: 'Heart Rate',              region: { offset: 302, length: 1 }, ttlMs: 300_000, normalize: { mode: 'minmax', min: 60,   max: 100  } },
    { id: 'healthkit:HKQuantityTypeIdentifierRestingHeartRate',         name: 'Resting Heart Rate',      region: { offset: 303, length: 1 }, ttlMs: 900_000, normalize: { mode: 'minmax', min: 40,   max: 80   } },
    { id: 'healthkit:HKQuantityTypeIdentifierHeartRateVariabilitySDNN', name: 'HRV (SDNN ms)',           region: { offset: 304, length: 1 }, ttlMs: 900_000, normalize: { mode: 'minmax', min: 0,    max: 100  } },
    { id: 'healthkit:HKQuantityTypeIdentifierOxygenSaturation',         name: 'SpO₂',                   region: { offset: 305, length: 1 }, ttlMs: 300_000, normalize: { mode: 'minmax', min: 0.95, max: 1.0  } },
    { id: 'healthkit:HKQuantityTypeIdentifierRespiratoryRate',          name: 'Respiratory Rate',        region: { offset: 306, length: 1 }, ttlMs: 300_000, normalize: { mode: 'minmax', min: 12,   max: 20   } },
    { id: 'healthkit:HKQuantityTypeIdentifierBloodPressureSystolic',    name: 'Blood Pressure Systolic', region: { offset: 307, length: 1 }, ttlMs: 3_600_000, normalize: { mode: 'minmax', min: 90,   max: 130  } },
    { id: 'healthkit:HKQuantityTypeIdentifierBloodPressureDiastolic',   name: 'Blood Pressure Diastolic',region: { offset: 308, length: 1 }, ttlMs: 3_600_000, normalize: { mode: 'minmax', min: 60,   max: 90   } },
    { id: 'healthkit:HKQuantityTypeIdentifierStepCount',                name: 'Step Count',              region: { offset: 309, length: 1 }, ttlMs: 3_600_000, normalize: { mode: 'minmax', min: 0,    max: 10_000 } },
    { id: 'healthkit:HKQuantityTypeIdentifierActiveEnergyBurned',       name: 'Active Energy Burned',    region: { offset: 310, length: 1 }, ttlMs: 3_600_000, normalize: { mode: 'minmax', min: 0,    max: 1_000  } },
    { id: 'healthkit:HKCategoryTypeIdentifierSleepAnalysis',            name: 'Sleep Analysis',          region: { offset: 311, length: 1 }, ttlMs: 86_400_000, normalize: { mode: 'passthrough', clamp: true } },
    { id: 'healthkit:HKQuantityTypeIdentifierBodyTemperature',          name: 'Body Temperature',        region: { offset: 312, length: 1 }, ttlMs: 3_600_000, normalize: { mode: 'minmax', min: 96,   max: 100  } },
    { id: 'healthkit:HKQuantityTypeIdentifierBloodGlucose',             name: 'Blood Glucose',           region: { offset: 313, length: 1 }, ttlMs: 3_600_000, normalize: { mode: 'minmax', min: 70,   max: 180  } },
  ],
};

// Bundled CareKit bridge example registry — served by
// GET /api/integrations/carekit/example.  Wire-compatible with CPP and LSP:
// offset 4310, length 4 matching all three reference implementations.
const EXAMPLE_CK_REGISTRY_JSON = {
  version: '1.0',
  integrations: [
    { id: 'carekit-ios-bridge', kind: 'carekit', enabled: false,
      bridgeId: 'carekit-ios-bridge', defaultSourceMappingId: 'carekit-task', transport: 'https' },
  ],
  sourceMappings: [
    { id: 'carekit-task',
      sensorIdTemplate: 'carekit.{sampleType}',
      region: { offset: 4310, length: 4 },
      extract: { type: 'json', pointers: ['/completed', '/missed', '/adherence', '/confidence'] },
      normalize: { mode: 'passthrough', clamp: true },
      ttlMs: 900_000,
      pushMode: 'debounced', debounceMs: 250 },
    { id: 'carekit-outcome',
      sensorIdTemplate: 'carekit.{sampleType}.{taskId}',
      region: { offset: 4314, length: 4 },
      extract: { type: 'json', pointers: ['/value', '/progress', '/confidence', '/class'] },
      normalize: { mode: 'passthrough', clamp: true },
      ttlMs: 900_000,
      pushMode: 'debounced', debounceMs: 250 },
  ],
};

const PORT = parseInt(process.env['PORT'] ?? '3004', 10);
const REALITY_ENGINE_URL = process.env['REALITY_ENGINE_URL'] ?? 'http://localhost:5001';
const DATA_PATH = process.env['DATA_PATH'] ?? './data';
// Default matches the visualizer's PERCEPTUAL_DIM so machine offsets minted
// by the RE land inside PE's vector out of the box.  Bootstrapping a 50+
// machine universe with the old 256 default silently dropped every machine
// whose perceptualMapping.input.offset exceeded 255 — the bootstrap counted
// them as "skipped" with no diagnostic.  Override via VECTOR_SIZE env var
// when running a smaller universe to claw the memory back.
const VECTOR_SIZE = parseInt(process.env['VECTOR_SIZE'] ?? '4128', 10);
const certPath = process.env['TLS_CERT_PATH'];
const keyPath  = process.env['TLS_KEY_PATH'];
const tlsEnabled = !!(certPath && keyPath && existsSync(certPath) && existsSync(keyPath));

// HTTPS agent for outbound calls to the Reality Engine.  When CA_CERT_PATH
// points at a real file (Docker dev: the bundled self-signed CA at
// /etc/certs/ca.crt), trust it explicitly — every PE→RE push then
// validates against that CA instead of erroring with "self-signed
// certificate in certificate chain" on every step.  When CA_CERT_PATH
// is unset (deployed against a real CA-signed RE), this stays null and
// axios uses Node's default trust store — strict TLS validation intact,
// which is exactly the restriction we want to preserve in production.
const caCertPath = process.env['CA_CERT_PATH'];
const reHttpsAgent: HttpsAgent | null =
  caCertPath && existsSync(caCertPath)
    ? new HttpsAgent({ ca: readFileSync(caCertPath) })
    : null;
if (reHttpsAgent) {
  console.log(`[TLS] Trusting RE cert chain via CA at ${caCertPath}`);
}

// Wrap axios calls to the RE so each one carries the CA-aware agent.
// Use these helpers in place of bare axios.get/post when the URL is on
// REALITY_ENGINE_URL — they no-op (use default agent) in deployed mode.
const reAxios = axios.create(reHttpsAgent ? { httpsAgent: reHttpsAgent } : {});

const app = express();
// Use HTTPS when TLS_CERT_PATH and TLS_KEY_PATH are set (dev outside Docker);
// otherwise plain HTTP (Docker: TLS is terminated by the nginx tls-proxy).
const server = tlsEnabled
  ? createHttpsServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, app)
  : createHttpServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
  },
}));

// ── Integration registry ──────────────────────────────────────────────────
// Provider-neutral catalog loaded at startup.  Mirrors the C++ contract
// in RealityEngine_CPP/src/perception_engine_server.cpp
// (`load_integration_registry` + `integration_status`).  See
// docs/INTEGRATION_ROADMAP.md §Phase 0 for the wire shape.
//
// Resolution order:
//   1. INTEGRATIONS_CONFIG env var (absolute or relative to CWD)
//   2. config/integrations.json in CWD, if present
//   3. otherwise: PE starts with an empty registry
let integrationRegistry: RegistryState = (() => {
  const resolved = resolveRegistryPath(process.env['INTEGRATIONS_CONFIG']);
  return resolved ? loadRegistry(resolved) : emptyRegistryState();
})();
console.log(
  integrationRegistry.loaded
    ? `Integrations: loaded ${(integrationRegistry.config.integrations ?? []).length} integrations, ${integrationRegistry.sourceMappingIndex.size} sourceMapping(s) from ${integrationRegistry.path}`
    : integrationRegistry.error
      ? `Integrations: failed to load (${integrationRegistry.error}); status endpoint will report the error`
      : 'Integrations: no registry configured (set INTEGRATIONS_CONFIG or place config/integrations.json)',
);

// ── Trigger dispatcher (Phase 2) ──────────────────────────────────────────
// Subscribes to every RE step result and synthesises a `ces.terminal.event`
// envelope per qualifying mergeOp.  Fire-and-record only — never blocks the
// PE cycle and never calls a provider.  See docs/INTEGRATION_ROADMAP.md
// §Phase 2 and the wire contract in RealityEngine_CPP::dispatch_triggers.
// CareKit bridge — env vars match CPP / LSP defaults exactly.
const careKitBridgeId = process.env['CAREKIT_BRIDGE_ID'] ?? 'carekit-ios-bridge';
const careKitDefaultSourceMappingId = process.env['CAREKIT_DEFAULT_SOURCE_MAPPING_ID'] ?? 'carekit-task';
const careKitBridgeToken = process.env['CAREKIT_BRIDGE_TOKEN'] ?? '';

const triggersEnabled = (process.env['TRIGGERS_ENABLED'] ?? '').toLowerCase() === 'true'
  || process.env['TRIGGERS_ENABLED'] === '1';
const triggerDispatchMode = process.env['TRIGGER_DISPATCH_MODE'] ?? 'dry-run';
const localAIBaseUrl = process.env['LOCAL_AI_BASE_URL'] ?? process.env['LOCAL_AI_API_URL'] ?? 'http://localhost:4000';
const triggerGraphQLEndpoint = process.env['TRIGGER_GRAPHQL_URL'] ?? `${localAIBaseUrl}/graphql`;

// Lazy machine-catalog cache, populated from RE.  The dispatcher's lookup
// closes over this map so steps fired before the first refresh just drop
// to `droppedNoDispatch` (instead of crashing).
const machineCatalog = new Map<string, MachineRecord>();
async function refreshMachineCatalog(): Promise<void> {
  try {
    const response = await reAxios.get<{ machines?: MachineRecord[] }>(`${REALITY_ENGINE_URL}/api/machines`);
    const machines = Array.isArray(response.data?.machines) ? response.data.machines : [];
    machineCatalog.clear();
    for (const m of machines) {
      if (m && typeof m.id === 'string') machineCatalog.set(m.id, m);
    }
  } catch (err: any) {
    // Soft-fail: dispatcher continues to operate with whatever it had.
    if (triggersEnabled) {
      console.warn(`[triggers] machine catalog refresh failed: ${err?.message ?? err}`);
    }
  }
}
// Best-effort initial fetch + 60s refresh.  Both are async so PE boot is
// never blocked on RE availability.
void refreshMachineCatalog();
setInterval(refreshMachineCatalog, 60_000).unref();

// Dispatch ledger — in-memory ring shared between the trigger dispatcher
// (which appends on each envelope) and the Phase-3 `/api/dispatch/*` routes
// (which read + PATCH).  When DISPATCH_LEDGER_FILE is set the ledger appends
// every mutation as JSONL and replays it on restart for crash-survivable
// audit.
const dispatchLedgerFile = process.env['DISPATCH_LEDGER_FILE'] ?? null;
const dispatchLedger = new Ledger({ persistencePath: dispatchLedgerFile });
if (dispatchLedgerFile) {
  console.log(`Dispatch ledger: persisting to ${dispatchLedgerFile} (replayed ${dispatchLedger.size()} record(s) on boot)`);
}

// Adapter pipeline (Phase 4) — fan-out from the dispatcher to provider
// adapters.  Each enabled integration in the registry that has a kind
// the pipeline recognises is initialised here.  Empty by default; the
// dispatcher keeps working even with no adapters registered.
const adapterPipeline = new AdapterPipeline({
  ledgerPatchBaseUrl: `http://127.0.0.1:${PORT}`,
});
const registryIntegrations = Array.isArray(integrationRegistry.config.integrations)
  ? (integrationRegistry.config.integrations as IntegrationEntry[])
  : [];
const acpConfig = acpConfigFromRegistry(registryIntegrations);
const acpAdapter = new AcpAdapter();
void acpAdapter.init(acpConfig, {
  registry: integrationRegistry,
  completionUrl: `http://127.0.0.1:${PORT}/api/integrations/completions`,
  ledgerPatchBaseUrl: `http://127.0.0.1:${PORT}`,
});

(function bootstrapAdapters() {
  const integrations = registryIntegrations;
  // Phase 4a — Ollama.  Cloud providers land in later PRs.
  const completionUrl = `http://127.0.0.1:${PORT}/api/integrations/completions`;
  let acpRegistered = false;
  for (const entry of integrations) {
    if (!entry || entry.enabled !== true) continue;
    if (entry.kind === 'ollama') {
      const adapter = new OllamaAdapter();
      void adapter.init(entry, {
        registry: integrationRegistry,
        completionUrl,
        ledgerPatchBaseUrl: `http://127.0.0.1:${PORT}`,
      });
      adapterPipeline.register(adapter);
      console.log(`Adapters: ollama "${entry.id}" registered (baseUrl=${(entry as any).baseUrl ?? 'http://localhost:11434'} model=${(entry as any).model ?? 'default'})`);
    }
    if (entry.kind === 'openai') {
      const adapter = new OpenAIAdapter();
      void adapter.init(entry, {
        registry: integrationRegistry,
        completionUrl,
        ledgerPatchBaseUrl: `http://127.0.0.1:${PORT}`,
      });
      adapterPipeline.register(adapter);
      const e = entry as any;
      console.log(`Adapters: openai "${entry.id}" registered (baseUrl=${e.baseUrl ?? 'https://api.openai.com/v1'} model=${e.model ?? 'gpt-4.1'} mode=${e.completionMode ?? 'sync'})`);
    }
    if (entry.kind === 'acp' || entry.kind === 'openclaw-acp') {
      if (acpConfig.enabled === true) {
        adapterPipeline.register(acpAdapter);
        acpRegistered = true;
        console.log(`Adapters: acp "${entry.id}" registered (platform=${acpConfig.platform ?? 'OpenClaw'} surface=${acpConfig.surface ?? 'xACP'} mode=${acpConfig.dispatchMode ?? 'accepted-no-wait'})`);
      }
    }
  }
  if (acpConfig.enabled === true && !acpRegistered) {
    adapterPipeline.register(acpAdapter);
    console.log(`Adapters: acp "${acpConfig.id}" registered (platform=${acpConfig.platform ?? 'OpenClaw'} surface=${acpConfig.surface ?? 'xACP'} mode=${acpConfig.dispatchMode ?? 'accepted-no-wait'})`);
  }
  if (adapterPipeline.size() === 0) {
    console.log('Adapters: none enabled (set enabled:true on an integration in INTEGRATIONS_CONFIG to wire a provider)');
  }
})();

const triggerDispatcher = new Dispatcher(
  {
    enabled: triggersEnabled,
    mode: triggerDispatchMode,
    graphqlEndpoint: triggerGraphQLEndpoint,
    realityEngineUrl: REALITY_ENGINE_URL,
  },
  {
    getMachine: (id) => machineCatalog.get(id),
    broadcast: (evt) => broadcast(evt),
    ledger: dispatchLedger,
    pipeline: adapterPipeline,
  },
);
console.log(
  triggersEnabled
    ? `Triggers: enabled mode=${triggerDispatchMode} graphqlEndpoint=${triggerGraphQLEndpoint}`
    : `Triggers: disabled (set TRIGGERS_ENABLED=true to enable; default mode is "dry-run")`,
);

// ── Engine instance ───────────────────────────────────────────────────────

const store = new SourceStore(DATA_PATH);
const engine = new PerceptionEngine(VECTOR_SIZE);

// Restore persisted sources (preserves original IDs)
for (const src of store.load()) {
  engine.restoreSource(src);
}
console.log(`[SourceStore] Loaded ${engine.getSources().length} source(s) from ${DATA_PATH}`);

let autoTimer: ReturnType<typeof setInterval> | null = null;
let autoIntervalMs = 1000;
let lastPush: number | null = null;

// ── MQTT bridge (optional) ────────────────────────────────────────────────
// Built only when MQTT_BROKER_URL is set in the environment.  Per the
// roadmap design rule, the bridge does NOT special-case MQTT downstream —
// each accepted message resolves to {sensorId, region, values, ttlMs} and
// flows through the same engine path that POST /api/sensors/:id uses.

function ingestMqttSignal(payload: IngestPayload): void {
  // Try update path first: matches the sensorId of an existing source.
  let acted = false;
  if (engine.updateSensorValue(payload.sensorId, payload.values)) {
    acted = true;
  } else {
    // No matching sensor source yet — auto-create one using the mapping's
    // declared region + TTL.  This keeps MQTT-driven workflows running
    // without requiring operators to pre-declare every sensor via POST
    // /api/sources first.
    const newSource: Omit<SensorSourceConfig, 'id'> = {
      type: 'sensor',
      name: `mqtt:${payload.topic}`,
      region: { offset: payload.offset, length: payload.length },
      active: true,
      sensorId: payload.sensorId,
      lastValue: payload.values.slice(),
      lastUpdated: Date.now(),
      ttlMs: payload.ttlMs > 0 ? payload.ttlMs : 30000,
    };
    engine.addSource(newSource);
    acted = true;
  }
  if (acted) {
    // Per-message MQTT ingest event — broadcast directly (not via the 50ms
    // sensor-coalesce timer) so the universe-monitor's recent-ingests
    // stream renders one row per accepted PUBLISH.  scheduleSensorBroadcast
    // is still called for the consolidated state update.
    broadcast({
      type: 'mqtt-ingest',
      payload: { ...payload, timestamp: Date.now() },
    });
    scheduleSensorBroadcast();
  }
}

let mqttBridge: MqttBridge | null = null;
// Last broker config we bootstrapped with — preserved across reloads so a
// PUT /api/mqtt/mappings can swap the registry without re-reading env vars.
let mqttBrokerConfig: import('./MqttBridge.js').BridgeConfig | null = null;

import { MappingRegistry } from './MqttMapping.js';

/**
 * Start (or restart) the MQTT bridge with the given config + registry.
 * Idempotent — stops any existing bridge before starting the new one.
 * Returns the resulting bridge or null when broker config is missing.
 */
async function bootMqttBridge(
  config: import('./MqttBridge.js').BridgeConfig | null,
  registry: MappingRegistry,
): Promise<MqttBridge | null> {
  // Tear down the old bridge — drops in-flight reconnect timers and joins
  // the I/O thread.  Brief gap (≤ a few hundred ms) is acceptable for the
  // admin-driven reload path.
  if (mqttBridge) {
    try { await mqttBridge.stop(); } catch { /* ignore */ }
    mqttBridge = null;
  }
  if (!config) return null;
  const bridge = new MqttBridge(config, registry, ingestMqttSignal, () => { void doPush(); });
  try {
    await bridge.start();
  } catch (e: any) {
    console.error(`MQTT bridge failed to start: ${e?.message ?? e}`);
    return null;
  }
  mqttBridge = bridge;
  mqttBrokerConfig = config;
  // Notify visualizer clients that the registry has changed so they can
  // refresh their mapping table without polling.
  broadcast({
    type: 'mqtt-mappings-reloaded',
    mappingsCount: registry.size,
    brokerUrl: config.brokerUrl,
    timestamp: Date.now(),
  });
  console.log(`[MQTT] bridge enabled — broker=${config.brokerUrl} mappings=${registry.size}`);
  return bridge;
}

{
  const envBridge = mqttFromEnvironment();
  if (envBridge) {
    // First boot from env; mqttBrokerConfig is captured for later reloads.
    void bootMqttBridge(envBridge.config, envBridge.registry);
  }
}

// ── WebSocket broadcast ───────────────────────────────────────────────────

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  // Send current state on connect
  const state = engine.getState(lastPush, { running: autoTimer !== null, intervalMs: autoIntervalMs });
  ws.send(JSON.stringify({ type: 'state-update', state }));
});

function broadcast(payload: object): void {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// Debounced state broadcast for high-frequency sensor pushes.
// Rapid sensor POSTs coalesce into a single broadcast within the 50 ms window
// instead of fanning out a full state payload to every WS client per event.
let sensorBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
const SENSOR_DEBOUNCE_MS = 50;

function scheduleSensorBroadcast(): void {
  if (sensorBroadcastTimer !== null) return; // already pending — coalesce
  sensorBroadcastTimer = setTimeout(() => {
    sensorBroadcastTimer = null;
    const state = engine.getState(lastPush, { running: autoTimer !== null, intervalMs: autoIntervalMs });
    broadcast({ type: 'state-update', state });
  }, SENSOR_DEBOUNCE_MS);
}

// ── Push helper ───────────────────────────────────────────────────────────
//
// Critical-path design:
//   1. Call the Reality Engine DIRECTLY — no visualizer proxy hop.
//   2. Advance engine state and return the result to the caller immediately.
//   3. THEN asynchronously notify the visualizer so it can fan out to its
//      WebSocket clients.  This step is fire-and-forget: it never blocks
//      the perception loop or the HTTP caller, and its failure is non-fatal.

async function doPush(): Promise<PushResult> {
  const vector = engine.assembleVector();

  try {
    // Direct call to the Reality Engine — bypasses the visualizer entirely.
    // RE returns the step object directly (not wrapped in {success, step}).
    const response = await reAxios.post(`${REALITY_ENGINE_URL}/api/perceive`, {
      vector,
      matchAlgorithm: engine.matchAlgorithm,
    });
    engine.advance();
    lastPush = Date.now();

    // RE returns the step directly as response.data.
    const step = response.data;

    // Update the engine's persistent perceptual space with the full post-merge
    // state so that machine outputs written this step carry forward into the next push.
    const returnedPs: number[] | undefined = step?.perceptualSpace;
    if (Array.isArray(returnedPs) && returnedPs.length >= VECTOR_SIZE) {
      engine.updateFromPerceptualSpace(returnedPs);
    }

    // Phase 2 — fire-and-record trigger dispatch.  Synchronous against the
    // returned step but the dispatcher does not call any provider, so this
    // stays off the critical path even at engine line-rate.
    triggerDispatcher.dispatchStep(step);

    const result: PushResult = {
      success: true,
      step,
      timestamp: lastPush,
      globalStep: engine.globalStep,
    };

    const state = engine.getState(lastPush, { running: autoTimer !== null, intervalMs: autoIntervalMs });
    broadcast({ type: 'state-update', state });
    broadcast({ type: 'push-result', ...result });

    return result;
  } catch (err: any) {
    console.error(`[doPush] Push failed (step ${engine.globalStep}):`, err.message);
    const result: PushResult = {
      success: false,
      timestamp: Date.now(),
      globalStep: engine.globalStep,
      error: err.message,
    };
    broadcast({ type: 'push-result', ...result });
    return result;
  }
}

// ── Auto-push ──────────────────────────────────────────────────────────────

function startAuto(intervalMs: number): void {
  stopAuto();
  autoIntervalMs = intervalMs;
  autoTimer = setInterval(async () => {
    await doPush();
  }, intervalMs);
}

function stopAuto(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

// ── Shared helpers (used by both REST routes and MCP tools) ───────────────

/** Save current sources to disk and push a state-update to all WS clients. */
async function saveAndBroadcast(): Promise<void> {
  await store.save(engine.getSources());
  const state = engine.getState(lastPush, { running: autoTimer !== null, intervalMs: autoIntervalMs });
  broadcast({ type: 'state-update', state });
}

/** Reset the engine, clear lastPush, and push a state-update to WS clients. */
function resetAndBroadcast(): void {
  engine.reset();
  lastPush = null;
  const state = engine.getState(null, { running: autoTimer !== null, intervalMs: autoIntervalMs });
  broadcast({ type: 'state-update', state });
}

// ── Machine→test-source bootstrap ─────────────────────────────────────────
//
// On PE startup (and on demand via POST /api/sources/bootstrap-from-machines),
// fetch the machine list from the Reality Engine and create one `test` source
// per machine.inputSequences entry.  Each created source defaults to
// active: true and loop: true so that every test sequence drives the
// perception loop without operator intervention.
//
// Idempotent: the composite key (machineId, sequenceName) is checked against
// existing sources before insert, so re-runs after restart (with persisted
// sources already restored) skip the rows already present.

interface MachineSummary {
  id: string;
  name: string;
  metadata?: { inputSequences?: Array<{ name: string; vectors: number[][]; recur?: boolean }> };
  perceptualMapping?: { input?: { offset: number; length: number } };
}

interface BootstrapResult {
  created: number;
  skipped: number;
  machinesSeen: number;
  errors: string[];
  // Breakdown of why each input was skipped — kept additive so existing
  // clients reading `skipped` keep working while the UI can show specifics.
  reasons: {
    // Sequence already existed for this machine (idempotency skip).
    alreadyExisted:  number;
    // perceptualMapping offset/length falls outside [0, vectorSize) —
    // the dominant failure mode when PE's VECTOR_SIZE is configured
    // smaller than the visualizer's PERCEPTUAL_DIM.
    outOfRange:      number;
    // Sequence record was missing a name or had no input vectors.
    noSequences:     number;
    // Machine was filtered out by the caller's machineIds allow-list.
    outsideFilter:   number;
  };
  // Engine's configured vector size, surfaced so the UI can suggest
  // raising VECTOR_SIZE when outOfRange is non-zero.
  vectorSize: number;
}

async function bootstrapMachineTestSources(
  filter?: { machineIds?: ReadonlySet<string> },
): Promise<BootstrapResult> {
  const errors: string[] = [];
  let created = 0;
  const reasons = { alreadyExisted: 0, outOfRange: 0, noSequences: 0, outsideFilter: 0 };
  let machinesSeen = 0;

  let machines: MachineSummary[] = [];
  try {
    const response = await reAxios.get<{ machines: MachineSummary[] }>(`${REALITY_ENGINE_URL}/api/machines`);
    machines = response.data?.machines ?? [];
    machinesSeen = machines.length;
  } catch (err: any) {
    errors.push(`fetch /api/machines: ${err?.message ?? String(err)}`);
    return {
      created, skipped: 0, machinesSeen, errors,
      reasons, vectorSize: VECTOR_SIZE,
    };
  }

  // Optional allow-list: when caller supplied machineIds (typically the
  // frontend submitting a domain-filtered set), skip machines outside it.
  // Empty Set means "no machines match" — we still walk so the count of
  // skipped reflects what was filtered out.
  const allowList = filter?.machineIds;

  // One source per machine, regardless of how many test sequences it
  // declares — its segments stage the sequences end-to-end so the first
  // completes before the second starts and a loop iteration spans the
  // entire concatenated set.  Dedup is per-machine.
  //
  // Migration: prior bootstrap created one test source *per sequence*;
  // machines that still carry that stale layout (>1 test source for the
  // same machineId) have all of those cleared here so the consolidated
  // source replaces them.  Single-source machines are left alone — they
  // are already idempotent under the new shape.
  const perMachine = new Map<string, string[]>();
  for (const src of engine.getSources()) {
    if (src.type !== 'test' || !src.machineId) continue;
    const list = perMachine.get(src.machineId) ?? [];
    list.push(src.id);
    perMachine.set(src.machineId, list);
  }
  for (const [, ids] of perMachine) {
    if (ids.length > 1) for (const id of ids) engine.removeSource(id);
  }

  const existingMachineIds = new Set<string>();
  for (const src of engine.getSources()) {
    if (src.type === 'test') existingMachineIds.add(src.machineId);
  }

  for (const machine of machines) {
    if (allowList && !allowList.has(machine.id)) {
      const seqs = machine.metadata?.inputSequences;
      reasons.outsideFilter += Array.isArray(seqs) && seqs.length > 0 ? seqs.length : 1;
      continue;
    }
    const machineId = machine.id;
    const machineName = machine.name ?? machineId;
    const inputSequences = machine.metadata?.inputSequences ?? [];
    const mapping = machine.perceptualMapping?.input;
    if (!machineId || inputSequences.length === 0) continue;
    if (existingMachineIds.has(machineId)) { reasons.alreadyExisted++; continue; }

    const concatVectors: number[][] = [];
    const segments: { name: string; length: number }[] = [];
    for (const seq of inputSequences) {
      if (!seq?.name || !Array.isArray(seq.vectors) || seq.vectors.length === 0) continue;
      segments.push({ name: seq.name, length: seq.vectors.length });
      for (const v of seq.vectors) concatVectors.push(v);
    }
    if (concatVectors.length === 0) { reasons.noSequences++; continue; }

    const length = mapping?.length ?? concatVectors[0]?.length ?? 0;
    const offset = mapping?.offset ?? 0;
    if (length <= 0 || offset < 0 || offset >= VECTOR_SIZE || offset + length > VECTOR_SIZE) {
      reasons.outOfRange++;
      continue;
    }

    const segmentLabel = segments.length === 1
      ? segments[0].name
      : `${segments.length} sequences (${segments.map(s => s.name).join(', ')})`;
    const config: Omit<TestSourceConfig, 'id'> = {
      type: 'test',
      name: `${machineName} · ${segmentLabel}`,
      region: { offset, length },
      active: true,
      machineId,
      machineName,
      sequenceName: segmentLabel,
      segments,
      inputs: concatVectors,
      // Loop unless every sequence explicitly opts out via recur:false.
      loop: !inputSequences.every(s => s.recur === false),
    };
    engine.addSource(config);
    existingMachineIds.add(machineId);
    created++;
  }

  if (created > 0) {
    await saveAndBroadcast();
  }

  const skipped = reasons.alreadyExisted + reasons.outOfRange + reasons.noSequences + reasons.outsideFilter;
  return { created, skipped, machinesSeen, errors, reasons, vectorSize: VECTOR_SIZE };
}

/**
 * Bootstrap retry loop — RE may still be starting when PE comes up.  Polls
 * /api/health until it responds, then runs the bootstrap once.  Gives up
 * after maxAttempts so a permanently-down RE doesn't keep this task alive.
 */
async function bootstrapWithRetry(maxAttempts: number = 60, delayMs: number = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await reAxios.get(`${REALITY_ENGINE_URL}/api/health`, { timeout: 1500 });
      const result = await bootstrapMachineTestSources();
      console.log(
        `[bootstrap] machine test sources — seen=${result.machinesSeen} created=${result.created} skipped=${result.skipped} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        for (const e of result.errors) console.warn(`[bootstrap] ${e}`);
      }
      // Start the push loop so machine test sequences actually advance and
      // recur.  Sources are created with loop derived from their recur field
      // (default true); advance() resets the step counter at the sequence
      // boundary.  Skip if the operator already started the timer manually.
      const loopingSources = engine.getSources().filter(
        (s): s is TestSourceConfig => s.type === 'test' && s.active && (s as TestSourceConfig).loop !== false,
      );
      if (loopingSources.length > 0 && autoTimer === null) {
        startAuto(autoIntervalMs);
        console.log(`[bootstrap] auto-push started (${autoIntervalMs}ms) — ${loopingSources.length} machine source(s) will recur`);
      }
      return;
    } catch (err: any) {
      if (attempt === maxAttempts) {
        console.warn(`[bootstrap] gave up after ${maxAttempts} attempts — RE never responded (${err?.message ?? err})`);
        return;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── MCP server ────────────────────────────────────────────────────────────

mountMcp(app, {
  engine,
  store,
  push: doPush,
  startAuto,
  stopAuto,
  getAutoState: () => ({ running: autoTimer !== null, intervalMs: autoIntervalMs }),
  getLastPush: () => lastPush,
  saveAndBroadcast,
  resetAndBroadcast,
  realityEngineUrl: REALITY_ENGINE_URL,
  httpClient: reAxios,
  // Phase 5 — share the in-process dispatcher + ledger so the new dotted
  // MCP tools (trigger.replay, dispatch.read_ledger) operate on the same
  // state the REST routes do.
  dispatcher: triggerDispatcher,
  ledger: dispatchLedger,
});

// ── HTTP API ──────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    service: 'Perception Engine',
    status: 'running',
    port: PORT,
    endpoints: {
      health:   'GET    /api/health',
      state:    'GET    /api/state',
      push:     'POST   /api/push',
      autoStart:'POST   /api/auto/start  { intervalMs }',
      autoStop: 'POST   /api/auto/stop',
      reset:    'POST   /api/reset',
      sources:  'GET    /api/sources',
      addSource:'POST   /api/sources',
      sensor:   'POST   /api/sensors/:id  { values }',
      machines: 'GET    /api/machines',
    },
    mcp: {
      transport: 'Streamable HTTP (MCP 1.0)',
      post:   'POST   /mcp  — initialize session / dispatch JSON-RPC',
      get:    'GET    /mcp  — SSE notification stream (mcp-session-id required)',
      delete: 'DELETE /mcp  — close session',
      tools: [
        'perception_get_state', 'perception_push',
        'perception_start_auto', 'perception_stop_auto',
        'perception_reset', 'perception_set_match_algorithm',
        'sources_list', 'sources_add_simulated', 'sources_add_sensor',
        'sources_add_test', 'sources_update', 'sources_delete',
        'sensor_push_value',
        'reality_engine_health', 'machines_list', 'machines_load_json',
        'perceptual_sim_state', 'perceptual_sim_step', 'perceptual_sim_start',
        'perceptual_sim_stop', 'perceptual_sim_reset', 'perceptual_sim_history',
        'demo_load',
      ],
      resources: ['perception://state', 'perception://sources', 'perception://vector'],
    },
    websocket: `${tlsEnabled ? 'wss' : 'ws'}://localhost:${PORT}/ws`,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

// Prometheus metrics — text/plain exposition format on /api/metrics.  Carries
// the runtime="ai" label so a single Grafana dashboard can pivot across AI /
// CPP / LSP runtimes without scrape-time relabels.  Includes engine state
// (sources, globalStep) plus MQTT bridge counters when the bridge is up.
app.get('/api/metrics', (_req: Request, res: Response) => {
  const RUNTIME = 'ai';
  const lines: string[] = [];

  const metric = (
    name: string,
    help: string,
    kind: 'gauge' | 'counter',
    value: number,
    labels: Record<string, string> = {},
  ): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${kind}`);
    const allLabels = { runtime: RUNTIME, ...labels };
    const ls = Object.entries(allLabels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');
    lines.push(`${name}{${ls}} ${value}`);
  };

  const sources = engine.getSources();
  metric('perception_engine_sources_total',        'Total sensor/test/simulated sources registered.', 'gauge', sources.length);
  metric('perception_engine_global_step',          'Engine globalStep counter (push count since start).', 'gauge', engine.globalStep);
  metric('perception_engine_vector_size',          'Configured vector dimension.', 'gauge', engine.vectorSize);
  metric('perception_engine_last_push_ms',         'Wall-clock timestamp of the last successful push (0 if never).', 'gauge', lastPush ?? 0);
  metric('perception_engine_auto_running',         '1 if auto-push timer is active, 0 otherwise.', 'gauge', autoTimer !== null ? 1 : 0);
  metric('perception_engine_auto_interval_ms',     'Configured auto-push interval in ms.', 'gauge', autoIntervalMs);

  // MQTT bridge — only emit when the bridge has been booted.  Absent
  // metrics are easier to read than zero-everywhere counters when the
  // bridge is intentionally disabled.
  if (mqttBridge) {
    const s = mqttBridge.getStats();
    metric('mqtt_bridge_enabled',              'MQTT bridge is configured (1) or disabled (0).', 'gauge', 1);
    metric('mqtt_bridge_connected',            'MQTT bridge is currently connected to the broker (1/0).', 'gauge', mqttBridge.isConnected() ? 1 : 0);
    metric('mqtt_messages_received_total',     'Total MQTT PUBLISH messages received.',          'counter', s.messagesReceived ?? 0);
    metric('mqtt_messages_mapped_total',       'Total messages successfully mapped to a region.','counter', s.messagesMapped ?? 0);
    metric('mqtt_messages_rejected_total',     'Total messages rejected by mapping/normalize.',  'counter', s.messagesRejected ?? 0);
    metric('mqtt_messages_unmatched_total',    'Total messages whose topic matched no rule.',    'counter', s.messagesUnmatched ?? 0);
    metric('mqtt_pushes_triggered_total',      'Total perceive pushes triggered by MQTT ingest.','counter', s.pushesTriggered ?? 0);
    metric('mqtt_mappings_loaded',             'Number of mapping rules in the registry.',       'gauge',   mqttBridge.getRegistry().size);
  } else {
    metric('mqtt_bridge_enabled',   'MQTT bridge is configured (1) or disabled (0).', 'gauge', 0);
    metric('mqtt_bridge_connected', 'MQTT bridge is currently connected to the broker (1/0).', 'gauge', 0);
  }

  // CES paging decisions — placeholder counter so dashboards can be wired
  // before the per-rule trigger counter is fully instrumented in this
  // runtime (the RE-side counter under the same name lives at
  // /api/metrics on the RE).
  metric('ces_paging_decisions_total', 'Total CES paging decisions emitted (cumulative).', 'counter', 0);

  res.type('text/plain').send(lines.join('\n') + '\n');
});

// Full engine state
app.get('/api/state', (_req: Request, res: Response) => {
  const state = engine.getState(lastPush, { running: autoTimer !== null, intervalMs: autoIntervalMs });
  res.json(state);
});

// Integration registry status — provider-neutral catalog loaded at startup.
// Wire-compatible with RealityEngine_CPP `integration_status()`.  See
// docs/INTEGRATION_ROADMAP.md §Phase 0 for the response shape and
// Appendix A for the cross-engine contract.
app.get('/api/integrations/status', (_req: Request, res: Response) => {
  res.json(integrationStatus(integrationRegistry));
});

// Trigger dispatcher status (Phase 2) — counters and config.  Wire-
// compatible with RealityEngine_CPP `trigger_status()`, plus a
// TS-side `replaysCreated` field driven by the replay endpoint below.
app.get('/api/triggers/status', (_req: Request, res: Response) => {
  res.json(triggerDispatcher.status());
});

// POST /api/triggers/replay/:dispatchId — re-emit an existing ledger
// record as a new envelope.  Fire-and-record only: never mutates PE/RE
// state, never calls a provider.  Body (optional): `{ freshIds: true }`
// to mint new envelope+correlation IDs, otherwise the replay reuses the
// originals so subscribers see the same causal chain.
app.post('/api/triggers/replay/:dispatchId', (req: Request, res: Response) => {
  const id = req.params['dispatchId'] ?? '';
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as { freshIds?: unknown })
    : {};
  const freshIds = body.freshIds === true;
  const replayed = triggerDispatcher.replay(id, { freshIds });
  if (!replayed) {
    res.status(404).json({ error: 'Dispatch record not found' });
    return;
  }
  res.json({ success: true, record: replayed, replayOf: id, freshIds });
});

// ── Dispatch ledger HTTP surface (Phase 3) ───────────────────────────────
// Wire-compatible with RealityEngine_CPP:
//   dispatch_ledger()             → GET    /api/dispatch/ledger
//   read_dispatch_record(id)      → GET    /api/dispatch/records/:id
//   update_dispatch_record(id, …) → PATCH  /api/dispatch/records/:id
// No query params on the ledger (matches C++ — pagination is client-side).
// PATCH accepts only delivery-metadata fields (see DispatchRecordPatch);
// unknown / forbidden keys are silently ignored.

app.get('/api/dispatch/ledger', (_req: Request, res: Response) => {
  const status = triggerDispatcher.status();
  res.json({
    enabled: status.enabled,
    mode: status.mode,
    records: dispatchLedger.list(),
  });
});

app.get('/api/dispatch/records/:id', (req: Request, res: Response) => {
  const record = dispatchLedger.get(req.params['id'] ?? '');
  if (!record) {
    res.status(404).json({ error: 'Dispatch record not found' });
    return;
  }
  res.json({ record });
});

app.patch('/api/dispatch/records/:id', (req: Request, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'dispatch update body must be a JSON object' });
    return;
  }
  const updated = dispatchLedger.update(req.params['id'] ?? '', body as DispatchRecordPatch);
  if (!updated) {
    res.status(404).json({ error: 'Dispatch record not found' });
    return;
  }
  broadcast(dispatchLedger.toUpdatedEvent(updated));
  res.json({ success: true, record: updated });
});

// ── Provider-neutral signal / completion ingestion (Phase 1) ──────────────
// Wire-compatible with RealityEngine_CPP `ingest_signal()` /
// `ingest_completion()` in src/perception_engine_server.cpp.  Both routes
// route through the same in-process helper so MQTT, HealthKit, OpenAI, and
// Ollama adapters land their results through one path.

interface SignalIngestBody {
  sensorId?: string;
  name?: string;
  region?: { offset: number; length: number };
  values?: number[];
  active?: boolean;
  ttlMs?: number;
  triggerPush?: boolean;
  compactPush?: boolean;
}

interface SignalIngestResult {
  status: number;
  body: Record<string, unknown>;
}

/** Auto-generated sensorId for region-only `POST /api/signals` callers. */
function makeExternalSensorId(): string {
  return `external-sensor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Find an existing sensor source by its `sensorId` field. */
function findSensorSourceBySensorId(sensorId: string): SensorSourceConfig | undefined {
  return engine.getSources()
    .find((s): s is SensorSourceConfig => s.type === 'sensor' && s.sensorId === sensorId);
}

/**
 * Core ingest path used by both `POST /api/signals` and the completion
 * adapter.  Returns a structured result rather than touching the response
 * directly so the completion handler can wrap it with its own metadata.
 */
async function ingestSignal(body: SignalIngestBody): Promise<SignalIngestResult> {
  if (!Array.isArray(body.values) || body.values.length === 0) {
    return { status: 400, body: { error: 'values must be a non-empty array' } };
  }
  for (const v of body.values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { status: 400, body: { error: 'values must contain only finite numbers' } };
    }
  }
  const values = body.values.slice();

  let source: SourceConfig | undefined;
  const explicitSensorId = typeof body.sensorId === 'string' && body.sensorId !== '';
  const region = body.region;
  const regionValid = region
    && typeof region.offset === 'number' && typeof region.length === 'number'
    && region.offset >= 0 && region.length >= 1 && region.offset < VECTOR_SIZE;

  if (explicitSensorId) {
    const sensorId = body.sensorId!;
    const existed = engine.updateSensorValue(sensorId, values);
    if (existed) {
      source = findSensorSourceBySensorId(sensorId);
    } else if (regionValid) {
      // Auto-provision a new sensor source — matches C++ fall-through path.
      const newSource: Omit<SensorSourceConfig, 'id'> = {
        type: 'sensor',
        name: typeof body.name === 'string' && body.name !== '' ? body.name : sensorId,
        sensorId,
        region: { offset: region!.offset, length: region!.length },
        active: body.active !== false,
        lastValue: values,
        lastUpdated: Date.now(),
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : 30_000,
      };
      source = engine.addSource(newSource);
    } else {
      return { status: 404, body: { error: `No sensor source with sensorId "${sensorId}"` } };
    }
  } else if (regionValid) {
    const sensorId = typeof body.name === 'string' && body.name !== ''
      ? body.name
      : makeExternalSensorId();
    const newSource: Omit<SensorSourceConfig, 'id'> = {
      type: 'sensor',
      name: typeof body.name === 'string' && body.name !== '' ? body.name : 'external/signal',
      sensorId,
      region: { offset: region!.offset, length: region!.length },
      active: true,
      lastValue: values,
      lastUpdated: Date.now(),
      ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : 30_000,
    };
    source = engine.addSource(newSource);
  } else {
    return { status: 400, body: { error: 'signal requires sensorId or region' } };
  }

  const responseBody: Record<string, unknown> = {
    success: true,
    timestamp: Date.now(),
    source: source ?? null,
  };

  if (body.triggerPush === true) {
    const push = await doPush();
    if (body.compactPush === false) {
      responseBody.push = push;
    } else {
      // Compact view: drop the verbose step payload, keep timing + success.
      responseBody.push = {
        success: push.success,
        timestamp: push.timestamp,
        globalStep: push.globalStep,
        error: push.error,
      };
    }
  }

  scheduleSensorBroadcast();
  return { status: 200, body: responseBody };
}

// POST /api/signals — underlying primitive (publicly exposed; matches C++).
app.post('/api/signals', async (req: Request, res: Response) => {
  const result = await ingestSignal(req.body as SignalIngestBody);
  res.status(result.status).json(result.body);
});

// Helpers for the OpenAI webhook handler below.  Tolerate every shape we
// have seen in the wild: Responses API (`output[*].content[*].text` or
// `output_text`), chat-completions (`choices[0].message.content`), or
// the most-minimal `{text, metadata}` test fixtures.

function pickFirstString(candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c;
  }
  return '';
}

function walkResponsesOutput(output: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(output)) return out;
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        out.push((block as { text: string }).text);
      }
    }
  }
  return out;
}

function walkChatCompletionsContent(choices: unknown): string {
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === 'string' ? content : '';
}

function extractValuesFromParsed(parsed: unknown): number[] | undefined {
  // The webhook can either supply `values: number[]` directly, or rely
  // on the source-mapping `extract` pipeline that the registry-driven
  // SourceMapper applies inside resolveCompletion when values are
  // present.  Here we pull values when the model returns them explicitly.
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { values?: unknown }).values)) {
    const v = (parsed as { values: unknown[] }).values;
    if (v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v as number[];
  }
  return undefined;
}

async function resolveOpenAIWebhookBody(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = body['data'];
  const responseId = body['object'] === 'event'
    && body['type'] === 'response.completed'
    && data && typeof data === 'object'
    && !Array.isArray(data)
    && typeof (data as Record<string, unknown>)['id'] === 'string'
    ? (data as Record<string, unknown>)['id'] as string
    : '';
  if (responseId === '') return body;

  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  if (apiKey === '') throw new Error('OPENAI_API_KEY is required to retrieve OpenAI webhook response');
  const baseUrl = (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const resp = await axios.get(`${baseUrl}/responses/${encodeURIComponent(responseId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  });
  if (!resp.data || typeof resp.data !== 'object' || Array.isArray(resp.data)) {
    throw new Error('OpenAI response retrieve returned a non-object body');
  }
  return resp.data as Record<string, unknown>;
}

// POST /api/integrations/openai/webhook — receives OpenAI-shaped webhook
// payloads (background Responses runs).  Resolves the original envelope
// from `metadata.envelopeId / correlationId`, parses the model output
// text as JSON, applies the source-mapping pipeline, and routes through
// the in-process completion path so the same source update lands
// whether the run finished sync or async.
app.post('/api/integrations/openai/webhook', async (req: Request, res: Response) => {
  const signatureError = verifyOpenAIWebhookSignature({
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody: (req as Request & { rawBody?: string }).rawBody,
  });
  if (signatureError) {
    res.status(400).json({ error: signatureError });
    return;
  }

  let body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : null;
  if (!body) {
    res.status(400).json({ error: 'webhook body must be a JSON object' });
    return;
  }

  try {
    body = await resolveOpenAIWebhookBody(body);
  } catch (err: any) {
    res.status(502).json({ error: `webhook response retrieve failed: ${err?.message ?? err}` });
    return;
  }

  const metadata = (body['metadata'] && typeof body['metadata'] === 'object' && !Array.isArray(body['metadata']))
    ? body['metadata'] as Record<string, unknown>
    : {};
  const correlationId = typeof metadata['correlationId'] === 'string' ? metadata['correlationId'] : '';
  const envelopeId = typeof metadata['envelopeId'] === 'string' ? metadata['envelopeId'] : '';
  const dispatchId = typeof metadata['dispatchId'] === 'string' ? metadata['dispatchId'] : '';
  // Optional caller-supplied resolution: explicit sourceMappingId wins.
  const sourceMappingIdRaw = typeof body['sourceMappingId'] === 'string'
    ? body['sourceMappingId']
    : '';

  // Pull the model output text out of a Responses-API webhook payload.
  // Accept either `output_text`, the `output[].content[].text` walk, or
  // a top-level `text` field for very small payloads.
  const text = pickFirstString([
    body['output_text'],
    body['text'],
    ...walkResponsesOutput(body['output']),
    walkChatCompletionsContent(body['choices']),
  ]);
  if (text === '') {
    res.status(400).json({ error: 'webhook payload contained no output text' });
    return;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (err: any) {
    res.status(400).json({ error: `webhook output was not valid JSON: ${err?.message ?? err}` });
    return;
  }

  // Resolve the source mapping.  Order: explicit body.sourceMappingId →
  // look up via dispatchId on the ledger record → null.
  // Also pull `agent` from the dispatch record's target so the webhook
  // produces the same sensorId as the sync path did when first dispatched.
  let sourceMappingId = sourceMappingIdRaw;
  let agentDefault = typeof body['agent'] === 'string' ? body['agent'] : '';
  if (dispatchId !== '') {
    const rec = dispatchLedger.get(dispatchId);
    if (!rec) {
      res.status(404).json({ error: 'webhook references unknown dispatchId' });
      return;
    }
    if (agentDefault === '') agentDefault = rec.target;
  }
  if (agentDefault === '') agentDefault = 'openai';

  // Pull values either directly from the parsed payload or via the
  // mapping's extract+normalize pipeline (same pipeline the adapter
  // applies on the sync path, so async/sync webhooks land identically).
  let values = extractValuesFromParsed(parsed);
  if (!values && sourceMappingId !== '') {
    const mapping = integrationRegistry.sourceMappingIndex.get(sourceMappingId);
    if (mapping) {
      const extract = (mapping.extract ?? { type: 'passthrough' as const }) as ExtractSpec;
      const normalize = mapping.normalize as NormalizeSpec | undefined;
      try {
        values = applyNormalize(applyExtract(parsed, extract), normalize);
      } catch (err: any) {
        res.status(400).json({ error: `webhook extract failed: ${err?.message ?? err}` });
        return;
      }
    }
  }
  if (!values || values.length === 0) {
    res.status(400).json({ error: 'webhook produced no commit-able values' });
    return;
  }

  // Build the completion body and route through the same internal
  // helper /api/integrations/completions uses.  This keeps the
  // wire-shape identical to the sync path.
  const resolved = resolveCompletion({
    provider: 'openai',
    agent: agentDefault,
    correlationId,
    envelopeId,
    completionId: typeof body['id'] === 'string' ? body['id'] : undefined,
    sourceMappingId: sourceMappingId !== '' ? sourceMappingId : undefined,
    values,
    metadata: { ...metadata, raw: parsed },
  }, integrationRegistry);

  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }
  const { signal, ctx } = resolved;
  const result = await ingestSignal({
    sensorId: signal.sensorId,
    name: signal.name,
    region: signal.region,
    values: signal.values,
    active: signal.active,
    ttlMs: signal.ttlMs,
    triggerPush: false,
    compactPush: true,
  });
  if (result.status < 200 || result.status >= 300) {
    res.status(result.status).json(result.body);
    return;
  }

  const receivedAt = Date.now();
  broadcast({
    type: 'agent.completion.received',
    provider: ctx.provider,
    agent: ctx.agent,
    sensorId: signal.sensorId,
    sourceMappingId: ctx.sourceMappingId,
    correlationId: ctx.correlationId,
    envelopeId: ctx.envelopeId,
    timestamp: receivedAt,
    source: 'openai.webhook',
  });
  res.json({
    success: true,
    timestamp: receivedAt,
    completion: {
      provider: ctx.provider,
      agent: ctx.agent,
      sensorId: signal.sensorId,
      sourceMappingId: ctx.sourceMappingId,
      correlationId: ctx.correlationId,
      envelopeId: ctx.envelopeId,
      dispatchId,
      receivedAt,
    },
    signal: result.body,
  });
});

// POST /api/integrations/healthkit/bridge — compat alias for /ingest.
// Canonical path is /api/integrations/healthkit/ingest (defined below);
// existing clients that already use /bridge continue to work unchanged.
app.post('/api/integrations/healthkit/bridge', (req: Request, res: Response) =>
  handleHealthKitIngest(req, res));

// ── CareKit bridge ────────────────────────────────────────────────────────────
// Wire-compatible with RealityEngine_CPP (ingest_carekit / carekit_status) and
// RealityEngine_LSP (ingest-carekit / carekit-status-json).
//
// Auth: optional bridgeToken field in the request body (matches CPP / LSP).
// The native Apple app owns the CareKit store; PE receives pre-normalised
// task/outcome payloads and maps each onto a sensor source.

// GET /api/integrations/carekit/status — bridge configuration + contract info.
app.get('/api/integrations/carekit/status', (_req: Request, res: Response) => {
  // Registry entry wins over env vars when present.
  const integrations = Array.isArray(integrationRegistry.config.integrations)
    ? (integrationRegistry.config.integrations as Array<Record<string, unknown>>)
    : [];
  const entry = integrations.find((i) => i['kind'] === 'carekit');
  const effectiveBridgeId = typeof entry?.['bridgeId'] === 'string' ? entry['bridgeId'] : careKitBridgeId;
  const effectiveMappingId = typeof entry?.['defaultSourceMappingId'] === 'string'
    ? entry['defaultSourceMappingId'] : careKitDefaultSourceMappingId;
  const tokenConfigured = careKitBridgeToken !== '' || typeof entry?.['bridgeToken'] === 'string';
  res.json(buildCKStatusBody(effectiveBridgeId, effectiveMappingId, tokenConfigured));
});

// POST /api/integrations/carekit/ingest — single sample or batch.
// Resolves each sample through the registry source mappings, applies the
// normalize pipeline, and ingests via the same in-process path as all other
// providers.  Returns 200 on full success, 207 on partial batch failure.
app.post('/api/integrations/carekit/ingest', async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as CKIngestPayload)
    : null;
  if (!body) {
    res.status(400).json({ error: 'CareKit ingest body must be a JSON object' });
    return;
  }

  // Registry entry bridgeToken overrides env var (allows per-bridge tokens).
  const integrations = Array.isArray(integrationRegistry.config.integrations)
    ? (integrationRegistry.config.integrations as Array<Record<string, unknown>>)
    : [];
  const entry = integrations.find((i) => i['kind'] === 'carekit');
  const effectiveBridgeId = typeof entry?.['bridgeId'] === 'string' ? entry['bridgeId'] : careKitBridgeId;
  const effectiveMappingId = typeof entry?.['defaultSourceMappingId'] === 'string'
    ? entry['defaultSourceMappingId'] : careKitDefaultSourceMappingId;
  const expectedToken = (typeof entry?.['bridgeToken'] === 'string' && entry['bridgeToken'] !== '')
    ? entry['bridgeToken'] as string
    : careKitBridgeToken !== '' ? careKitBridgeToken : undefined;

  if (!checkCareKitAuth(expectedToken, body)) {
    res.status(401).json({ error: 'CareKit bridge token rejected' });
    return;
  }

  const { results } = resolveCKBatch(body, integrationRegistry, effectiveBridgeId, effectiveMappingId);

  const ingested: Array<Record<string, unknown>> = [];
  const failed: Array<{ sampleType: string; reason: string }> = [];

  for (const r of results) {
    if (!r.success) {
      failed.push({ sampleType: r.sampleType, reason: r.reason });
      continue;
    }
    const ingestResult = await ingestSignal({
      sensorId: r.sensorId,
      region: r.region,
      values: r.values,
      active: true,
      ttlMs: r.ttlMs,
      triggerPush: false,
      compactPush: true,
    });
    if (ingestResult.status >= 200 && ingestResult.status < 300) {
      ingested.push({
        sampleType: r.sampleType,
        taskId: r.taskId,
        carePlanId: r.carePlanId,
        sourceMappingId: r.sourceMappingId,
        sensorId: r.sensorId,
      });
    } else {
      failed.push({ sampleType: r.sampleType, reason: String((ingestResult.body as Record<string, unknown>)['error'] ?? ingestResult.status) });
    }
  }

  if (ingested.length > 0) void doPush();

  broadcast({
    type: 'carekit.ingest',
    bridgeId: effectiveBridgeId,
    samples: results.length,
    success: failed.length === 0,
    timestamp: Date.now(),
  });

  const httpStatus = failed.length === 0 ? 200 : 207;

  res.status(httpStatus).json({
    success: failed.length === 0,
    bridgeId: effectiveBridgeId,
    results: [...ingested.map((r) => ({ ...r, success: true })), ...failed.map((r) => ({ ...r, success: false }))],
  });
});

// ── ACP / OpenClaw xACP provider surface ─────────────────────────────────────
// Wire-compatible with RealityEngine_CPP (acp_status / dispatch_acp).  This
// records an accepted handoff only; PE never launches OpenClaw or waits for ACP
// output.  Finished work returns through /api/integrations/completions.

// GET /api/integrations/acp/status — OpenClaw xACP handoff configuration.
app.get('/api/integrations/acp/status', (_req: Request, res: Response) => {
  res.json(acpAdapter.status());
});

// POST /api/integrations/acp/dispatch — annotate a ledger record with an
// accepted no-wait ACP/OpenClaw receipt.  Body: { dispatchId } or { id }.
app.post('/api/integrations/acp/dispatch', (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : null;
  if (!body) {
    res.status(400).json({ error: 'ACP dispatch body must be a JSON object' });
    return;
  }
  const dispatchId = typeof body['dispatchId'] === 'string' ? body['dispatchId']
    : typeof body['id'] === 'string' ? body['id'] : '';
  if (dispatchId === '') {
    res.status(400).json({ error: 'ACP dispatch requires dispatchId' });
    return;
  }
  const record = dispatchLedger.get(dispatchId);
  if (!record) {
    res.status(404).json({ error: 'Dispatch record not found' });
    return;
  }

  const metadata = body['metadata'] && typeof body['metadata'] === 'object' && !Array.isArray(body['metadata'])
    ? body['metadata'] as Record<string, unknown>
    : undefined;
  const receipt = acpAdapter.accept(record.envelope, record, {
    agent: typeof body['targetAgent'] === 'string' ? body['targetAgent']
      : typeof body['agent'] === 'string' ? body['agent'] : undefined,
    sessionKey: typeof body['sessionKey'] === 'string' ? body['sessionKey'] : undefined,
    sourceMappingId: typeof body['sourceMappingId'] === 'string' ? body['sourceMappingId'] : undefined,
    prompt: typeof body['prompt'] === 'string' ? body['prompt'] : undefined,
    externalRunId: typeof body['externalRunId'] === 'string' ? body['externalRunId'] : undefined,
    command: typeof body['command'] === 'string' ? body['command'] : undefined,
    gatewayUrl: typeof body['gatewayUrl'] === 'string' ? body['gatewayUrl'] : undefined,
    metadata,
  });

  const updated = dispatchLedger.update(dispatchId, {
    status: typeof body['status'] === 'string' ? body['status'] : 'accepted',
    adapter: receipt.adapter,
    provider: receipt.provider,
    externalRunId: receipt.externalRunId,
    incrementAttempts: body['incrementAttempts'] !== false,
    clearError: true,
    providerReceipt: receipt.metadata,
  });
  if (updated) broadcast(dispatchLedger.toUpdatedEvent(updated));

  res.status(202).json({
    success: true,
    accepted: true,
    dispatchId,
    provider: 'acp',
    platform: acpConfig.platform ?? 'OpenClaw',
    surface: acpConfig.surface ?? 'xACP',
    externalRunId: receipt.externalRunId,
    noWaitDispatch: true,
    handoff: receipt.metadata,
  });
});

// ── Ollama provider surface ───────────────────────────────────────────────────
// Wire-compatible with RealityEngine_CPP (ollama_status / ollama_dispatch) and
// RealityEngine_LSP (ollama-status-json / ollama-dispatch-json).

// GET /api/integrations/ollama/status — configuration + reachability probe.
app.get('/api/integrations/ollama/status', async (_req: Request, res: Response) => {
  const integrations = Array.isArray(integrationRegistry.config.integrations)
    ? (integrationRegistry.config.integrations as Array<Record<string, unknown>>)
    : [];
  const entry = integrations.find((i) => i['kind'] === 'ollama');
  const baseUrl = (typeof entry?.['baseUrl'] === 'string' ? entry['baseUrl']
    : process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434').replace(/\/$/, '');
  const model = typeof entry?.['model'] === 'string' ? entry['model']
    : process.env['OLLAMA_MODEL'] ?? '';
  const completionSourceMappingId = typeof entry?.['completionSourceMappingId'] === 'string'
    ? entry['completionSourceMappingId']
    : process.env['OLLAMA_COMPLETION_SOURCE_MAPPING_ID'] ?? '';

  let reachable = false;
  let tags: string[] = [];
  let probeError: string | undefined;
  try {
    const resp = await axios.get<{ models?: Array<{ name?: string }> }>(
      `${baseUrl}/api/tags`, { timeout: 3000 });
    reachable = resp.status >= 200 && resp.status < 300;
    tags = (Array.isArray(resp.data?.models) ? resp.data.models : [])
      .map((m) => (typeof m?.name === 'string' ? m.name : ''))
      .filter(Boolean);
  } catch (err: any) {
    probeError = err?.message ?? String(err);
  }

  const body: Record<string, unknown> = {
    baseUrl,
    model,
    completionSourceMappingId,
    reachable,
    tags,
    statusEndpoint: '/api/integrations/ollama/status',
    dispatchEndpoint: '/api/integrations/ollama/dispatch',
  };
  if (probeError) body['error'] = probeError;
  res.json(body);
});

// POST /api/integrations/ollama/dispatch — manually fire a ledger record through
// the Ollama adapter (awaited, returns receipt).  Body: { id: string }.
app.post('/api/integrations/ollama/dispatch', async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : null;
  const dispatchId = typeof body?.['id'] === 'string' ? body['id']
    : typeof body?.['dispatchId'] === 'string' ? body['dispatchId'] : '';
  if (!dispatchId) {
    res.status(400).json({ error: 'body.id (dispatchId) is required' });
    return;
  }
  const record = dispatchLedger.get(dispatchId);
  if (!record) {
    res.status(404).json({ error: 'dispatch record not found' });
    return;
  }
  const adapter = adapterPipeline.getAdapter('ollama');
  if (!adapter) {
    res.status(503).json({ error: 'no ollama adapter registered (enable an ollama integration in INTEGRATIONS_CONFIG)' });
    return;
  }
  const receipt = await adapterPipeline.runSync(adapter, record.envelope, record);
  res.json({ success: receipt.status !== 'failed', dispatchId, receipt });
});

// ── OpenAI provider surface ───────────────────────────────────────────────────
// Wire-compatible with RealityEngine_CPP (openai_status / openai_dispatch) and
// RealityEngine_LSP (openai-status-json / openai-dispatch-json).

// GET /api/integrations/openai/status — configuration + reachability probe.
app.get('/api/integrations/openai/status', async (_req: Request, res: Response) => {
  const integrations = Array.isArray(integrationRegistry.config.integrations)
    ? (integrationRegistry.config.integrations as Array<Record<string, unknown>>)
    : [];
  const entry = integrations.find((i) => i['kind'] === 'openai');
  const baseUrl = (typeof entry?.['baseUrl'] === 'string' ? entry['baseUrl']
    : process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = typeof entry?.['model'] === 'string' ? entry['model']
    : process.env['OPENAI_MODEL'] ?? '';
  const apiKey = typeof entry?.['apiKey'] === 'string' ? entry['apiKey']
    : process.env['OPENAI_API_KEY'] ?? '';
  const completionSourceMappingId = typeof entry?.['completionSourceMappingId'] === 'string'
    ? entry['completionSourceMappingId']
    : process.env['OPENAI_COMPLETION_SOURCE_MAPPING_ID'] ?? '';
  const hasApiKey = apiKey !== '';

  let reachable = false;
  let models: string[] = [];
  let probeError: string | undefined;
  if (hasApiKey) {
    try {
      const resp = await axios.get<{ data?: Array<{ id?: string }> }>(
        `${baseUrl}/models`,
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 });
      reachable = resp.status >= 200 && resp.status < 300;
      models = (Array.isArray(resp.data?.data) ? resp.data.data : [])
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter(Boolean);
    } catch (err: any) {
      probeError = err?.message ?? String(err);
    }
  }

  const body: Record<string, unknown> = {
    baseUrl,
    model,
    hasApiKey,
    completionSourceMappingId,
    reachable,
    models,
    statusEndpoint: '/api/integrations/openai/status',
    dispatchEndpoint: '/api/integrations/openai/dispatch',
  };
  if (probeError) body['error'] = probeError;
  res.json(body);
});

// POST /api/integrations/openai/dispatch — manually fire a ledger record through
// the OpenAI adapter (awaited, returns receipt).  Body: { id: string }.
app.post('/api/integrations/openai/dispatch', async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : null;
  const dispatchId = typeof body?.['id'] === 'string' ? body['id']
    : typeof body?.['dispatchId'] === 'string' ? body['dispatchId'] : '';
  if (!dispatchId) {
    res.status(400).json({ error: 'body.id (dispatchId) is required' });
    return;
  }
  const record = dispatchLedger.get(dispatchId);
  if (!record) {
    res.status(404).json({ error: 'dispatch record not found' });
    return;
  }
  const adapter = adapterPipeline.getAdapter('openai');
  if (!adapter) {
    res.status(503).json({ error: 'no openai adapter registered (enable an openai integration in INTEGRATIONS_CONFIG)' });
    return;
  }
  const receipt = await adapterPipeline.runSync(adapter, record.envelope, record);
  res.json({ success: receipt.status !== 'failed', dispatchId, receipt });
});

// ── HealthKit provider surface (status + canonical ingest path) ───────────────
// Wire-compatible with RealityEngine_CPP (healthkit_status / ingest_healthkit)
// and RealityEngine_LSP (healthkit-status-json / ingest-healthkit).
// The existing /bridge path is kept as a compat alias.

// GET /api/integrations/healthkit/status — bridge configuration.
app.get('/api/integrations/healthkit/status', (_req: Request, res: Response) => {
  const integrations = Array.isArray(integrationRegistry.config.integrations)
    ? (integrationRegistry.config.integrations as Array<Record<string, unknown>>)
    : [];
  const entry = integrations.find((i) => i['kind'] === 'healthkit');
  const bridgeId = typeof entry?.['bridgeId'] === 'string' ? entry['bridgeId']
    : process.env['HEALTHKIT_BRIDGE_ID'] ?? 'healthkit-ios-bridge';
  const defaultSourceMappingId = typeof entry?.['defaultSourceMappingId'] === 'string'
    ? entry['defaultSourceMappingId']
    : process.env['HEALTHKIT_DEFAULT_SOURCE_MAPPING_ID'] ?? 'healthkit-activity';
  const tokenRequired = (process.env['HEALTHKIT_BRIDGE_TOKEN'] ?? '') !== ''
    || (typeof entry?.['apiKey'] === 'string' && entry['apiKey'] !== '');
  res.json({
    bridgeId,
    defaultSourceMappingId,
    tokenRequired,
    statusEndpoint: '/api/integrations/healthkit/status',
    ingestEndpoint: '/api/integrations/healthkit/ingest',
  });
});

// POST /api/integrations/healthkit/ingest — canonical ingest path.
// Delegates to the same handler logic as /bridge; /bridge kept as compat alias.
async function handleHealthKitIngest(req: Request, res: Response): Promise<void> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as HKBridgePayload)
    : null;
  if (!body || typeof body.bridgeId !== 'string' || body.bridgeId === '') {
    res.status(400).json({ error: 'body.bridgeId is required' });
    return;
  }
  if (!Array.isArray(body.samples) || body.samples.length === 0) {
    res.status(400).json({ error: 'body.samples must be a non-empty array' });
    return;
  }
  const presentedKey = (() => {
    const auth = req.headers['authorization'] ?? '';
    return typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : undefined;
  })();
  const authResult = checkBridgeAuth(integrationRegistry, body.bridgeId, presentedKey);
  if (!authResult.ok) {
    res.status(authResult.status).json({ error: authResult.error });
    return;
  }
  const { resolved, unmapped } = resolveHKBatch(body, integrationRegistry);
  const ingested: Array<Record<string, unknown>> = [];
  const failed: Array<{ sensorId: string; error: string }> = [];
  for (const sample of resolved) {
    const result = await ingestSignal({
      sensorId: sample.sensorId,
      name: sample.name,
      region: sample.region,
      values: sample.values,
      active: true,
      ttlMs: sample.ttlMs,
      triggerPush: false,
      compactPush: false,
    });
    if (result.status >= 200 && result.status < 300) {
      ingested.push({ sensorId: sample.sensorId, origin: sample.origin });
    } else {
      failed.push({ sensorId: sample.sensorId, error: String((result.body as Record<string, unknown>)['error'] ?? result.status) });
    }
  }
  if (ingested.length > 0) void doPush();
  const status = failed.length > 0 || unmapped.length > 0 ? 207 : 200;
  res.status(status).json({
    success: ingested.length > 0,
    bridgeId: body.bridgeId,
    anchorToken: body.anchorToken,
    ingested,
    failed,
    unmapped,
  });
}

app.post('/api/integrations/healthkit/ingest', handleHealthKitIngest);

// POST /api/integrations/completions — provider-neutral adapter that
// resolves a sourceMappingId (or inline mapping) and routes through
// ingestSignal().  Default behaviour is commit-only (triggerPush:false).
app.post('/api/integrations/completions', async (req: Request, res: Response) => {
  const resolved = resolveCompletion(req.body as CompletionRequest, integrationRegistry);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }
  const { signal, ctx } = resolved;

  const result = await ingestSignal({
    sensorId: signal.sensorId,
    name: signal.name,
    region: signal.region,
    values: signal.values,
    active: signal.active,
    ttlMs: signal.ttlMs,
    triggerPush: signal.triggerPush,
    compactPush: signal.compactPush,
  } satisfies SignalIngestBody as SignalIngestBody);

  if (result.status < 200 || result.status >= 300) {
    res.status(result.status).json(result.body);
    return;
  }

  const receivedAt = Date.now();
  const completion: Record<string, unknown> = {
    provider: ctx.provider,
    agent: ctx.agent,
    sensorId: signal.sensorId,
    sourceMappingId: ctx.sourceMappingId,
    correlationId: ctx.correlationId,
    envelopeId: ctx.envelopeId,
    completionId: ctx.completionId,
    receivedAt,
  };
  if (ctx.metadata) completion.metadata = ctx.metadata;

  // Wire-compatible with C++ broadcast in ingest_completion().  The
  // visualizer (Phase 6) subscribes to this event to refresh the ledger
  // drawer and flash the affected machine's tooltip.
  broadcast({
    type: 'agent.completion.received',
    provider: ctx.provider,
    agent: ctx.agent,
    sensorId: signal.sensorId,
    sourceMappingId: ctx.sourceMappingId,
    correlationId: ctx.correlationId,
    envelopeId: ctx.envelopeId,
    timestamp: receivedAt,
  });

  res.json({
    success: true,
    completion,
    signal: result.body,
  });
});

// Manual push
app.post('/api/push', async (_req: Request, res: Response) => {
  const result = await doPush();
  res.json(result);
});

// Auto push control
app.post('/api/auto/start', (req: Request, res: Response) => {
  const { intervalMs } = req.body;
  const ms = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 1000;
  startAuto(ms);
  res.json({ success: true, intervalMs: ms });
});

app.post('/api/auto/stop', (_req: Request, res: Response) => {
  stopAuto();
  res.json({ success: true });
});

// Update engine configuration (matchAlgorithm etc.)
app.patch('/api/config', async (req: Request, res: Response) => {
  const { matchAlgorithm } = req.body;
  if (matchAlgorithm !== undefined) {
    if (matchAlgorithm !== 'gte' && matchAlgorithm !== 'equals') {
      res.status(400).json({ error: 'matchAlgorithm must be "gte" or "equals"' });
      return;
    }
    engine.setMatchAlgorithm(matchAlgorithm as MatchAlgorithm);
    await saveAndBroadcast();
  }
  res.json({ success: true, matchAlgorithm: engine.matchAlgorithm });
});

// Reset engine step counter and test source indices
app.post('/api/reset', (_req: Request, res: Response) => {
  resetAndBroadcast();
  res.json({ success: true });
});

// Decorate sensor sources with derived freshness fields (ageMs, stale).
// Matches the LSP source-json shape so a single visualizer panel can show
// "stale sensor" badges across all three runtimes.
function decorateSources(sources: SourceConfig[]): Array<SourceConfig & { ageMs?: number; stale?: boolean }> {
  const now = Date.now();
  return sources.map(s => {
    if (s.type !== 'sensor') return s;
    const sensor = s as SensorSourceConfig;
    const age   = sensor.lastUpdated ? now - sensor.lastUpdated : 0;
    const stale = !!sensor.lastUpdated && sensor.ttlMs > 0 && age > sensor.ttlMs;
    return { ...sensor, ageMs: age, stale };
  });
}

// Source list
app.get('/api/sources', (_req: Request, res: Response) => {
  res.json({ sources: decorateSources(engine.getSources()) });
});

// Add source
app.post('/api/sources', async (req: Request, res: Response) => {
  try {
    const config = req.body as Omit<SourceConfig, 'id'>;
    if (!config.type || !config.name || !config.region) {
      res.status(400).json({ error: 'type, name, and region are required' });
      return;
    }
    const { offset, length } = config.region;
    if (typeof offset !== 'number' || typeof length !== 'number' || offset < 0 || length < 1 || offset >= VECTOR_SIZE) {
      res.status(400).json({ error: `region.offset must be 0–${VECTOR_SIZE - 1} and region.length must be ≥ 1` });
      return;
    }
    const source = engine.addSource(config);
    await saveAndBroadcast();
    res.json({ source });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update source
app.patch('/api/sources/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (req.body.region) {
    const { offset, length } = req.body.region;
    if (typeof offset === 'number' && (offset < 0 || offset >= VECTOR_SIZE)) {
      res.status(400).json({ error: `region.offset must be 0–${VECTOR_SIZE - 1}` });
      return;
    }
    if (typeof length === 'number' && length < 1) {
      res.status(400).json({ error: 'region.length must be ≥ 1' });
      return;
    }
  }
  const source = engine.updateSource(id, req.body);
  if (!source) {
    res.status(404).json({ error: 'Source not found' });
    return;
  }
  await saveAndBroadcast();
  res.json({ source });
});

// Delete source
app.delete('/api/sources/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const removed = engine.removeSource(id);
  if (!removed) {
    res.status(404).json({ error: 'Source not found' });
    return;
  }
  await saveAndBroadcast();
  res.json({ success: true });
});

// Sensor push endpoint
app.post('/api/sensors/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { values } = req.body;
  if (!Array.isArray(values)) {
    res.status(400).json({ error: 'values must be an array' });
    return;
  }
  const updated = engine.updateSensorValue(id, values);
  if (!updated) {
    res.status(404).json({ error: `No sensor source with sensorId "${id}"` });
    return;
  }
  const timestamp = Date.now();
  // Debounced: rapid sensor pushes coalesce into one broadcast per 50 ms window.
  scheduleSensorBroadcast();
  res.json({ success: true, sensorId: id, timestamp });
});

// MQTT bridge status — connection state, bridge counters, broker config.
// Returns enabled:false when MQTT_BROKER_URL was not set at PE startup.
app.get('/api/mqtt/status', (_req: Request, res: Response) => {
  if (!mqttBridge) { res.json({ enabled: false }); return; }
  res.json({
    enabled: true,
    connected: mqttBridge.isConnected(),
    bridge: mqttBridge.getStats(),
    mappings: mqttBridge.getRegistry().size,
  });
});

// MQTT mapping registry — the authoritative topic→region rules + per-
// mapping counters.  Per the design rule, topics carry no offset info;
// this endpoint shows the authority that decides projection into the
// perceptual vector.
app.get('/api/mqtt/mappings', (_req: Request, res: Response) => {
  if (!mqttBridge) { res.json({ enabled: false, mappings: [] }); return; }
  const body = mqttBridge.getRegistry().toJson() as { mappings: object[] };
  res.json({ enabled: true, ...body });
});

// PUT /api/mqtt/mappings — replace the in-memory mapping registry and
// restart the bridge with the new rules.  Body shape:
//   { defaults?: {...}, mappings: [ {...rules...} ] }
// Returns 200 + the new registry on success; 400 + error on schema /
// validation failure; 409 if no broker config exists (set MQTT_BROKER_URL
// at process startup before reloading).  Overlap warnings are non-fatal
// and returned in the response body — same gate as the env loader.
app.put('/api/mqtt/mappings', async (req: Request, res: Response) => {
  if (!mqttBrokerConfig) {
    res.status(409).json({
      error: 'no broker config — set MQTT_BROKER_URL at PE startup before reloading mappings',
    });
    return;
  }
  let registry: MappingRegistry;
  try {
    registry = MappingRegistry.fromJson(req.body);
  } catch (e: any) {
    res.status(400).json({ error: `schema: ${e?.message ?? e}` });
    return;
  }
  if (registry.size === 0) {
    res.status(400).json({ error: 'mappings array is empty — at least one rule is required' });
    return;
  }
  const allowOverlap = (process.env.MQTT_ALLOW_REGION_OVERLAP === '1' ||
                        process.env.MQTT_ALLOW_REGION_OVERLAP === 'true');
  const warnings = registry.validateOverlaps(allowOverlap);
  try {
    await bootMqttBridge(mqttBrokerConfig, registry);
  } catch (e: any) {
    res.status(500).json({ error: `bridge restart failed: ${e?.message ?? e}` });
    return;
  }
  res.json({
    success: true,
    enabled: !!mqttBridge,
    mappings: registry.size,
    warnings,
  });
});

// POST /api/mqtt/enable — runtime configurable bridge start.  Accepts a
// fresh BridgeConfig + mappings registry in one call.  Used by the
// MqttConfigModal in the PE visualizer when an operator wants to enable
// MQTT without restarting the PE process (i.e. without setting env vars).
//
// Body: {
//   brokerUrl:  "mqtt://host:port"  (required)
//   clientId?:  string
//   username?:  string
//   password?:  string
//   keepaliveSec?: number
//   mappings:   {...registry JSON...}  (required, same shape as PUT /api/mqtt/mappings)
// }
//
// Returns 200 + enabled/connected/mappings count on success; 400 on
// validation failure; 500 on bridge boot failure.
app.post('/api/mqtt/enable', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const brokerUrl: string | undefined = body.brokerUrl;
  if (!brokerUrl || typeof brokerUrl !== 'string') {
    res.status(400).json({ error: 'brokerUrl is required (e.g. "mqtt://yuma.lateraledge.cloud:1883")' });
    return;
  }
  if (!body.mappings) {
    res.status(400).json({ error: 'mappings is required (a registry object with a "mappings" array)' });
    return;
  }
  let registry: MappingRegistry;
  try {
    registry = MappingRegistry.fromJson(body.mappings);
  } catch (e: any) {
    res.status(400).json({ error: `mappings schema: ${e?.message ?? e}` });
    return;
  }
  if (registry.size === 0) {
    res.status(400).json({ error: 'mappings array is empty — at least one rule is required' });
    return;
  }
  const config: import('./MqttBridge.js').BridgeConfig = {
    brokerUrl,
    clientId:     typeof body.clientId === 'string' ? body.clientId : 'reality-engine-pe',
    username:     typeof body.username === 'string' ? body.username : undefined,
    password:     typeof body.password === 'string' ? body.password : undefined,
    keepaliveSec: typeof body.keepaliveSec === 'number' ? body.keepaliveSec : 60,
  };
  const allowOverlap = (process.env.MQTT_ALLOW_REGION_OVERLAP === '1' ||
                        process.env.MQTT_ALLOW_REGION_OVERLAP === 'true');
  const warnings = registry.validateOverlaps(allowOverlap);
  try {
    await bootMqttBridge(config, registry);
  } catch (e: any) {
    res.status(500).json({ error: `bridge boot failed: ${e?.message ?? e}` });
    return;
  }
  res.json({
    success:   true,
    enabled:   !!mqttBridge,
    connected: mqttBridge?.isConnected() ?? false,
    brokerUrl: config.brokerUrl,
    mappings:  registry.size,
    warnings,
  });
});

// POST /api/mqtt/disable — cleanly stops the bridge.  Idempotent.
app.post('/api/mqtt/disable', async (_req: Request, res: Response) => {
  if (mqttBridge) {
    try { await mqttBridge.stop(); }
    catch (e: any) { /* swallow — disable is best-effort */ }
    mqttBridge = null;
  }
  res.json({ success: true, enabled: false });
});

// GET /api/mqtt/example — bundled sample mapping registry.  Lets the
// PE visualizer's MqttConfigModal offer a "Load example" button without
// reaching out to the filesystem.  Returns the yuma-agriculture
// registry the demo binaries use.
app.get('/api/mqtt/example', (_req: Request, res: Response) => {
  res.json(EXAMPLE_MAPPINGS_JSON);
});

// GET /api/integrations/healthkit/example — bundled starter integration
// registry for the 12 most common HealthKit types.  Operators can save
// this as config/integrations.json (adding their own apiKey) and pass
// INTEGRATIONS_CONFIG=config/integrations.json to the PE.
app.get('/api/integrations/healthkit/example', (_req: Request, res: Response) => {
  res.json(EXAMPLE_HK_REGISTRY_JSON);
});

// GET /api/integrations/carekit/example — bundled starter registry.
// Wire-compatible with CPP / LSP: offset 4310, two standard source mappings.
app.get('/api/integrations/carekit/example', (_req: Request, res: Response) => {
  res.json(EXAMPLE_CK_REGISTRY_JSON);
});

// Machine listing — proxy from Reality Engine for use in the add-source form
app.get('/api/machines', async (_req: Request, res: Response) => {
  try {
    const response = await reAxios.get(`${REALITY_ENGINE_URL}/api/machines`);
    res.json(response.data);
  } catch (err: any) {
    res.status(err.response?.status || 502).json({ error: err.message });
  }
});

// POST /api/sources/bootstrap-from-machines — list machines on the RE and
// create a `test` source for every inputSequence we don't already have a
// source for.  Each created source is active+looping by default.  Returns
// the counts so the visualizer can surface "+N new sources" feedback.
app.post('/api/sources/bootstrap-from-machines', async (req: Request, res: Response) => {
  // Optional { machineIds: string[] } body — when present, restricts the
  // import to those machines.  Allows the frontend to compute a domain-
  // filtered allow-list client-side (it already has the classifier) and
  // pass it through without duplicating the classifier on the backend.
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const rawIds = Array.isArray((body as any).machineIds) ? (body as any).machineIds : null;
  let filter: { machineIds: Set<string> } | undefined;
  if (rawIds) {
    const ids = new Set<string>();
    for (const id of rawIds) if (typeof id === 'string' && id.length > 0) ids.add(id);
    filter = { machineIds: ids };
  }
  const result = await bootstrapMachineTestSources(filter);
  if (result.errors.length > 0 && result.created === 0) {
    res.status(502).json(result);
    return;
  }
  res.json(result);
});

// ── Start server ─────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const protocol = tlsEnabled ? 'HTTPS' : 'HTTP';
  console.log(`Perception Engine backend listening on port ${PORT} (${protocol})`);
  console.log(`  Reality Engine : ${REALITY_ENGINE_URL}`);
  // Fire and forget — bootstrap polls the RE until reachable, then materializes
  // a test source per machine inputSequence.  Never blocks listen().
  void bootstrapWithRetry();
});
