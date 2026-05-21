/**
 * Provider adapter — public types.
 *
 * Each adapter is an independent module conforming to this small contract.
 * The dispatcher fires the envelope into the {@link AdapterPipeline} after
 * appending it to the ledger; the pipeline picks the registered adapter
 * for the envelope's dispatch kind (or by integration id) and calls
 * `dispatch()` asynchronously.  Adapters are fire-and-forget at this
 * layer — completion lands back through
 * `POST /api/integrations/completions` (or the in-process equivalent).
 */

import type { DispatchRecord } from '../../dispatch/types.js';
import type { IntegrationEntry, RegistryState } from '../types.js';
import type { TriggerEnvelope } from '../../triggers/types.js';

/**
 * Outcome of one adapter dispatch.  Folded into the dispatch record's
 * `providerReceipt` via a PATCH; never carries PE/RE state.
 */
export interface DispatchReceipt {
  provider: string;
  adapter: string;
  /** End-to-end latency from adapter.dispatch() to receipt return. */
  latencyMs: number;
  /** Provider-side run id when available (e.g. Ollama response id). */
  externalRunId?: string;
  /** Final status to write onto the dispatch record. */
  status: 'sent' | 'failed';
  /** Error message on failure paths. */
  error?: string;
  /** Optional provider-shaped extras (model name, token counts, …). */
  metadata?: Record<string, unknown>;
}

/**
 * Shared dependencies passed to `init()`.  Adapters keep the dispatcher
 * decoupled from outbound providers — they only know how to format a
 * request, parse the response, and post a completion.
 */
export interface AdapterDeps {
  registry: RegistryState;
  /** PE's own completion endpoint URL — adapters POST here on success. */
  completionUrl: string;
  /** Base URL for ledger PATCH (`${base}/api/dispatch/records/:id`). */
  ledgerPatchBaseUrl?: string;
  /**
   * Optional injectable now-ms supplier and HTTP transport for tests.
   * Production adapters use axios directly.
   */
  now?: () => number;
}

/**
 * Provider adapter contract.  Adapters are picked by `kind`, which
 * matches the value of `IntegrationEntry.kind` in the registry.
 */
export interface ProviderAdapter {
  readonly kind: string;
  /** Identifier from the registry — used for routing by integration id. */
  readonly id?: string;
  init(cfg: IntegrationEntry, deps: AdapterDeps): Promise<void>;
  dispatch(envelope: TriggerEnvelope, record: DispatchRecord): Promise<DispatchReceipt>;
  shutdown(): Promise<void>;
}
