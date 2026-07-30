/**
 * Semantic audit trail — re:PerceptionEvent records and dispatch-record
 * semantics links.
 *
 * Record shapes, IRI construction, and the `GET /api/audit/semantics`
 * surface are specified in RealityEngine_Machines
 * docs/SEMANTIC_AUDIT_CONTRACT.md (milestone M5). IRIs are derived from the
 * corpus semantics manifest via semanticsManifest.ts, so runtime records join
 * to the generated machine ABoxes with no name matching downstream.
 *
 * The RE emits re:SequenceObservation records (it owns sequence transitions);
 * the PE owns ingress (re:PerceptionEvent) and dispatch (re:DispatchRecord).
 */

import { semanticIdentityFor } from './semanticsManifest.js';

export interface PerceptionEvent {
  type: 're:PerceptionEvent';
  at: number;
  sourceId: string;
  machineName: string | null;
  machineIri: string | null;
  offset: number;
  length: number;
}

export interface DispatchSemantics {
  machineIri: string | null;
  sequenceIri: string | null;
  actionCode: string | null;
}

export const SEMANTIC_AUDIT_CAPACITY = 1000;

const buffer: PerceptionEvent[] = [];

/** Local names follow scripts/generate-owl.py sanitize(): [^A-Za-z0-9_-] -> _ */
function sanitizeLocal(local: string): string {
  const cleaned = local.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

/** ABox base IRI (manifest iri minus the #machine fragment), or null. */
function baseIriFor(machineName: string | null | undefined): string | null {
  if (!machineName) return null;
  const identity = semanticIdentityFor(machineName);
  if (!identity?.semanticsIri) return null;
  const hash = identity.semanticsIri.indexOf('#');
  return hash === -1 ? identity.semanticsIri : identity.semanticsIri.slice(0, hash);
}

/** Record a PE write into a machine's input region. */
export function recordPerceptionEvent(args: {
  sourceId: string;
  machineName?: string | null;
  offset: number;
  length: number;
  at?: number;
}): PerceptionEvent {
  const base = baseIriFor(args.machineName);
  const event: PerceptionEvent = {
    type: 're:PerceptionEvent',
    at: args.at ?? Date.now(),
    sourceId: args.sourceId,
    machineName: args.machineName ?? null,
    machineIri: base ? `${base}#machine` : null,
    offset: args.offset,
    length: args.length,
  };
  buffer.push(event);
  while (buffer.length > SEMANTIC_AUDIT_CAPACITY) buffer.shift();
  return event;
}

/** Oldest-to-newest, at most `limit` most recent events. */
export function recentPerceptionEvents(limit: number): PerceptionEvent[] {
  const bounded = Math.max(0, Math.min(limit, SEMANTIC_AUDIT_CAPACITY));
  return buffer.slice(-bounded);
}

export function semanticAuditSize(): number {
  return buffer.length;
}

export function clearSemanticAudit(): void {
  buffer.length = 0;
}

/**
 * Semantics link for a dispatch ledger record: the corpus IRIs for the
 * machine and sequence whose determination triggered the dispatch.
 */
export function dispatchSemantics(args: {
  machineName?: string | null;
  sequenceId?: string | null;
  actionCode?: string | null;
}): DispatchSemantics {
  const base = baseIriFor(args.machineName);
  return {
    machineIri: base ? `${base}#machine` : null,
    sequenceIri: base && args.sequenceId ? `${base}#seq-${sanitizeLocal(args.sequenceId)}` : null,
    actionCode: args.actionCode ?? null,
  };
}
