/**
 * Dispatch ledger — public types.
 *
 * Wire-compatible with the `DispatchRecord` shape in
 * RealityEngine_CPP/src/perception_engine_server.cpp.  The record is the
 * canonical outbox/audit unit: created by the Phase-2 dispatcher,
 * exposed via the Phase-3 `/api/dispatch/*` routes, and annotated by the
 * Phase-4 provider adapters (delivery-metadata only — never PE/RE state).
 */

import type { DispatchMode, TriggerEnvelope } from '../triggers/types.js';

export interface DispatchRecord {
  id: string;
  envelopeId: string;
  correlationId: string;
  status: 'recorded' | 'sent' | 'failed' | string;
  mode: DispatchMode;
  target: string;
  machineId: string;
  sequenceId: string;
  ragStatusCode: string;
  processStatus: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  providerReceipt: Record<string, unknown> | null;
  envelope: TriggerEnvelope;
  error?: string;
  /**
   * When this record was created by `POST /api/triggers/replay/:id`, the
   * id of the original dispatch record being replayed.  Omitted on
   * primary records.  Lets consumers distinguish a replay from a fresh
   * fire without needing a side table.
   */
  replayOf?: string;
}

/**
 * Accepted body fields for `PATCH /api/dispatch/records/:id`.
 *
 * Mirrors the C++ deny-by-default approach: unknown / forbidden fields
 * (envelope mutations, PE/RE state, etc.) are silently ignored.  Only the
 * keys below are honoured.
 */
export interface DispatchRecordPatch {
  status?: string;
  error?: string;
  clearError?: boolean;
  attempts?: number;
  incrementAttempts?: boolean;
  providerReceipt?: Record<string, unknown>;
  provider?: string;
  adapter?: string;
  externalRunId?: string;
}

/** WebSocket payload broadcast after a successful PATCH. */
export interface DispatchRecordUpdatedEvent {
  type: 'dispatch.record.updated';
  dispatchId: string;
  status: string;
  target: string;
  attempts: number;
  timestamp: number;
}
