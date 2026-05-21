/**
 * AdapterPipeline — fan-out hook the Dispatcher calls after appending a
 * record to the ledger.  Selects the right {@link ProviderAdapter} per
 * envelope (today: by `envelope.dispatch.endpoint.kind`) and invokes
 * `dispatch()` asynchronously.  The call is fire-and-forget at this
 * layer — provider completion lands back through
 * `POST /api/integrations/completions`.
 *
 * On a successful dispatch the pipeline PATCHes the ledger record with
 * the delivery metadata returned by the adapter (status, attempts,
 * adapter, externalRunId, providerReceipt).  This keeps the audit trail
 * complete without coupling the adapter to the ledger directly.
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';

import type { DispatchRecord, DispatchRecordPatch } from '../dispatch/types.js';
import type { TriggerEnvelope } from '../triggers/types.js';
import type { DispatchReceipt, ProviderAdapter } from './adapters/types.js';

export interface AdapterPipelineOptions {
  http?: AxiosInstance;
  /** Optional ledger PATCH base — defaults to skipping the PATCH call. */
  ledgerPatchBaseUrl?: string;
  /** Optional injectable now-ms. */
  now?: () => number;
  /** Where errors are surfaced — defaults to console.warn. */
  onError?: (err: unknown, ctx: { envelopeId: string; adapter: string }) => void;
}

export class AdapterPipeline {
  private readonly adapters: ProviderAdapter[] = [];
  private readonly http: AxiosInstance;
  private readonly ledgerPatchBaseUrl?: string;
  private readonly onError: NonNullable<AdapterPipelineOptions['onError']>;

  constructor(opts: AdapterPipelineOptions = {}) {
    this.http = opts.http ?? axios.create();
    this.ledgerPatchBaseUrl = opts.ledgerPatchBaseUrl;
    this.onError = opts.onError ?? ((err, ctx) => {
      // eslint-disable-next-line no-console
      console.warn(`[adapters] ${ctx.adapter} dispatch failed for envelope=${ctx.envelopeId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Called by the Dispatcher right after a ledger.append.  Picks the
   * adapter whose `kind` matches the envelope's dispatch endpoint kind
   * — currently `dry-run` is treated as a no-op so the dispatcher
   * counters still reflect what was emitted.
   */
  onRecord(envelope: TriggerEnvelope, record: DispatchRecord): void {
    const kind = envelope.dispatch?.endpoint?.kind;
    if (!kind || kind === 'dry-run') return;
    const adapter = this.findAdapter(kind);
    if (!adapter) return;

    // Fire-and-forget.  Errors are caught and surfaced through onError
    // so they never crash the dispatcher.
    void this.runAdapter(adapter, envelope, record);
  }

  /** Number of registered adapters. */
  size(): number { return this.adapters.length; }

  /** Look up a registered adapter by kind — used by manual dispatch routes. */
  getAdapter(kind: string): ProviderAdapter | undefined {
    return this.findAdapter(kind);
  }

  /** Invoke an adapter synchronously (awaited) and patch the ledger record. */
  async runSync(
    adapter: ProviderAdapter,
    envelope: TriggerEnvelope,
    record: DispatchRecord,
  ): Promise<DispatchReceipt> {
    let receipt: DispatchReceipt;
    try {
      receipt = await adapter.dispatch(envelope, record);
    } catch (err) {
      receipt = {
        provider: adapter.kind, adapter: adapter.kind, latencyMs: 0,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (this.ledgerPatchBaseUrl) {
      try {
        const patch: DispatchRecordPatch = {
          status: receipt.status,
          incrementAttempts: true,
          provider: receipt.provider,
          adapter: receipt.adapter,
          externalRunId: receipt.externalRunId,
          providerReceipt: { latencyMs: receipt.latencyMs, ...(receipt.metadata ?? {}) },
        };
        if (receipt.status === 'failed' && receipt.error) patch.error = receipt.error;
        const url = `${this.ledgerPatchBaseUrl.replace(/\/$/, '')}/api/dispatch/records/${encodeURIComponent(record.id)}`;
        await this.http.patch(url, patch);
      } catch { /* best-effort */ }
    }
    return receipt;
  }

  async shutdown(): Promise<void> {
    for (const a of this.adapters) {
      try { await a.shutdown(); } catch { /* ignore */ }
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  private findAdapter(kind: string): ProviderAdapter | undefined {
    if (kind === 'openclaw-acp') {
      return this.adapters.find((a) => a.kind === 'acp' || a.kind === 'openclaw-acp');
    }
    return this.adapters.find((a) => a.kind === kind);
  }

  private async runAdapter(
    adapter: ProviderAdapter,
    envelope: TriggerEnvelope,
    record: DispatchRecord,
  ): Promise<void> {
    let receipt: DispatchReceipt;
    try {
      receipt = await adapter.dispatch(envelope, record);
    } catch (err) {
      this.onError(err, { envelopeId: envelope.envelopeId, adapter: adapter.kind });
      receipt = {
        provider: adapter.kind, adapter: adapter.kind, latencyMs: 0,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // PATCH the ledger record with the receipt.  Best-effort: a failed
    // PATCH never breaks the dispatch path.
    if (!this.ledgerPatchBaseUrl) return;
    try {
      const patch: DispatchRecordPatch = {
        status: receipt.status,
        incrementAttempts: true,
        provider: receipt.provider,
        adapter: receipt.adapter,
        externalRunId: receipt.externalRunId,
        providerReceipt: {
          latencyMs: receipt.latencyMs,
          ...(receipt.metadata ?? {}),
        },
      };
      if (receipt.status === 'failed' && receipt.error) patch.error = receipt.error;
      const url = `${this.ledgerPatchBaseUrl.replace(/\/$/, '')}/api/dispatch/records/${encodeURIComponent(record.id)}`;
      await this.http.patch(url, patch);
    } catch (err) {
      this.onError(err, { envelopeId: envelope.envelopeId, adapter: adapter.kind });
    }
  }
}
