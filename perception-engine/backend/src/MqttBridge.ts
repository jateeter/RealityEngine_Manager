/**
 * MqttBridge — wires an MQTT broker subscription + MappingRegistry to the
 * Perception Engine's signal-ingest path.
 *
 * Design rule (per roadmap): MQTT is not special-cased downstream.  Every
 * accepted message resolves to {sensorId, region, values, ttlMs} and is
 * fed through the same engine.updateSensorValue / engine.addSource path
 * used by POST /api/sensors/:id.
 *
 * Twin of RealityEngine_CPP/src/mqtt_bridge.cpp and the deferred LSP
 * client driver — schema, push policy, and observability surfaces match.
 *
 * The actual broker driver is mqtt.js (the standard Node.js MQTT package),
 * imported lazily so the PE backend can build / run without the optional
 * dep when MQTT is disabled.  Disabled === MQTT_BROKER_URL unset.
 */

import { readFileSync } from 'fs';
import { MappingRegistry } from './MqttMapping.js';
import type { MappingRule } from './MqttMapping.js';

/** Lifted from the mqtt npm package — minimal shape we actually use. */
interface IMqttClient {
  on(event: 'connect',    cb: () => void): this;
  on(event: 'reconnect',  cb: () => void): this;
  on(event: 'close',      cb: () => void): this;
  on(event: 'error',      cb: (err: Error) => void): this;
  on(event: 'message',    cb: (topic: string, payload: Buffer, packet: { retain?: boolean }) => void): this;
  subscribe(topic: string | string[], opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): this;
  end(force?: boolean, opts?: object, cb?: () => void): this;
  connected: boolean;
}

export interface BridgeConfig {
  brokerUrl: string;                         // mqtt://host:1883 or mqtts://host:8883
  clientId?: string;
  username?: string;
  password?: string;
  keepaliveSec?: number;
  reconnectDelayMs?: number;
}

export interface IngestPayload {
  sensorId: string;
  offset: number;
  length: number;
  values: number[];
  ttlMs: number;
  topic: string;
  mappingId: string;
}

export type IngestCallback = (payload: IngestPayload) => void;
export type PushTrigger    = () => void;

export interface BridgeStats {
  messagesReceived:        number;
  messagesMapped:          number;
  messagesRejected:        number;
  messagesUnmatched:       number;
  messagesRetainedDropped: number;
  pushesTriggered:         number;
}

const ZERO_STATS: BridgeStats = {
  messagesReceived: 0, messagesMapped: 0, messagesRejected: 0,
  messagesUnmatched: 0, messagesRetainedDropped: 0, pushesTriggered: 0,
};

