/**
 * OllamaAdapter — unit tests against a stub axios.
 *
 * Covers Phase 4a acceptance: builds the right request per apiMode,
 * parses JSON responses (including markdown-fenced ones), runs the
 * extract+normalize pipeline, posts to /api/integrations/completions,
 * and returns a typed DispatchReceipt.
 */

import { describe, expect, it } from '@jest/globals';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';

import { loadRegistry } from '../integrations/Registry.js';
import { OllamaAdapter } from '../integrations/adapters/OllamaAdapter.js';
import type { DispatchRecord } from '../dispatch/types.js';
import type { TriggerEnvelope } from '../triggers/types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function registryWith(mapping: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-test-'));
  const path = join(dir, 'r.json');
  writeFileSync(path, JSON.stringify({ integrations: [], sourceMappings: [mapping] }), 'utf8');
  const state = loadRegistry(path);
  rmSync(dir, { recursive: true, force: true });
  return state;
}

function stubHttp(responder: (url: string, body: unknown) => { status: number; data: unknown }): {
  http: AxiosInstance;
  calls: Array<{ url: string; body: unknown; cfg?: AxiosRequestConfig }>;
} {
  const calls: Array<{ url: string; body: unknown; cfg?: AxiosRequestConfig }> = [];
  const post = async (url: string, body: unknown, cfg?: AxiosRequestConfig) => {
    calls.push({ url, body, cfg });
    return responder(url, body);
  };
  const http = {
    post,
    patch: post,
    get: async () => ({ status: 200, data: {} }),
  } as unknown as AxiosInstance;
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
    endpoint: { kind: 'ollama', url: '', mutation: '', schemaRef: '' },
  },
};

const dispatchRecord: DispatchRecord = {
  id: 'd-1', envelopeId: 'env-1', correlationId: 'corr-1',
  status: 'recorded', mode: 'ollama', target: 'paging-decision',
  machineId: 'm-1', sequenceId: 's-1', ragStatusCode: '', processStatus: '',
  attempts: 0, createdAt: 1, updatedAt: 1, providerReceipt: null, envelope,
};

// ── native /api/chat ────────────────────────────────────────────────────

