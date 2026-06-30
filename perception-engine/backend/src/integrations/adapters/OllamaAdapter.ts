/**
 * OllamaAdapter — local LLM provider, picked first because it's the
 * lowest-friction case: no secrets, no managed-agent runtime, no
 * webhooks.  The adapter:
 *
 *   1. Receives an envelope + dispatch record (from the pipeline).
 *   2. Builds a structured-output chat request asking the model to
 *      produce a JSON object that satisfies the source mapping's
 *      `extract` block.
 *   3. Calls either Ollama's native `/api/chat` or its OpenAI-compatible
 *      `/v1/chat/completions` endpoint (selectable via `apiMode`).
 *   4. Parses the JSON, applies extract + normalize from the mapping,
 *      and POSTs the numeric vector to `/api/integrations/completions`.
 *   5. Returns a {@link DispatchReceipt} so the pipeline can PATCH the
 *      ledger record with delivery metadata.
 *
 * Validation is intentionally permissive: missing extract pointers
 * coerce to `0` rather than failing the dispatch.  Phase 4 follow-ups
 * may add strict zod schemas per integration.
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';

import {
  applyExtract, applyNormalize,
  type ExtractSpec, type NormalizeSpec,
} from '../extractors.js';
import type { DispatchRecord } from '../../dispatch/types.js';
import type { IntegrationEntry } from '../types.js';
import type { TriggerEnvelope } from '../../triggers/types.js';
import type { AdapterDeps, DispatchReceipt, ProviderAdapter } from './types.js';

export type OllamaApiMode = 'native' | 'openai-compat';

export interface OllamaIntegrationCfg extends IntegrationEntry {
  kind: 'ollama';
  baseUrl?: string;
  model?: string;
  apiMode?: OllamaApiMode;
  /** Source-mapping id to commit completions through. */
  completionSourceMappingId?: string;
  sourceMappingId?: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Outbound request timeout in ms.  Default: 60_000. */
  timeoutMs?: number;
  /** Override the chat path. */
  chatPath?: string;
  /** Force a fixed integration id (defaults to entry.id). */
  ollamaId?: string;
}

export interface OllamaAdapterOptions {
  /** Allow injecting a stub HTTP client in tests. */
  http?: AxiosInstance;
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are a Reality Engine Critical-Event-Sequence (CES) responder.',
  'You will receive a CES terminal-event envelope as JSON.',
  'Reply with ONE JSON object only — no prose, no markdown fences.',
  'The shape of the JSON object must match the "schemaHint" the user supplies.',
  'When a field expects a confidence, return a number in [0, 1].',
  'When a field expects a boolean, return true or false.',
  'When uncertain, prefer conservative values (zero/false).',
].join(' ');

export class OllamaAdapter implements ProviderAdapter {
  public readonly kind = 'ollama';
  public readonly id?: string;

