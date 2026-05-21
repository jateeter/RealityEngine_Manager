/**
 * AcpAdapter — no-wait OpenClaw xACP handoff contract.
 */

import { describe, expect, it } from '@jest/globals';

import { AcpAdapter, acpConfigFromRegistry } from '../integrations/adapters/AcpAdapter.js';
import type { DispatchRecord } from '../dispatch/types.js';
import type { TriggerEnvelope } from '../triggers/types.js';
import type { RegistryState } from '../integrations/types.js';

const emptyRegistry: RegistryState = {
  loaded: false,
  path: null,
  error: null,
  config: {},
  sourceMappingIndex: new Map(),
};

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
    endpoint: { kind: 'acp', url: '', mutation: '', schemaRef: '' },
  },
};

const dispatchRecord: DispatchRecord = {
  id: 'd-1', envelopeId: 'env-1', correlationId: 'corr-1',
  status: 'recorded', mode: 'acp', target: 'paging-decision',
  machineId: 'm-1', sequenceId: 's-1', ragStatusCode: '', processStatus: '',
  attempts: 0, createdAt: 1, updatedAt: 1, providerReceipt: null, envelope,
};

describe('AcpAdapter', () => {
  it('records an OpenClaw xACP handoff receipt without running an ACP turn', async () => {
    const adapter = new AcpAdapter();
    await adapter.init({
      id: 'openclaw-xacp',
      kind: 'acp',
      enabled: true,
      platform: 'OpenClaw',
      surface: 'xACP',
      command: 'openclaw acp',
      gatewayUrl: 'ws://127.0.0.1:18789',
      sessionKey: 'agent:main:main',
      completionSourceMappingId: 'acp-openclaw-completion',
    }, {
      registry: emptyRegistry,
      completionUrl: 'http://pe.test/api/integrations/completions',
      now: () => 42,
    });

    const receipt = adapter.accept(envelope, dispatchRecord, {
      externalRunId: 'acp-handoff-test',
      sourceMappingId: 'acp-openclaw-completion',
      metadata: { caller: 'unit-test' },
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.provider).toBe('acp');
    expect(receipt.adapter).toBe('openclaw-xacp');
    expect(receipt.externalRunId).toBe('acp-handoff-test');
    expect(receipt.metadata).toMatchObject({
      protocol: 'ACP',
      platform: 'OpenClaw',
      surface: 'xACP',
      adapter: 'openclaw-xacp',
      command: 'openclaw acp',
      gatewayUrl: 'ws://127.0.0.1:18789',
      sessionKey: 'agent:main:main',
      targetAgent: 'paging-decision',
      completionEndpoint: '/api/integrations/completions',
      completionSourceMappingId: 'acp-openclaw-completion',
      noWaitDispatch: true,
      dispatchId: 'd-1',
      envelopeId: 'env-1',
      correlationId: 'corr-1',
      metadata: { caller: 'unit-test' },
    });
  });

  it('reports status with the ACP dispatch and PE completion endpoints', async () => {
    const adapter = new AcpAdapter();
    await adapter.init({
      id: 'openclaw-xacp',
      kind: 'acp',
      enabled: true,
      completionSourceMappingId: 'acp-openclaw-completion',
    }, { registry: emptyRegistry, completionUrl: 'http://pe.test/api/integrations/completions' });

    expect(adapter.status()).toMatchObject({
      enabled: true,
      adapter: 'openclaw-xacp',
      dispatchEndpoint: '/api/integrations/acp/dispatch',
      completionEndpoint: '/api/integrations/completions',
      dispatchMode: 'accepted-no-wait',
      completionMode: 'pe-source-mapping',
      completionSourceMappingId: 'acp-openclaw-completion',
    });
  });
});

describe('acpConfigFromRegistry', () => {
  it('builds default OpenClaw xACP config when the registry has no ACP entry', () => {
    const cfg = acpConfigFromRegistry([]);
    expect(cfg).toMatchObject({
      id: 'openclaw-xacp',
      kind: 'acp',
      enabled: false,
      platform: 'OpenClaw',
      surface: 'xACP',
      command: 'openclaw acp',
      gatewayUrl: 'ws://127.0.0.1:18789',
      sessionKey: 'agent:main:main',
      targetAgent: 'openclaw',
      completionSourceMappingId: 'agent-completion-risk',
      dispatchMode: 'accepted-no-wait',
      completionMode: 'pe-source-mapping',
    });
  });
});
