/**
 * LocalAiGraphQLAdapter — the in-process dispatcher for localAIStack.
 *
 * `kind: "localai"` has been present in `config/integrations.json` with no
 * adapter behind it, so envelopes routed to it fell through the pipeline and
 * were recorded as dispatched without anything leaving the process. The
 * integration roadmap carried this as the one genuinely open gap in its table:
 * "Python reference template only; no in-process dispatcher."
 *
 * ## What it sends, and why it sends nothing back
 *
 * localAIStack exposes a single mutation at `POST /graphql`:
 *
 *     updateProcessState(input: UpdateProcessStateInput): UpdateProcessStatePayload
 *
 * taking `id`, `ragStatusCode` (GREEN | AMBER | RED) and the optional `name`,
 * `status`, `sourceMachine`, `sourceSequence`, `context`.
 *
 * This is an **outbound notification**, not a value-producing provider. Ollama
 * and OpenAI answer with content the PE extracts, normalizes and commits back
 * through `/api/integrations/completions`; localAIStack is being *told* that a
 * machine reached a determination. So this adapter deliberately posts no
 * completion. Committing a fabricated vector to close the loop would write
 * numbers no machine produced into the perceptual space.
 *
 * ## Governance is read from the envelope, never re-derived
 *
 * `ragStatusCode` and `processStatus` travel on the envelope's governance
 * block, which the engines populate from the output event's metadata
 * (RealityEngine_CI#365). They are read from there and from nowhere else:
 * a top-level `op.action` is a field no engine has ever emitted, and reading it
 * was dead from the day it was written.
 *
 * An envelope carrying no `ragStatusCode` is **not defaulted to GREEN**. The
 * mutation's enum has no "unknown", and inventing one would report a nominal
 * state for a determination that never claimed one — the same
 * unstated-reads-as-benign failure that left the corpus escalation guardrail
 * inert for 78 of 80 escalations. Such an envelope fails the dispatch and says
 * why.
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';

import type { DispatchRecord } from '../../dispatch/types.js';
import type { TriggerEnvelope } from '../../triggers/types.js';
import type { IntegrationEntry } from '../types.js';
import type { AdapterDeps, DispatchReceipt, ProviderAdapter } from './types.js';

/** The three codes localAIStack's schema accepts. Nothing else is valid. */
const RAG_CODES = new Set(['GREEN', 'AMBER', 'RED']);

const MUTATION = `mutation UpdateProcessState($input: UpdateProcessStateInput!) {
  updateProcessState(input: $input) {
    processState { id name status ragStatus { code description } }
  }
}`;

export class LocalAiGraphQLAdapter implements ProviderAdapter {
  readonly kind = 'localai';
  readonly id?: string;

  private endpoint = '';
  private http: AxiosInstance = axios;
  private now: () => number = () => Date.now();
  private timeoutMs = 10_000;

  constructor(opts?: { http?: AxiosInstance; now?: () => number }) {
    if (opts?.http) this.http = opts.http;
    if (opts?.now) this.now = opts.now;
  }

  async init(cfg: IntegrationEntry, deps: AdapterDeps): Promise<void> {
    const base =
      (cfg as unknown as { endpoint?: string }).endpoint ??
      (cfg as unknown as { baseUrl?: string }).baseUrl ??
      process.env.TRIGGER_GRAPHQL_URL ??
      '';
    if (!base) {
      throw new Error(
        'localai adapter: no GraphQL endpoint. Set the integration entry\'s ' +
          'endpoint/baseUrl or TRIGGER_GRAPHQL_URL. Refusing to start rather ' +
          'than silently accepting envelopes it cannot deliver.',
      );
    }
    this.endpoint = base.endsWith('/graphql') ? base : `${base.replace(/\/$/, '')}/graphql`;
    if (deps.now) this.now = deps.now;
  }

  async dispatch(envelope: TriggerEnvelope, record: DispatchRecord): Promise<DispatchReceipt> {
    const started = this.now();
    const fail = (error: string): DispatchReceipt => ({
      provider: 'localai',
      adapter: this.kind,
      latencyMs: this.now() - started,
      status: 'failed',
      error,
    });

    const governance = envelope.governance ?? {};
    const rag = String(governance.ragStatusCode ?? '').toUpperCase();

    if (!rag) {
      return fail(
        'envelope carries no governance.ragStatusCode. Not defaulted to GREEN: ' +
          'the schema has no "unknown" code, and reporting a nominal state for a ' +
          'determination that never claimed one is how an unstated status becomes ' +
          'indistinguishable from a benign one.',
      );
    }
    if (!RAG_CODES.has(rag)) {
      return fail(`governance.ragStatusCode is "${rag}", which is not GREEN, AMBER or RED`);
    }

    // sequenceIds is the post-fold shape; sequenceId is the pre-fold singular.
    // Reading only the singular yielded "" and produced null sequence IRIs on
    // dispatch records (RealityEngine_CI#327).
    const seq =
      (envelope.ces as unknown as { sequenceIds?: string[] }).sequenceIds?.[0] ??
      envelope.ces.sequenceId ??
      undefined;

    const input: Record<string, unknown> = {
      id: record.id,
      ragStatusCode: rag,
      name: envelope.ces.machineName,
      status: governance.processStatus ? String(governance.processStatus) : undefined,
      sourceMachine: envelope.ces.machineName,
      sourceSequence: seq,
    };
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];

    try {
      const res = await this.http.post(
        this.endpoint,
        { query: MUTATION, variables: { input } },
        { timeout: this.timeoutMs, headers: { 'Content-Type': 'application/json' } },
      );
      // GraphQL answers 200 with an `errors` array; a 200 is not success here.
      const errors = (res.data as { errors?: Array<{ message?: string }> })?.errors;
      if (Array.isArray(errors) && errors.length) {
        return fail(`graphql errors: ${errors.map((e) => e.message ?? 'unknown').join('; ')}`);
      }
      const state = (res.data as {
        data?: { updateProcessState?: { processState?: { id?: string; status?: string } } };
      })?.data?.updateProcessState?.processState;
      return {
        provider: 'localai',
        adapter: this.kind,
        latencyMs: this.now() - started,
        externalRunId: state?.id,
        status: 'sent',
        metadata: { ragStatusCode: rag, processStatus: state?.status, endpoint: this.endpoint },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  async shutdown(): Promise<void> {
    /* no persistent connection to close */
  }
}

export default LocalAiGraphQLAdapter;
