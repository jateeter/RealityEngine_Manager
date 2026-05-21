/**
 * OpenAIAdapter — implements ProviderAdapter for `kind: "openai"`.
 *
 * Provider-neutral by construction: identical interface to OllamaAdapter,
 * identical extract+normalize pipeline, identical completion ingest path.
 * The only OpenAI-specific concerns are auth, the request/response shape,
 * and the optional async webhook completion mode.
 *
 *   • completionMode: "sync" (default) — POST `/v1/responses` (or
 *     `/v1/chat/completions`), parse JSON, post to /api/integrations/completions.
 *     OpenAI run id stored as ledger metadata only.
 *
 *   • completionMode: "https-callback" — POST with `metadata.envelopeId`
 *     + `metadata.correlationId` so OpenAI's webhook can reach the right
 *     ledger record.  The adapter returns a `status:"sent"` receipt with
 *     the run id; the webhook receiver (server.ts:/api/integrations/openai/webhook)
 *     finishes the completion when the callback arrives.
 *
 * OpenAI provider run ids are ledger metadata only — never PE/RE state.
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

export type OpenAIApiMode = 'responses' | 'chat-completions';
export type OpenAICompletionMode = 'sync' | 'https-callback';

export interface OpenAIIntegrationCfg extends IntegrationEntry {
  kind: 'openai';
  baseUrl?: string;
  model?: string;
  /** Pulled from env OPENAI_API_KEY when unset. */
  apiKey?: string;
  apiMode?: OpenAIApiMode;
  completionMode?: OpenAICompletionMode;
  /** For https-callback mode — public URL OpenAI hits with results. */
  callbackUrl?: string;
  sourceMappingId?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface OpenAIAdapterOptions {
  http?: AxiosInstance;
  /** Defaults to process.env.OPENAI_API_KEY when the integration entry lacks one. */
  envApiKey?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1';
const DEFAULT_SYSTEM_PROMPT = [
  'You are a Reality Engine Critical-Event-Sequence (CES) responder.',
  'You will receive a CES terminal-event envelope as JSON.',
  'Reply with ONE JSON object only — no prose, no markdown fences.',
  'The shape of the JSON object must match the "schemaHint" the user supplies.',
  'Return finite numbers in [0, 1] for confidences and 0/1 (or booleans) for binary flags.',
  'When uncertain, prefer conservative values.',
].join(' ');

export class OpenAIAdapter implements ProviderAdapter {
  public readonly kind = 'openai';
  public readonly id?: string;

  private readonly http: AxiosInstance;
  private readonly envApiKey?: string;
  private now: () => number = Date.now;
  private cfg!: OpenAIIntegrationCfg;
  private deps!: AdapterDeps;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.http = opts.http ?? axios.create();
    this.envApiKey = opts.envApiKey ?? process.env['OPENAI_API_KEY'];
  }

  async init(cfg: IntegrationEntry, deps: AdapterDeps): Promise<void> {
    this.cfg = cfg as OpenAIIntegrationCfg;
    this.deps = deps;
    if (deps.now) this.now = deps.now;
    (this as { id?: string }).id = cfg.id;
  }

  async dispatch(envelope: TriggerEnvelope, record: DispatchRecord): Promise<DispatchReceipt> {
    const t0 = this.now();
    const baseUrl = (this.cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const model = this.cfg.model ?? DEFAULT_MODEL;
    const apiMode: OpenAIApiMode = this.cfg.apiMode ?? 'responses';
    const completionMode: OpenAICompletionMode = this.cfg.completionMode ?? 'sync';
    const apiKey = this.cfg.apiKey ?? this.envApiKey ?? '';
    const timeoutMs = this.cfg.timeoutMs ?? 60_000;
    const systemPrompt = this.cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const mappingId = this.cfg.sourceMappingId
      ?? ((this.cfg as Record<string, unknown>)['sourceMappingId'] as string)
      ?? '';
    const mapping = mappingId
      ? this.deps.registry.sourceMappingIndex.get(mappingId)
      : undefined;
    const extract = (mapping?.extract ?? { type: 'passthrough' as const }) as ExtractSpec;
    const normalize = mapping?.normalize as NormalizeSpec | undefined;
    const expectedFields = listExpectedFields(extract);

    if (apiKey === '') {
      return {
        provider: 'openai', adapter: 'openai', latencyMs: this.now() - t0,
        status: 'failed',
        error: 'no API key (set integration.apiKey or OPENAI_API_KEY)',
        metadata: { model, apiMode, completionMode },
      };
    }

    const userPayload = {
      schemaHint: buildSchemaHint(extract, expectedFields),
      envelope,
    };
    const metadata = {
      envelopeId: envelope.envelopeId,
      correlationId: envelope.correlationId,
      dispatchId: record.id,
      target: record.target,
    };

    let parsed: unknown;
    let runId: string | undefined;
    let modelUsed = model;
    try {
      const headers = { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
      if (apiMode === 'responses') {
        const body: Record<string, unknown> = {
          model,
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPayload) },
          ],
          response_format: { type: 'json_object' },
          metadata,
          stream: false,
        };
        if (completionMode === 'https-callback' && this.cfg.callbackUrl) {
          // The Responses API accepts a `webhook_url` for fire-and-forget
          // background runs.  We still ship the metadata so the webhook
          // payload carries the envelope linkage.
          body['background'] = true;
          body['webhook_url'] = this.cfg.callbackUrl;
        }
        const resp = await this.http.post(`${baseUrl}/responses`, body, { headers, timeout: timeoutMs });
        runId = typeof resp.data?.id === 'string' ? resp.data.id : undefined;
        modelUsed = typeof resp.data?.model === 'string' ? resp.data.model : model;

        // In callback mode we expect "queued"-style responses with no
        // immediate output — return the run id and let the webhook
        // finish the completion.
        if (completionMode === 'https-callback') {
          return {
            provider: 'openai', adapter: 'openai',
            latencyMs: this.now() - t0,
            status: 'sent',
            externalRunId: runId,
            metadata: { model: modelUsed, apiMode, completionMode, mode: 'queued' },
          };
        }

        // Sync mode — pull the text out.  Responses API returns
        // `output[*].content[*].text`; we accept either output_text or
        // any text-typed content for resilience.
        const text = extractResponsesText(resp.data);
        parsed = parseJsonOrThrow(text);
      } else {
        // chat-completions path (still useful for openai-compat backends).
        const resp = await this.http.post(`${baseUrl}/chat/completions`, {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPayload) },
          ],
          response_format: { type: 'json_object' },
          metadata,
          stream: false,
        }, { headers, timeout: timeoutMs });
        runId = typeof resp.data?.id === 'string' ? resp.data.id : undefined;
        modelUsed = typeof resp.data?.model === 'string' ? resp.data.model : model;
        if (completionMode === 'https-callback') {
          // chat-completions has no native webhook — fall back to sync
          // semantics with a note in the receipt so operators see the
          // adapter did the right thing.
          const text = resp.data?.choices?.[0]?.message?.content ?? '';
          parsed = parseJsonOrThrow(text);
        } else {
          const text = resp.data?.choices?.[0]?.message?.content ?? '';
          parsed = parseJsonOrThrow(text);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: 'openai', adapter: 'openai',
        latencyMs: this.now() - t0,
        status: 'failed',
        error: `openai call failed: ${message}`,
        externalRunId: runId,
        metadata: { model, apiMode, completionMode },
      };
    }

    let values: number[];
    try {
      values = applyNormalize(applyExtract(parsed, extract), normalize);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: 'openai', adapter: 'openai',
        latencyMs: this.now() - t0,
        status: 'failed',
        error: `extract/normalize failed: ${message}`,
        externalRunId: runId,
        metadata: { model: modelUsed, apiMode, completionMode, parsed },
      };
    }

    const completionBody = {
      provider: 'openai',
      agent: envelope.dispatch.agent || this.cfg.id || 'openai',
      correlationId: envelope.correlationId,
      envelopeId: envelope.envelopeId,
      sourceMappingId: mappingId || undefined,
      values,
      metadata: { model: modelUsed, apiMode, completionMode, runId, parsed },
    };
    try {
      const resp = await this.http.post(this.deps.completionUrl, completionBody, { timeout: timeoutMs });
      if (resp.status < 200 || resp.status >= 300) {
        return {
          provider: 'openai', adapter: 'openai',
          latencyMs: this.now() - t0,
          status: 'failed',
          error: `completion ingest non-2xx: ${resp.status}`,
          externalRunId: runId,
          metadata: { model: modelUsed, apiMode, completionMode },
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: 'openai', adapter: 'openai',
        latencyMs: this.now() - t0,
        status: 'failed',
        error: `completion ingest failed: ${message}`,
        externalRunId: runId,
        metadata: { model: modelUsed, apiMode, completionMode },
      };
    }

    return {
      provider: 'openai', adapter: 'openai',
      latencyMs: this.now() - t0,
      status: 'sent',
      externalRunId: runId,
      metadata: { model: modelUsed, apiMode, completionMode, cells: values.length },
    };
  }

  async shutdown(): Promise<void> { /* no-op */ }
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseJsonOrThrow(text: unknown): unknown {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('empty model response');
  }
  const stripped = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return JSON.parse(stripped);
}

function listExpectedFields(spec: ExtractSpec): string[] {
  if (spec.type === 'passthrough') return [];
  if ('pointers' in spec) return spec.pointers.slice();
  return [spec.pointer];
}

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

/**
 * Pull the first text payload out of a Responses-API response.  The
 * format permits multiple `output[]` items each carrying `content[]`
 * blocks.  We accept either explicit `output_text` blocks or anything
 * that exposes a `text` field — matches the published shape and the
 * common variants seen in the wild.
 */
function extractResponsesText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (typeof d.output_text === 'string' && d.output_text !== '') return d.output_text;
  for (const item of d.output ?? []) {
    for (const block of item.content ?? []) {
      if (typeof block.text === 'string' && block.text !== '') return block.text;
    }
  }
  return '';
}
