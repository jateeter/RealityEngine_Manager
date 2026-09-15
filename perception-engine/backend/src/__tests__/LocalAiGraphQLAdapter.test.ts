/**
 * LocalAiGraphQLAdapter — the properties that decide whether a dispatch is
 * honest, rather than whether the happy path runs.
 *
 * Three of these five exist because the same failure keeps recurring in this
 * system under different names: something that cannot succeed reports success,
 * and from outside that is indistinguishable from working.
 */

import { jest } from '@jest/globals';

import { LocalAiGraphQLAdapter } from '../integrations/adapters/LocalAiGraphQLAdapter.js';
import type { TriggerEnvelope } from '../triggers/types.js';
import type { DispatchRecord } from '../dispatch/types.js';

const RECORD = { id: 'disp-1' } as unknown as DispatchRecord;

function envelope(governance: Record<string, unknown> | null): TriggerEnvelope {
  return {
    schemaVersion: '1.0.0',
    envelopeType: 'ces.terminal.event',
    envelopeId: 'env-1',
    correlationId: 'corr-1',
    emittedAtMs: 1,
    source: { engine: 'PE', observedEngine: 'RE', endpoint: 'http://re' },
    ces: {
      machineId: 'm-1',
      machineName: 'Fall Detection',
      machineCode: 'FD',
      sequenceId: 'fall-confirmed',
      sequenceName: 'Fall confirmed',
      outputIndex: 0,
      stepNumber: 6,
      perceptualMapping: { output: null },
      provenance: [],
      deprecation: null,
    },
    outputVector: {} as TriggerEnvelope['outputVector'],
    projection: null,
    governance: governance as TriggerEnvelope['governance'],
    dispatch: {} as TriggerEnvelope['dispatch'],
  } as TriggerEnvelope;
}

async function adapter(post: unknown) {
  const http = { post } as never;
  const a = new LocalAiGraphQLAdapter({ http, now: () => 0 });
  await a.init({ endpoint: 'http://localai:4000' } as never, {} as never);
  return a;
}

describe('LocalAiGraphQLAdapter', () => {
  it('sends the mutation with governance read from the envelope', async () => {
    const post = jest.fn(async () => ({
      data: { data: { updateProcessState: { processState: { id: 'ps-1', status: 'error' } } } },
    }));
    const a = await adapter(post);
    const receipt = await a.dispatch(envelope({ ragStatusCode: 'RED', processStatus: 'error' }), RECORD);

    expect(receipt.status).toBe('sent');
    expect(receipt.externalRunId).toBe('ps-1');
    const [url, body] = post.mock.calls[0] as unknown as
      [string, { variables: { input: Record<string, unknown> } }];
    expect(url).toBe('http://localai:4000/graphql');
    expect(body.variables.input).toMatchObject({
      id: 'disp-1',
      ragStatusCode: 'RED',
      status: 'error',
      sourceMachine: 'Fall Detection',
      sourceSequence: 'fall-confirmed',
    });
  });

  it('refuses an envelope with no ragStatusCode rather than defaulting to GREEN', async () => {
    // The mutation's enum has no "unknown". Reporting GREEN for a determination
    // that never claimed one is how an unstated status becomes indistinguishable
    // from a benign one — the failure that left the corpus escalation guardrail
    // inert for 78 of 80 escalations.
    const post = jest.fn();
    const a = await adapter(post);
    const receipt = await a.dispatch(envelope({ processStatus: 'error' }), RECORD);

    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/ragStatusCode/);
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a 200 carrying GraphQL errors as a failure', async () => {
    // GraphQL answers 200 with an `errors` array. Reading only the HTTP status
    // would record every rejected mutation as delivered.
    const post = jest.fn(async () => ({ data: { errors: [{ message: 'unknown process id' }] } }));
    const a = await adapter(post);
    const receipt = await a.dispatch(envelope({ ragStatusCode: 'AMBER' }), RECORD);

    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/unknown process id/);
  });

  it('rejects a RAG code outside the schema instead of forwarding it', async () => {
    const post = jest.fn();
    const a = await adapter(post);
    const receipt = await a.dispatch(envelope({ ragStatusCode: 'PURPLE' }), RECORD);

    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/PURPLE/);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses to start with no endpoint rather than accepting undeliverable envelopes', async () => {
    const saved = process.env.TRIGGER_GRAPHQL_URL;
    delete process.env.TRIGGER_GRAPHQL_URL;
    const a = new LocalAiGraphQLAdapter();
    await expect(a.init({} as never, {} as never)).rejects.toThrow(/endpoint/i);
    if (saved !== undefined) process.env.TRIGGER_GRAPHQL_URL = saved;
  });
});
