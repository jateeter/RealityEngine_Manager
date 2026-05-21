/**
 * AcpAdapter — no-wait ACP/OpenClaw xACP handoff.
 *
 * The PE records that an external ACP runner accepted responsibility for a
 * dispatch record, then returns immediately.  It deliberately does not launch
 * OpenClaw, host an ACP session, or wait for ACP output.  Finished ACP work
 * must return through POST /api/integrations/completions with provider:"acp".
 */

import type { DispatchRecord } from '../../dispatch/types.js';
import type { IntegrationEntry } from '../types.js';
import type { TriggerEnvelope } from '../../triggers/types.js';
import type { AdapterDeps, DispatchReceipt, ProviderAdapter } from './types.js';

export interface AcpIntegrationCfg extends IntegrationEntry {
  kind: 'acp' | 'openclaw-acp';
  platform?: string;
  surface?: string;
  command?: string;
  gatewayUrl?: string;
  sessionKey?: string;
  targetAgent?: string;
  completionSourceMappingId?: string;
  dispatchMode?: string;
  completionMode?: string;
}

export interface AcpDispatchOptions {
  agent?: string;
  sessionKey?: string;
  sourceMappingId?: string;
  prompt?: string;
  externalRunId?: string;
  command?: string;
  gatewayUrl?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_PLATFORM = 'OpenClaw';
const DEFAULT_SURFACE = 'xACP';
const DEFAULT_COMMAND = 'openclaw acp';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_SESSION_KEY = 'agent:main:main';
const DEFAULT_TARGET_AGENT = 'openclaw';
const DEFAULT_COMPLETION_MAPPING = 'agent-completion-risk';
const DEFAULT_PROMPT = 'Handle this RealityEngine trigger envelope through the configured OpenClaw ACP session and return a PE completion values array.';

export class AcpAdapter implements ProviderAdapter {
  public readonly kind = 'acp';
  public readonly id?: string;

  private now: () => number = Date.now;
  private cfg!: AcpIntegrationCfg;

  async init(cfg: IntegrationEntry, deps: AdapterDeps): Promise<void> {
    this.cfg = cfg as AcpIntegrationCfg;
    if (deps.now) this.now = deps.now;
    (this as { id?: string }).id = cfg.id;
  }

  async dispatch(envelope: TriggerEnvelope, record: DispatchRecord): Promise<DispatchReceipt> {
    return this.accept(envelope, record);
  }

  accept(
    envelope: TriggerEnvelope,
    record: DispatchRecord,
    opts: AcpDispatchOptions = {},
  ): DispatchReceipt {
    const t0 = this.now();
    const targetAgent = opts.agent ?? envelope.dispatch.agent ?? record.target ?? this.targetAgent();
    const externalRunId = opts.externalRunId ?? makeHandoffId(this.now);
    const sourceMappingId = opts.sourceMappingId ?? this.completionSourceMappingId();
    const metadata: Record<string, unknown> = {
      protocol: 'ACP',
      surface: this.surface(),
      platform: this.platform(),
      adapter: 'openclaw-xacp',
      command: opts.command ?? this.command(),
      gatewayUrl: opts.gatewayUrl ?? this.gatewayUrl(),
      sessionKey: (opts.sessionKey ?? this.sessionKey()) || null,
      targetAgent,
      completionEndpoint: '/api/integrations/completions',
      completionSourceMappingId: sourceMappingId,
      noWaitDispatch: true,
      prompt: opts.prompt ?? DEFAULT_PROMPT,
      dispatchId: record.id,
      envelopeId: envelope.envelopeId,
      correlationId: envelope.correlationId,
    };
    if (opts.metadata) metadata['metadata'] = opts.metadata;
    return {
      provider: 'acp',
      adapter: 'openclaw-xacp',
      latencyMs: this.now() - t0,
      status: 'sent',
      externalRunId,
      metadata,
    };
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.cfg?.enabled === true,
      platform: this.platform(),
      surface: this.surface(),
      adapter: 'openclaw-xacp',
      command: this.command(),
      gatewayUrl: this.gatewayUrl() || null,
      sessionKey: this.sessionKey() || null,
      targetAgent: this.targetAgent(),
      completionSourceMappingId: this.completionSourceMappingId(),
      dispatchEndpoint: '/api/integrations/acp/dispatch',
      completionEndpoint: '/api/integrations/completions',
      dispatchMode: this.dispatchMode(),
      completionMode: this.completionMode(),
      semantics: {
        dispatch: 'Record an ACP/OpenClaw handoff receipt only; do not run or wait for the harness in the PE cycle.',
        completion: 'External ACP/OpenClaw adapters commit finished results through /api/integrations/completions.',
      },
    };
  }