export class MqttBridge {
  private client: IMqttClient | null = null;
  private stats: BridgeStats = { ...ZERO_STATS };
  // Coalesced-push deadline per the design rule: one timer for the entire
  // bridge — the deadline always reflects the latest mapping's debounceMs
  // that fired.  Avoids per-mapping timer fan-out under high-rate ingest.
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly registry: MappingRegistry,
    private readonly ingest: IngestCallback,
    private readonly pushTrigger: PushTrigger,
  ) {}

  /**
   * Connect to the broker and subscribe to every unique topicFilter in
   * the registry.  Idempotent — calling start() after a previous start()
   * is a no-op.
   */
  async start(): Promise<void> {
    if (this.client) return;
    // Dynamically import so the dependency is only required when MQTT is
    // actually enabled — keeps the PE backend installable without `mqtt`
    // when only HTTP signal ingest is in use.
    let mqttPkg: any;
    try {
      // @ts-ignore — "mqtt" is declared as an optionalDependency.  TypeScript
      // can't resolve its declarations when it isn't installed; the runtime
      // path catches that case and throws a friendly error below.
      mqttPkg = await import('mqtt');
    } catch (e: any) {
      throw new Error(`MQTT bridge requires the "mqtt" npm package; install it under perception-engine/backend.  Underlying error: ${e.message}`);
    }
    const opts: Record<string, unknown> = {
      clientId:      this.config.clientId ?? 'reality-engine-pe',
      keepalive:     this.config.keepaliveSec ?? 60,
      reconnectPeriod: this.config.reconnectDelayMs ?? 2000,
      clean: true,
    };
    if (this.config.username) opts.username = this.config.username;
    if (this.config.password) opts.password = this.config.password;

    this.client = mqttPkg.connect(this.config.brokerUrl, opts);

    this.client!.on('connect', () => {
      this.connected = true;
      // Subscribe to every unique topicFilter — QoS is the maximum of any
      // rule that declared the same filter (highest wins).
      const uniq = new Map<string, number>();
      for (const r of this.registry.rules) {
        const existing = uniq.get(r.topicFilter);
        if (existing === undefined || existing < r.qos) uniq.set(r.topicFilter, r.qos);
      }
      for (const [topic, qos] of uniq) {
        const q = (qos === 0 || qos === 1 || qos === 2) ? qos : 0;
        this.client!.subscribe(topic, { qos: q as 0 | 1 | 2 });
      }
    });
    this.client!.on('close', () => { this.connected = false; });
    this.client!.on('error', (_err) => { /* mqtt.js will auto-reconnect — error path is non-fatal */ });
    this.client!.on('message', (topic, payload, packet) => {
      this.onMessage(topic, payload, packet);
    });
  }

  async stop(): Promise<void> {
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    if (!this.client) return;
    await new Promise<void>(resolve => this.client!.end(false, {}, () => resolve()));
    this.client = null;
    this.connected = false;
  }

  isConnected(): boolean { return this.connected && !!this.client?.connected; }

  getStats(): BridgeStats { return { ...this.stats }; }

  getRegistry(): MappingRegistry { return this.registry; }

  /**
   * Drive the bridge with a synthetic message — used by tests so the full
   * extract → normalize → ingest pipeline can be verified without a broker.
   */
  injectMessage(topic: string, payload: Uint8Array | Buffer | string, retain: boolean = false): void {
    const buf = typeof payload === 'string'
      ? Buffer.from(payload, 'utf-8')
      : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    this.onMessage(topic, buf, { retain });
  }

  // ── Inbound dispatch ─────────────────────────────────────────────────────

  private onMessage(topic: string, payload: Buffer, packet: { retain?: boolean }): void {
    this.stats.messagesReceived += 1;
    // Fan out to every rule whose filter matches.  A single PUBLISH on a
    // multi-field sensor topic often drives many mappings (one per
    // JSON-pointer extraction).
    const matches = this.registry.matchAll(topic);
    if (matches.length === 0) { this.stats.messagesUnmatched += 1; return; }

    let anyImmediate = false;
    let minDebounce = -1;

    for (const match of matches) {
      const rule    = this.registry.rules[match.ruleIndex];
      const metrics = this.registry.metrics[match.ruleIndex];

      if (packet.retain && !rule.acceptRetained) {
        this.stats.messagesRetainedDropped += 1;
        continue;
      }

      metrics.received += 1;
      metrics.lastMessageAtMs = Date.now();

      const decoded = this.registry.decode(rule, payload);
      if (!decoded.valid) {
        metrics.rejected += 1;
        metrics.lastError = `[${topic}] ${decoded.error}`;
        metrics.lastErrorAtMs = Date.now();
        this.stats.messagesRejected += 1;
        continue;
      }
      const sensorId = this.registry.resolveSensorId(rule, topic, match.captures);
      this.ingest({
        sensorId, offset: rule.region.offset, length: rule.region.length,
        values: decoded.values, ttlMs: rule.ttlMs, topic, mappingId: rule.id,
      });
      metrics.mapped += 1;
      this.stats.messagesMapped += 1;

      if (rule.pushMode === 'immediate') anyImmediate = true;
      else if (rule.pushMode === 'debounced') {
        if (minDebounce < 0 || rule.debounceMs < minDebounce) minDebounce = rule.debounceMs;
      }
    }

    // Push policy across the fan-out: a single Immediate wins over any
    // Debounced; otherwise schedule one debounced push using the smallest
    // declared window — never one push per fan-out branch.
    if (anyImmediate) {
      this.pushTrigger();
      this.stats.pushesTriggered += 1;
    } else if (minDebounce >= 0) {
      this.schedulePush(minDebounce);
    }
  }

  private schedulePush(debounceMs: number): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushTrigger();
      this.stats.pushesTriggered += 1;
    }, debounceMs);
  }
}

