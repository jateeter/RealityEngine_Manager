/**
 * Dispatch Ledger — in-memory ring with optional JSONL persistence.
 *
 * Used by the Phase-2 trigger dispatcher (append on each envelope) and
 * exposed in Phase 3 through `GET /api/dispatch/ledger`,
 * `GET /api/dispatch/records/:id`, and
 * `PATCH /api/dispatch/records/:id`.
 *
 * Storage model — matches `RealityEngine_CPP::dispatch_*`:
 *   - up to {@link DEFAULT_CAPACITY} records, FIFO eviction
 *   - records keyed by `record.id`
 *   - JSONL file appended on every mutation; on boot we replay the file
 *     and keep the most recent {@link DEFAULT_CAPACITY} entries
 *
 * Update contract (`PATCH /api/dispatch/records/:id`) deliberately
 * narrow — only delivery-metadata fields the architecture doc calls
 * out.  Unknown / forbidden fields are silently ignored, matching the
 * C++ `update_dispatch_record` behaviour.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

import type {
  DispatchRecord,
  DispatchRecordPatch,
  DispatchRecordUpdatedEvent,
} from './types.js';

export const DEFAULT_CAPACITY = 256;

export interface LedgerOptions {
  capacity?: number;
  /**
   * Optional path to a JSONL file.  When set, each append/update writes
   * one line; on construction we replay the file (last-write-wins per
   * `id`) and keep the most recent `capacity` records in memory.
   */
  persistencePath?: string | null;
  /** Now-ms supplier; injectable for deterministic tests. */
  now?: () => number;
}

export class Ledger {
  private readonly capacity: number;
  private readonly persistencePath: string | null;
  private readonly now: () => number;
  private readonly records = new Map<string, DispatchRecord>();
  private readonly order: string[] = [];

  constructor(opts: LedgerOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.persistencePath = opts.persistencePath ?? null;
    this.now = opts.now ?? Date.now;
    if (this.persistencePath) {
      this.ensureFileDir();
      this.replayFromFile();
    }
  }

  // ── Public surface ───────────────────────────────────────────────────

  /** Returns the number of records currently held in memory. */
  size(): number {
    return this.records.size;
  }

  /** Append a freshly-built record.  Evicts the oldest on overflow. */
  append(record: DispatchRecord): void {
    this.insert(record);
    this.persist(record);
  }

  /** Snapshot in insertion order, oldest first. */
  list(): DispatchRecord[] {
    return this.order
      .map((id) => this.records.get(id))
      .filter((r): r is DispatchRecord => r !== undefined);
  }

  get(id: string): DispatchRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Apply a narrow PATCH to an existing record.  Returns the updated
   * record or `undefined` when no record with that id exists.  Unknown
   * fields are ignored — only the keys on {@link DispatchRecordPatch}
   * are honoured.
   */
  update(id: string, patch: DispatchRecordPatch): DispatchRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;

    const next: DispatchRecord = { ...current };
    if (typeof patch.status === 'string') next.status = patch.status;
    if (typeof patch.error === 'string') next.error = patch.error;
    if (patch.clearError === true) next.error = '';
    if (typeof patch.attempts === 'number' && Number.isFinite(patch.attempts)) {
      next.attempts = patch.attempts;
    } else if (patch.incrementAttempts === true) {
      next.attempts = (current.attempts ?? 0) + 1;
    }

    const baseReceipt: Record<string, unknown> = current.providerReceipt && typeof current.providerReceipt === 'object'
      ? { ...current.providerReceipt }
      : {};
    let receiptTouched = false;
    if (patch.providerReceipt && typeof patch.providerReceipt === 'object' && !Array.isArray(patch.providerReceipt)) {
      Object.assign(baseReceipt, patch.providerReceipt);
      receiptTouched = true;
    }
    if (typeof patch.provider === 'string')      { baseReceipt['provider']      = patch.provider;      receiptTouched = true; }
    if (typeof patch.adapter === 'string')       { baseReceipt['adapter']       = patch.adapter;       receiptTouched = true; }
    if (typeof patch.externalRunId === 'string') { baseReceipt['externalRunId'] = patch.externalRunId; receiptTouched = true; }
    if (receiptTouched && Object.keys(baseReceipt).length > 0) {
      next.providerReceipt = baseReceipt;
    }

    next.updatedAt = this.now();
    this.records.set(id, next);
    this.persist(next);
    return next;
  }

  /**
   * Build the WebSocket payload that the routes broadcast after a
   * successful PATCH — kept here so the broadcast shape lives next to
   * the data it describes.
   */
  toUpdatedEvent(record: DispatchRecord): DispatchRecordUpdatedEvent {
    return {
      type: 'dispatch.record.updated',
      dispatchId: record.id,
      status: record.status,
      target: record.target,
      attempts: record.attempts,
      timestamp: record.updatedAt,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private insert(record: DispatchRecord): void {
    const existed = this.records.has(record.id);
    this.records.set(record.id, record);
    if (!existed) this.order.push(record.id);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest) this.records.delete(oldest);
    }
  }

  private persist(record: DispatchRecord): void {
    if (!this.persistencePath) return;
    try {
      appendFileSync(this.persistencePath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      // Soft-fail: persistence is audit, not the primary store.
      // eslint-disable-next-line no-console
      console.warn(
        `[dispatch.ledger] failed to append ${record.id} to ${this.persistencePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private ensureFileDir(): void {
    if (!this.persistencePath) return;
    const dir = dirname(this.persistencePath);
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }

  /**
   * Replay the JSONL file on construction.  Skips malformed lines and
   * uses last-write-wins per `id` so PATCH updates supersede their
   * original APPEND entries.
   */
  private replayFromFile(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistencePath, 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[dispatch.ledger] failed to read ${this.persistencePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const lines = raw.split('\n');
    const seen = new Map<string, DispatchRecord>();
    const insertionOrder: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as DispatchRecord;
        if (!rec || typeof rec.id !== 'string' || rec.id === '') continue;
        if (!seen.has(rec.id)) insertionOrder.push(rec.id);
        seen.set(rec.id, rec);
      } catch {
        // Skip malformed lines silently — JSONL audit must tolerate them.
      }
    }
    // Apply in insertion order, then let the ring eviction trim to capacity.
    for (const id of insertionOrder) {
      const rec = seen.get(id);
      if (rec) this.insert(rec);
    }
  }
}