  private readonly http: AxiosInstance;
  private now: () => number;
  private cfg!: OllamaIntegrationCfg;
  private deps!: AdapterDeps;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.http = opts.http ?? axios.create();
    this.now = Date.now;
  }

  async init(cfg: IntegrationEntry, deps: AdapterDeps): Promise<void> {
    this.cfg = cfg as OllamaIntegrationCfg;
    this.deps = deps;
    // Inject a now() if provided through deps (handy for deterministic latency in tests).
    if (deps.now) this.now = deps.now;
    (this as { id?: string }).id = cfg.id;
  }

  async dispatch(envelope: TriggerEnvelope, _record: DispatchRecord): Promise<DispatchReceipt> {
    const t0 = this.now();
    const mappingId = resolveCompletionSourceMappingId(this.cfg);
    const mapping = mappingId
      ? this.deps.registry.sourceMappingIndex.get(mappingId)
      : undefined;

    const extract = (mapping?.extract ?? { type: 'passthrough' as const }) as ExtractSpec;
    const normalize = mapping?.normalize as NormalizeSpec | undefined;
    const expectedFields = listExpectedFields(extract);

    const userPayload = {
      schemaHint: buildSchemaHint(extract, expectedFields),
      envelope,
    };

    const baseUrl = (this.cfg.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    const model = this.cfg.model ?? 'llama3.1:latest';
    const apiMode: OllamaApiMode = this.cfg.apiMode ?? 'native';
    const systemPrompt = this.cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const timeoutMs = this.cfg.timeoutMs ?? 60_000;

    let parsed: unknown;
    let externalRunId: string | undefined;
    let modelUsed = model;
    try {
      if (apiMode === 'openai-compat') {
        const url = baseUrl + (this.cfg.chatPath ?? '/v1/chat/completions');
        const resp = await this.http.post(url, {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPayload) },
          ],
          response_format: { type: 'json_object' },
          stream: false,
        }, { timeout: timeoutMs });
        externalRunId = typeof resp.data?.id === 'string' ? resp.data.id : undefined;
        modelUsed = typeof resp.data?.model === 'string' ? resp.data.model : model;
        const content = resp.data?.choices?.[0]?.message?.content ?? '';
        parsed = parseJsonOrThrow(content);
      } else {
        const url = baseUrl + (this.cfg.chatPath ?? '/api/chat');
        const resp = await this.http.post(url, {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPayload) },
          ],
          format: 'json',
          stream: false,
        }, { timeout: timeoutMs });
        externalRunId = typeof resp.data?.created_at === 'string'
          ? `ollama-${resp.data.created_at}`
          : undefined;
        modelUsed = typeof resp.data?.model === 'string' ? resp.data.model : model;
        const content = resp.data?.message?.content ?? '';
        parsed = parseJsonOrThrow(content);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: 'ollama', adapter: 'ollama',
        latencyMs: this.now() - t0,
        status: 'failed',
        error: `ollama call failed: ${message}`,
        metadata: { model, apiMode },
      };
    }

    // Apply extract + normalize so the post body always carries the
    // numeric vector the source mapping expects, even when the model
    // emits string-typed numbers or omits a field.
    let values: number[];
    try {
      values = applyNormalize(applyExtract(parsed, extract), normalize);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: 'ollama', adapter: 'ollama',
        latencyMs: this.now() - t0,
        status: 'failed',
        error: `extract/normalize failed: ${message}`,
        externalRunId,
        metadata: { model: modelUsed, apiMode, parsed },
      };
    }

    // POST to /api/integrations/completions.  Wire-compatible with the
    // Phase-1 ingest contract and the C++ implementation.
    const completionBody = {
      provider: 'ollama',
      agent: envelope.dispatch.agent || this.cfg.id || 'ollama',
      correlationId: envelope.correlationId,
      envelopeId: envelope.envelopeId,
      sourceMappingId: mappingId || undefined,
      values,
      metadata: { model: modelUsed, apiMode, externalRunId, parsed },
    };
    try {
      const resp = await this.http.post(this.deps.completionUrl, completionBody, { timeout: timeoutMs });
      if (resp.status < 200 || resp.status >= 300) {
        return {
          provider: 'ollama', adapter: 'ollama',
          latencyMs: this.now() - t0,
          status: 'failed',
          error: `completion ingest non-2xx: ${resp.status}`,
          externalRunId,
          metadata: { model: modelUsed, apiMode },
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: 'ollama', adapter: 'ollama',
        latencyMs: this.now() - t0,
        status: 'failed',
        error: `completion ingest failed: ${message}`,
        externalRunId,
        metadata: { model: modelUsed, apiMode },
      };
    }

    return {
      provider: 'ollama', adapter: 'ollama',
      latencyMs: this.now() - t0,
      status: 'sent',
      externalRunId,
      metadata: { model: modelUsed, apiMode, cells: values.length },
    };
  }

  async shutdown(): Promise<void> { /* no-op */ }
}

// ── helpers ────────────────────────────────────────────────────────────

function parseJsonOrThrow(text: unknown): unknown {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('empty model response');
  }
  // Be tolerant of accidental markdown fences (some Ollama models still emit them).
  const stripped = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return JSON.parse(stripped);
}

function resolveCompletionSourceMappingId(cfg: OllamaIntegrationCfg): string {
  const raw = cfg as Record<string, unknown>;
  return stringField(raw['completionSourceMappingId'])
    ?? stringField(raw['sourceMappingId'])
    ?? '';
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Enumerate the fields the model should populate, derived from the extract spec. */
function listExpectedFields(spec: ExtractSpec): string[] {
  if (spec.type === 'passthrough') return [];
  if ('pointers' in spec) return spec.pointers.slice();
  return [spec.pointer];
}

/**
 * Compact schema hint that we drop into the user message so the model
 * knows what to produce.  Avoids re-stating the full JSON Schema for
 * smaller models that perform worse on long contexts.
 */
function buildSchemaHint(spec: ExtractSpec, fields: string[]): unknown {
  if (spec.type === 'passthrough') {
    return { type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } }, required: ['values'] };
  }
  return {
    type: 'object',
    extractMode: 'json-pointer',
    expectedPointers: fields,
    note: 'Return one numeric / boolean leaf per pointer above.',
  };
}