// ── Env-driven config loader ────────────────────────────────────────────────

export interface EnvBridge {
  config: BridgeConfig;
  registry: MappingRegistry;
  allowOverlap: boolean;
}

/**
 * Build a bridge config from MQTT_* environment variables.  Returns null
 * when MQTT_BROKER_URL is unset (the disabled case).  Supports either
 * MQTT_MAPPINGS_FILE (path) or MQTT_MAPPINGS_JSON (inline) for the
 * registry source.
 */
/**
 * Default broker URL used when MQTT_BROKER_URL is unset.  Points at the
 * Lateral Edge sensor mesh that the live yuma demonstration runs against
 * — operators get a sensible target without configuration.  Setting
 * MQTT_BROKER_URL='' (empty string) or MQTT_DISABLED=1 explicitly opts
 * out.  Bridge still requires MQTT_MAPPINGS_FILE / MQTT_MAPPINGS_JSON
 * before it actually boots; without mappings the broker URL is meaningless.
 */
export const DEFAULT_MQTT_BROKER_URL = 'mqtt://yuma.lateraledge.cloud:1883';

export function fromEnvironment(env: NodeJS.ProcessEnv = process.env): EnvBridge | null {
  // Explicit opt-out — empty MQTT_BROKER_URL or MQTT_DISABLED=1 keeps
  // the bridge off even if mappings are present.
  if (env['MQTT_DISABLED'] === '1' || env['MQTT_DISABLED'] === 'true') return null;
  if (env['MQTT_BROKER_URL'] === '') return null;
  let brokerUrl = env['MQTT_BROKER_URL'];
  if (!brokerUrl) {
    if (env['MQTT_BROKER_HOST']) {
      const port = env['MQTT_BROKER_PORT'] ?? '1883';
      brokerUrl = `mqtt://${env['MQTT_BROKER_HOST']}:${port}`;
    } else {
      brokerUrl = DEFAULT_MQTT_BROKER_URL;
    }
  }

  const config: BridgeConfig = {
    brokerUrl,
    clientId:        env['MQTT_CLIENT_ID']        ?? 'reality-engine-pe',
    username:        env['MQTT_USERNAME']         ?? undefined,
    password:        env['MQTT_PASSWORD']         ?? undefined,
    keepaliveSec:    env['MQTT_KEEPALIVE']    ? parseInt(env['MQTT_KEEPALIVE']!, 10) : undefined,
    reconnectDelayMs: env['MQTT_RECONNECT_MS'] ? parseInt(env['MQTT_RECONNECT_MS']!, 10) : undefined,
  };

  let registry: MappingRegistry | null = null;
  try {
    if (env['MQTT_MAPPINGS_FILE']) {
      const raw = readFileSync(env['MQTT_MAPPINGS_FILE']!, 'utf-8');
      registry = MappingRegistry.fromJson(JSON.parse(raw));
    } else if (env['MQTT_MAPPINGS_JSON']) {
      registry = MappingRegistry.fromJson(JSON.parse(env['MQTT_MAPPINGS_JSON']!));
    }
  } catch (e: any) {
    console.error(`MQTT mappings parse error: ${e.message} — bridge disabled`);
    return null;
  }
  if (!registry || registry.size === 0) {
    console.error('MQTT_BROKER_URL set but no mappings resolved — bridge disabled');
    return null;
  }
  const allowOverlap = (env['MQTT_ALLOW_REGION_OVERLAP'] === '1' ||
                        env['MQTT_ALLOW_REGION_OVERLAP'] === 'true');
  for (const w of registry.validateOverlaps(allowOverlap)) {
    console.warn(`MQTT mapping warning: ${w}`);
  }
  return { config, registry, allowOverlap };
}