  async shutdown(): Promise<void> { /* no-op */ }

  private platform(): string { return this.cfg?.platform ?? process.env['ACP_PLATFORM'] ?? DEFAULT_PLATFORM; }
  private surface(): string { return this.cfg?.surface ?? process.env['ACP_SURFACE'] ?? DEFAULT_SURFACE; }
  private command(): string {
    return this.cfg?.command
      ?? process.env['ACP_COMMAND']
      ?? process.env['OPENCLAW_ACP_COMMAND']
      ?? DEFAULT_COMMAND;
  }
  private gatewayUrl(): string {
    return this.cfg?.gatewayUrl
      ?? process.env['ACP_GATEWAY_URL']
      ?? process.env['OPENCLAW_GATEWAY_URL']
      ?? DEFAULT_GATEWAY_URL;
  }
  private sessionKey(): string {
    return this.cfg?.sessionKey
      ?? process.env['ACP_SESSION_KEY']
      ?? process.env['OPENCLAW_ACP_SESSION']
      ?? DEFAULT_SESSION_KEY;
  }
  private targetAgent(): string { return this.cfg?.targetAgent ?? process.env['ACP_TARGET_AGENT'] ?? DEFAULT_TARGET_AGENT; }
  private completionSourceMappingId(): string {
    return this.cfg?.completionSourceMappingId
      ?? process.env['ACP_COMPLETION_SOURCE_MAPPING_ID']
      ?? DEFAULT_COMPLETION_MAPPING;
  }
  private dispatchMode(): string { return this.cfg?.dispatchMode ?? 'accepted-no-wait'; }
  private completionMode(): string { return this.cfg?.completionMode ?? 'pe-source-mapping'; }
}

export function acpConfigFromRegistry(entries: IntegrationEntry[]): AcpIntegrationCfg {
  const found = entries.find((i) => i && (i.kind === 'acp' || i.kind === 'openclaw-acp'));
  return {
    id: found?.id ?? 'openclaw-xacp',
    kind: (found?.kind as 'acp' | 'openclaw-acp' | undefined) ?? 'acp',
    enabled: found?.enabled === true || truthy(process.env['ACP_ENABLED']),
    platform: stringField(found, 'platform') ?? process.env['ACP_PLATFORM'] ?? DEFAULT_PLATFORM,
    surface: stringField(found, 'surface') ?? process.env['ACP_SURFACE'] ?? DEFAULT_SURFACE,
    command: stringField(found, 'command') ?? process.env['ACP_COMMAND'] ?? process.env['OPENCLAW_ACP_COMMAND'] ?? DEFAULT_COMMAND,
    gatewayUrl: stringField(found, 'gatewayUrl') ?? process.env['ACP_GATEWAY_URL'] ?? process.env['OPENCLAW_GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL,
    sessionKey: stringField(found, 'sessionKey') ?? process.env['ACP_SESSION_KEY'] ?? process.env['OPENCLAW_ACP_SESSION'] ?? DEFAULT_SESSION_KEY,
    targetAgent: stringField(found, 'targetAgent') ?? process.env['ACP_TARGET_AGENT'] ?? DEFAULT_TARGET_AGENT,
    completionSourceMappingId: stringField(found, 'completionSourceMappingId') ?? process.env['ACP_COMPLETION_SOURCE_MAPPING_ID'] ?? DEFAULT_COMPLETION_MAPPING,
    dispatchMode: stringField(found, 'dispatchMode') ?? 'accepted-no-wait',
    completionMode: stringField(found, 'completionMode') ?? 'pe-source-mapping',
  };
}

function stringField(entry: IntegrationEntry | undefined, key: string): string | undefined {
  const value = entry?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function makeHandoffId(now: () => number): string {
  return `acp-handoff-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
