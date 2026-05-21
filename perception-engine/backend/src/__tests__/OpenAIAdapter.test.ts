/**
 * OpenAIAdapter — unit tests covering Responses API + chat-completions
 * + https-callback (background) modes against a stub axios.
 *
 * Each test maps to one acceptance criterion from
 * docs/INTEGRATION_ROADMAP.md §Phase 4c and the architecture-doc clause
 * that OpenAI run ids stay ledger-metadata-only.
 */

import { describe, expect, it } from '@jest/globals';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';

import { loadRegistry } from '../integrations/Registry.js';
import { OpenAIAdapter } from '../integrations/adapters/OpenAIAdapter.js';
import type { DispatchRecord } from '../dispatch/types.js';
import type { TriggerEnvelope } from '../triggers/types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function registryWith(mapping: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'openai-test-'));
  const path = join(dir, 'r.json');
  writeFileSync(path, JSON.stringify({ integrations: [], sourceMappings: [mapping] }), 'utf8');
  const state = loadRegistry(path);
  rmSync(dir, { recursive: true, force: true });
  return state;
}

function stubHttp(responder: (url: string, body: unknown, cfg?: AxiosRequestConfig) => { status: number; data: unknown }): {
  http: AxiosInstance;
  calls: Array<{ url: string; body: unknown; cfg?: AxiosRequestConfig }>;
} {
  const calls: Array<{ url: string; body: unknown; cfg?: AxiosRequestConfig }> = [];
  const post = async (url: string, body: unknown, cfg?: AxiosRequestConfig) => {
    calls.push({ url, body, cfg });
    return responder(url, body, cfg);
  };
  const http = { post, patch: post, get: async () => ({ status: 200, data: {} }) } as unknown as AxiosInstance;
  return { http, calls };
}

const envelope: TriggerEnvelope = {
  schemaVersion: '1.0.0', envelopeType: 'ces.terminal.event',
  envelopeId: 'env-1', correlationId: 'corr-1', emittedAtMs: 1,
  source: { engine: 'PE', observedEngine: 'RE', endpoint: 'http://re' },
  ces: {
    machineId: 'm-1', machineName: 'M1', machineCode: 'M001',
    sequenceId: 's-1', sequenceName: 's-1', outputIndex: 0, stepNumber: 0,
    perceptualMapping: { output: { offset: 0, length: 4 } },
    provenance: [], deprecation: null,
  },
  outputVector: { values: [1, 0, 0, 0], encoding: 'vector', semantics: [], assertedLabel: 'cell_0' },
  projection: null, governance: null,
  dispatch: {
    agent: 'paging-decision', action: '', agentActionsCatalog: [], trigger: 't',
    endpoint: { kind: 'openai', url: '', mutation: '', schemaRef: '' },
  },
};

const record: DispatchRecord = {
  id: 'd-1', envelopeId: 'env-1', correlationId: 'corr-1',
  status: 'recorded', mode: 'openai', target: 'paging-decision',
  machineId: 'm-1', sequenceId: 's-1', ragStatusCode: '', processStatus: '',
  attempts: 0, createdAt: 1, updatedAt: 1, providerReceipt: null, envelope,
};

const mapping = {
  id: 'agent-completion-risk',
  sensorIdTemplate: 'agent.{agent}.completion',
  region: { offset: 4200, length: 4 },
  extract: { type: 'json', pointers: ['/completed', '/failed', '/confidence', '/actionClass'] },
  normalize: { mode: 'passthrough', clamp: true },
  ttlMs: 300_000,
};

// ── auth ────────────────────────────────────────────────────────────────

describe('OpenAIAdapter — auth', () => {
  it('returns a failed receipt when no API key is present', async () => {
    const { http } = stubHttp(() => ({ status: 200, data: {} }));
    const adapter = new OpenAIAdapter({ http, envApiKey: undefined });
    await adapter.init({
      id: 'o', kind: 'openai', enabled: true, sourceMappingId: 'm',
    } as any, { registry: registryWith({ id: 'm', sensorId: 's' }), completionUrl: 'http://pe/' });
    const r = await adapter.dispatch(envelope, record);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/no API key/);
  });
});

// ── sync Responses API ──────────────────────────────────────────────────