describe('OllamaAdapter — native /api/chat', () => {
  it('builds a chat request, parses JSON, runs extract+normalize, and posts a completion', async () => {
    const registry = registryWith({
      id: 'agent-completion-risk',
      sensorIdTemplate: 'agent.{agent}.completion',
      region: { offset: 4200, length: 4 },
      extract: { type: 'json', pointers: ['/completed', '/failed', '/confidence', '/actionClass'] },
      normalize: { mode: 'passthrough', clamp: true },
      ttlMs: 300_000,
    });
    const { http, calls } = stubHttp((url) => {
      if (url.endsWith('/api/chat')) {
        return {
          status: 200,
          data: {
            model: 'gpt-oss:20b',
            created_at: '2026-01-01T00:00:00Z',
            message: { content: JSON.stringify({ completed: 1, failed: 0, confidence: 0.82, actionClass: 0 }) },
          },
        };
      }
      if (url.endsWith('/api/integrations/completions')) {
        return { status: 200, data: { success: true } };
      }
      return { status: 500, data: { error: 'unexpected url ' + url } };
    });
    const adapter = new OllamaAdapter({ http });
    await adapter.init({
      id: 'ollama-local', kind: 'ollama', enabled: true,
      baseUrl: 'http://localhost:11434', model: 'gpt-oss:20b',
      apiMode: 'native', sourceMappingId: 'agent-completion-risk',
    } as any, { registry, completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, dispatchRecord);

    expect(receipt.status).toBe('sent');
    expect(receipt.provider).toBe('ollama');
    expect(receipt.adapter).toBe('ollama');
    expect(receipt.metadata?.['model']).toBe('gpt-oss:20b');
    expect(receipt.metadata?.['cells']).toBe(4);
    expect(receipt.externalRunId).toBe('ollama-2026-01-01T00:00:00Z');

    // Inspect call sequence: one chat POST, one completion POST.
    expect(calls).toHaveLength(2);
    const chatCall = calls[0]!;
    expect(chatCall.url).toBe('http://localhost:11434/api/chat');
    expect((chatCall.body as any).model).toBe('gpt-oss:20b');
    expect((chatCall.body as any).format).toBe('json');
    expect((chatCall.body as any).messages).toHaveLength(2);

    const completionCall = calls[1]!;
    expect(completionCall.url).toBe('http://pe.test/api/integrations/completions');
    const body = completionCall.body as any;
    expect(body.provider).toBe('ollama');
    expect(body.agent).toBe('paging-decision');
    expect(body.correlationId).toBe('corr-1');
    expect(body.envelopeId).toBe('env-1');
    expect(body.sourceMappingId).toBe('agent-completion-risk');
    expect(body.values).toEqual([1, 0, 0.82, 0]);
  });

  it('uses completionSourceMappingId from the shared registry config key', async () => {
    const registry = registryWith({
      id: 'agent-completion-risk',
      sensorIdTemplate: 'agent.{agent}.completion',
      region: { offset: 4200, length: 4 },
      extract: { type: 'json', pointers: ['/completed', '/failed', '/confidence', '/actionClass'] },
      normalize: { mode: 'passthrough', clamp: true },
      ttlMs: 300_000,
    });
    const { http, calls } = stubHttp((url) => {
      if (url.endsWith('/api/chat')) {
        return {
          status: 200,
          data: {
            model: 'gpt-oss:20b',
            message: { content: JSON.stringify({ completed: 1, failed: 0, confidence: 0.82, actionClass: 0 }) },
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
    const adapter = new OllamaAdapter({ http });
    await adapter.init({
      id: 'ollama-local', kind: 'ollama', enabled: true,
      apiMode: 'native', completionSourceMappingId: 'agent-completion-risk',
    } as any, { registry, completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, dispatchRecord);

    expect(receipt.status).toBe('sent');
    expect((calls[1]!.body as any).sourceMappingId).toBe('agent-completion-risk');
  });
});

// ── openai-compat /v1/chat/completions ──────────────────────────────────

describe('OllamaAdapter — openai-compat /v1/chat/completions', () => {
  it('uses the openai-compatible path and parses the alternate response shape', async () => {
    const registry = registryWith({
      id: 'simple-passthrough',
      sensorId: 'agent.openai-compat',
      region: { offset: 0, length: 3 },
      extract: { type: 'passthrough' },
    });
    const { http, calls } = stubHttp((url) => {
      if (url.endsWith('/v1/chat/completions')) {
        return {
          status: 200,
          data: {
            id: 'chatcmpl-abc',
            model: 'gpt-oss:20b',
            choices: [{ message: { content: JSON.stringify({ values: [0.1, 0.5, 0.9] }) } }],
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
    const adapter = new OllamaAdapter({ http });
    await adapter.init({
      id: 'ollama-local', kind: 'ollama', enabled: true,
      baseUrl: 'http://localhost:11434/', model: 'gpt-oss:20b',
      apiMode: 'openai-compat', sourceMappingId: 'simple-passthrough',
    } as any, { registry, completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, dispatchRecord);
    expect(receipt.status).toBe('sent');
    expect(receipt.externalRunId).toBe('chatcmpl-abc');
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect((calls[0]!.body as any).response_format).toEqual({ type: 'json_object' });
    // passthrough on `{values: [...]}` produces a 1-cell array of the array's coerceNumber — by design,
    // the registry's extract spec tells the adapter exactly how to interpret the payload.
  });
});

// ── failure paths ────────────────────────────────────────────────────────

describe('OllamaAdapter — failure paths', () => {
  it('returns a failed receipt when the model emits non-JSON', async () => {
    const registry = registryWith({
      id: 'm', sensorId: 's',
      extract: { type: 'json', pointers: ['/x'] },
    });
    const { http } = stubHttp((url) => {
      if (url.endsWith('/api/chat')) {
        return { status: 200, data: { message: { content: 'this is prose, not json' } } };
      }
      return { status: 200, data: {} };
    });
    const adapter = new OllamaAdapter({ http });
    await adapter.init({
      id: 'o', kind: 'ollama', enabled: true, apiMode: 'native', sourceMappingId: 'm',
    } as any, { registry, completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, dispatchRecord);
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/ollama call failed/i);
  });

  it('tolerates markdown fences around the JSON payload', async () => {
    const registry = registryWith({
      id: 'm', sensorId: 's',
      extract: { type: 'json', pointers: ['/x'] },
    });
    const fenced = '```json\n{"x": 0.42}\n```';
    const { http } = stubHttp((url) => {
      if (url.endsWith('/api/chat')) return { status: 200, data: { message: { content: fenced } } };
      return { status: 200, data: { success: true } };
    });
    const adapter = new OllamaAdapter({ http });
    await adapter.init({
      id: 'o', kind: 'ollama', enabled: true, apiMode: 'native', sourceMappingId: 'm',
    } as any, { registry, completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, dispatchRecord);
    expect(receipt.status).toBe('sent');
  });

  it('marks the receipt as failed when /api/integrations/completions returns 5xx', async () => {
    const registry = registryWith({
      id: 'm', sensorId: 's',
      extract: { type: 'json', pointers: ['/x'] },
    });
    const { http } = stubHttp((url) => {
      if (url.endsWith('/api/chat')) return { status: 200, data: { message: { content: '{"x": 1}' } } };
      return { status: 503, data: { error: 'PE down' } };
    });
    const adapter = new OllamaAdapter({ http });
    await adapter.init({
      id: 'o', kind: 'ollama', enabled: true, apiMode: 'native', sourceMappingId: 'm',
    } as any, { registry, completionUrl: 'http://pe.test/api/integrations/completions' });

    const receipt = await adapter.dispatch(envelope, dispatchRecord);
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/completion ingest non-2xx: 503/);
  });
});
