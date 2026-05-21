/**
 * AdapterPipeline — routing + ledger PATCH contract.
 */

import { describe, expect, it } from '@jest/globals';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';

import { AdapterPipeline } from '../integrations/AdapterPipeline.js';
import type { DispatchRecord } from '../dispatch/types.js';
import type { TriggerEnvelope } from '../triggers/types.js';
import type { DispatchReceipt, ProviderAdapter } from '../integrations/adapters/types.js';

function stubAdapter(kind: string, behaviour: 'sent' | 'failed' | 'throw'): ProviderAdapter & {
  calls: TriggerEnvelope[];
} {
  const calls: TriggerEnvelope[] = [];
  return {
    kind,
    calls,
    async init() {},
    async shutdown() {},
    async dispatch(env): Promise<DispatchReceipt> {
      calls.push(env);
      if (behaviour === 'throw') throw new Error('boom');
      if (behaviour === 'failed') return {
        provider: kind, adapter: kind, latencyMs: 1, status: 'failed', error: 'no model',
      };
      return {
        provider: kind, adapter: kind, latencyMs: 7,
        status: 'sent', externalRunId: 'ext-1',
        metadata: { model: 'gpt-oss:20b' },
      };
    },
  } as ProviderAdapter & { calls: TriggerEnvelope[] };
}

function envelope(kind: string): TriggerEnvelope {
  return {
    schemaVersion: '1.0.0', envelopeType: 'ces.terminal.event',
    envelopeId: 'env-1', correlationId: 'corr-1', emittedAtMs: 1,
    source: { engine: 'PE', observedEngine: 'RE', endpoint: 'http://re' },
    ces: {
      machineId: 'm', machineName: 'm', machineCode: '', sequenceId: '', sequenceName: '',
      outputIndex: 0, stepNumber: 0,
      perceptualMapping: { output: null }, provenance: [], deprecation: null,
    },
    outputVector: { values: [], encoding: 'vector', semantics: [], assertedLabel: 'none' },
    projection: null, governance: null,
    dispatch: { agent: 'a', action: '', agentActionsCatalog: [], trigger: 't',
      endpoint: { kind, url: '', mutation: '', schemaRef: '' } },
  };
}

function record(): DispatchRecord {
  return {
    id: 'd-1', envelopeId: 'env-1', correlationId: 'corr-1',
    status: 'recorded', mode: 'ollama', target: 'a',
    machineId: 'm', sequenceId: '', ragStatusCode: '', processStatus: '',
    attempts: 0, createdAt: 1, updatedAt: 1, providerReceipt: null,
    envelope: envelope('ollama'),
  };
}

function stubHttp() {
  const calls: Array<{ method: string; url: string; body: unknown; cfg?: AxiosRequestConfig }> = [];
  const patch = async (url: string, body: unknown, cfg?: AxiosRequestConfig) => {
    calls.push({ method: 'patch', url, body, cfg });
    return { status: 200, data: { success: true } };
  };
  const http = { patch } as unknown as AxiosInstance;
  return { http, calls };
}

describe('AdapterPipeline', () => {
  it('routes envelopes by dispatch.endpoint.kind', async () => {
    const a = stubAdapter('ollama', 'sent');
    const b = stubAdapter('openai', 'sent');
    const p = new AdapterPipeline();
    p.register(a); p.register(b);

    p.onRecord(envelope('ollama'), record());
    await new Promise((r) => setImmediate(r));

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it('skips dispatch when the endpoint kind is dry-run', () => {
    const a = stubAdapter('ollama', 'sent');
    const p = new AdapterPipeline();
    p.register(a);
    const env = envelope('dry-run');
    p.onRecord(env, record());
    expect(a.calls).toHaveLength(0);
  });

  it('skips dispatch when no adapter matches the kind', () => {
    const a = stubAdapter('ollama', 'sent');
    const p = new AdapterPipeline();
    p.register(a);
    const env = envelope('langgraph');
    p.onRecord(env, record());
    expect(a.calls).toHaveLength(0);
  });

  it('routes openclaw-acp envelopes to the acp adapter alias', async () => {
    const a = stubAdapter('acp', 'sent');
    const p = new AdapterPipeline();
    p.register(a);

    p.onRecord(envelope('openclaw-acp'), record());
    await new Promise((r) => setImmediate(r));

    expect(a.calls).toHaveLength(1);
  });

  it('PATCHes the ledger record with the adapter receipt when ledger base url is provided', async () => {
    const a = stubAdapter('ollama', 'sent');
    const { http, calls } = stubHttp();
    const p = new AdapterPipeline({ http, ledgerPatchBaseUrl: 'http://pe.test' });
    p.register(a);

    p.onRecord(envelope('ollama'), record());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://pe.test/api/dispatch/records/d-1');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['status']).toBe('sent');
    expect(body['incrementAttempts']).toBe(true);
    expect(body['provider']).toBe('ollama');
    expect(body['adapter']).toBe('ollama');
    expect(body['externalRunId']).toBe('ext-1');
    const receipt = body['providerReceipt'] as Record<string, unknown>;
    expect(receipt['latencyMs']).toBe(7);
    expect(receipt['model']).toBe('gpt-oss:20b');
  });

  it('PATCHes a failed receipt with error text', async () => {
    const a = stubAdapter('ollama', 'failed');
    const { http, calls } = stubHttp();
    const p = new AdapterPipeline({ http, ledgerPatchBaseUrl: 'http://pe.test' });
    p.register(a);

    p.onRecord(envelope('ollama'), record());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['status']).toBe('failed');
    expect(body['error']).toBe('no model');
  });

  it('surfaces thrown adapter errors via onError but still PATCHes a failed receipt', async () => {
    const a = stubAdapter('ollama', 'throw');
    const { http, calls } = stubHttp();
    const seen: Array<unknown> = [];
    const p = new AdapterPipeline({
      http,
      ledgerPatchBaseUrl: 'http://pe.test',
      onError: (err) => { seen.push(err); },
    });
    p.register(a);

    p.onRecord(envelope('ollama'), record());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['status']).toBe('failed');
  });
});