describe('OpenAIAdapter — sync /v1/responses', () => {
  it('posts to /responses with Authorization, parses output_text, runs extract+normalize, posts a completion', async () => {
    const { http, calls } = stubHttp((url) => {
      if (url.endsWith('/v1/responses')) {
        return {
          status: 200,
          data: {
            id: 'resp_abc123', model: 'gpt-4.1',
            output_text: JSON.stringify({ completed: 1, failed: 0, confidence: 0.82, actionClass: 0 }),
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
    const adapter = new OpenAIAdapter({ http, envApiKey: 'sk-test' });
    await adapter.init({
      id: 'openai-agents', kind: 'openai', enabled: true,
      model: 'gpt-4.1', apiMode: 'responses', completionMode: 'sync',
      sourceMappingId: 'agent-completion-risk',
    } as any, { registry: registryWith(mapping), completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, record);

    expect(receipt.status).toBe('sent');
    expect(receipt.provider).toBe('openai');
    expect(receipt.adapter).toBe('openai');
    expect(receipt.externalRunId).toBe('resp_abc123');
    expect(receipt.metadata?.['model']).toBe('gpt-4.1');
    expect(receipt.metadata?.['cells']).toBe(4);

    // First call → /v1/responses with auth header + metadata fields.
    const r1 = calls[0]!;
    expect(r1.url).toBe('https://api.openai.com/v1/responses');
    expect((r1.cfg as any)?.headers?.Authorization).toBe('Bearer sk-test');
    const reqBody = r1.body as any;
    expect(reqBody.metadata.envelopeId).toBe('env-1');
    expect(reqBody.metadata.correlationId).toBe('corr-1');
    expect(reqBody.metadata.dispatchId).toBe('d-1');

    // Second call → completion ingest.
    const r2 = calls[1]!;
    expect(r2.url).toBe('http://pe.test/api/integrations/completions');
    const completion = r2.body as any;
    expect(completion.values).toEqual([1, 0, 0.82, 0]);
    expect(completion.sourceMappingId).toBe('agent-completion-risk');
  });

  it('extracts text via output[*].content[*].text when output_text is absent', async () => {
    const { http } = stubHttp((url) => {
      if (url.endsWith('/v1/responses')) {
        return {
          status: 200,
          data: {
            id: 'resp_x', model: 'gpt-4.1',
            output: [{ content: [{ type: 'output_text', text: JSON.stringify({ completed: 1, failed: 0, confidence: 0.5, actionClass: 0 }) }] }],
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
    const adapter = new OpenAIAdapter({ http, envApiKey: 'sk-test' });
    await adapter.init({
      id: 'o', kind: 'openai', enabled: true, sourceMappingId: 'agent-completion-risk',
    } as any, { registry: registryWith(mapping), completionUrl: 'http://pe.test/api/integrations/completions' });

    const r = await adapter.dispatch(envelope, record);
    expect(r.status).toBe('sent');
  });
});

// ── chat-completions fallback ───────────────────────────────────────────

describe('OpenAIAdapter — apiMode: chat-completions', () => {
  it('uses /v1/chat/completions and parses choices[0].message.content', async () => {
    const { http, calls } = stubHttp((url) => {
      if (url.endsWith('/v1/chat/completions')) {
        return {
          status: 200,
          data: {
            id: 'chatcmpl_y', model: 'gpt-4.1',
            choices: [{ message: { content: JSON.stringify({ completed: 0, failed: 1, confidence: 0.1, actionClass: 1 }) } }],
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
    const adapter = new OpenAIAdapter({ http, envApiKey: 'sk-test' });
    await adapter.init({
      id: 'o', kind: 'openai', enabled: true, apiMode: 'chat-completions',
      sourceMappingId: 'agent-completion-risk',
    } as any, { registry: registryWith(mapping), completionUrl: 'http://pe.test/api/integrations/completions' });

    const r = await adapter.dispatch(envelope, record);
    expect(r.status).toBe('sent');
    expect(r.externalRunId).toBe('chatcmpl_y');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

// ── https-callback mode ────────────────────────────────────────────────

describe('OpenAIAdapter — completionMode: https-callback', () => {
  it('posts a background run with metadata + webhook_url and returns "queued" without committing', async () => {
    const { http, calls } = stubHttp((url) => {
      if (url.endsWith('/v1/responses')) {
        return { status: 200, data: { id: 'resp_queued', model: 'gpt-4.1' } };
      }
      return { status: 500, data: { error: 'should not call completion endpoint in callback mode' } };
    });
    const adapter = new OpenAIAdapter({ http, envApiKey: 'sk-test' });
    await adapter.init({
      id: 'openai-agents', kind: 'openai', enabled: true,
      apiMode: 'responses', completionMode: 'https-callback',
      callbackUrl: 'http://pe.test/api/integrations/openai/webhook',
      sourceMappingId: 'agent-completion-risk',
    } as any, { registry: registryWith(mapping), completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, record);

    expect(receipt.status).toBe('sent');
    expect(receipt.externalRunId).toBe('resp_queued');
    expect(receipt.metadata?.['mode']).toBe('queued');
    // Exactly one call to OpenAI — no completion POST yet (webhook will).
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as any;
    expect(body.background).toBe(true);
    expect(body.webhook_url).toBe('http://pe.test/api/integrations/openai/webhook');
  });
});

// ── failure surface ────────────────────────────────────────────────────

describe('OpenAIAdapter — failures', () => {
  it('marks the receipt failed when the model emits non-JSON', async () => {
    const { http } = stubHttp((url) => {
      if (url.endsWith('/v1/responses')) {
        return { status: 200, data: { id: 'r', model: 'gpt-4.1', output_text: 'definitely not json' } };
      }
      return { status: 200, data: {} };
    });
    const adapter = new OpenAIAdapter({ http, envApiKey: 'sk-test' });
    await adapter.init({
      id: 'o', kind: 'openai', enabled: true, sourceMappingId: 'agent-completion-risk',
    } as any, { registry: registryWith(mapping), completionUrl: 'http://pe.test/api/integrations/completions' });

    const r = await adapter.dispatch(envelope, record);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/openai call failed/);
    expect(r.externalRunId).toBe('r');
  });

  it('marks the receipt failed when completion ingest returns non-2xx', async () => {
    const { http } = stubHttp((url) => {
      if (url.endsWith('/v1/responses')) {
        return { status: 200, data: { id: 'r', model: 'gpt-4.1', output_text: '{"completed":1,"failed":0,"confidence":0.1,"actionClass":0}' } };
      }
      return { status: 503, data: { error: 'PE down' } };
    });
    const adapter = new OpenAIAdapter({ http, envApiKey: 'sk-test' });
    await adapter.init({
      id: 'o', kind: 'openai', enabled: true, sourceMappingId: 'agent-completion-risk',
    } as any, { registry: registryWith(mapping), completionUrl: 'http://pe.test/api/integrations/completions' });

    const r = await adapter.dispatch(envelope, record);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/completion ingest non-2xx: 503/);
  });
});
