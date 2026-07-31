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
  /** Upstream that produced the write: healthkit, mqtt, acp, openai, … */
  integration: string;
}

export interface DispatchSemantics {
  machineIri: string | null;
  sequenceIri: string | null;
  actionCode: string | null;
}

export const SEMANTIC_AUDIT_CAPACITY = 1000;

const buffer: PerceptionEvent[] = [];

/**
 * Cumulative guardrail counters.
 *
 * The ring buffer above is a bounded window for the audit API; these counters
 * are monotonic for the process lifetime so Prometheus can rate() them. They
 * are incremented where records are created, not where they are read, so a
 * buffer eviction never loses a count.
 */
interface IntegrationCounters {
  events: number;
  /** Events whose machine resolved to a corpus ABox IRI. */
  joined: number;
}

const eventCounters = new Map<string, IntegrationCounters>();
const dispatchCounters = { total: 0, joined: 0 };
/** Escalation dispatches keyed by RAG status ('RED', 'AMBER', 'GREEN', 'unstated'). */
const escalationCounters = new Map<string, number>();

/** Action codes that page a human or dispatch emergency response. */
const ESCALATION_ACTIONS = new Set(['emergency-dispatch', 'urgent-intervention']);

export interface SemanticAuditMetrics {
  bufferRecords: number;
  byIntegration: Array<{ integration: string; events: number; joined: number }>;
  dispatch: { total: number; joined: number };
  escalations: Array<{ rag: string; count: number }>;
}

/** Snapshot for the Prometheus exposition in /api/metrics. */
export function semanticAuditMetrics(): SemanticAuditMetrics {
  return {
    bufferRecords: buffer.length,
    byIntegration: [...eventCounters.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([integration, c]) => ({ integration, events: c.events, joined: c.joined })),
    dispatch: { ...dispatchCounters },
    escalations: [...escalationCounters.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rag, count]) => ({ rag, count })),
  };
}

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

/**
 * Record a PE write into a machine's input region.
 *
 * `integration` attributes the write to the upstream that produced it
 * (healthkit, mqtt, openclaw/acp, openai, ollama, …) so the guardrail
 * dashboard can show corpus-join health per integration.
 */
export function recordPerceptionEvent(args: {
  sourceId: string;
  machineName?: string | null;
  offset: number;
  length: number;
  at?: number;
  integration?: string | null;
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
    integration: args.integration ?? 'unattributed',
  };
  buffer.push(event);
  while (buffer.length > SEMANTIC_AUDIT_CAPACITY) buffer.shift();

  const key = event.integration;
  const counters = eventCounters.get(key) ?? { events: 0, joined: 0 };
  counters.events += 1;
  if (event.machineIri) counters.joined += 1;
  eventCounters.set(key, counters);

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
  eventCounters.clear();
  dispatchCounters.total = 0;
  dispatchCounters.joined = 0;
  escalationCounters.clear();
}

/**
 * Semantics link for a dispatch ledger record: the corpus IRIs for the
 * machine and sequence whose determination triggered the dispatch.
 */
export function dispatchSemantics(args: {
  machineName?: string | null;
  sequenceId?: string | null;
  actionCode?: string | null;
  ragStatusCode?: string | null;
}): DispatchSemantics {
  const base = baseIriFor(args.machineName);
  const semantics: DispatchSemantics = {
    machineIri: base ? `${base}#machine` : null,
    sequenceIri: base && args.sequenceId ? `${base}#seq-${sanitizeLocal(args.sequenceId)}` : null,
    actionCode: args.actionCode ?? null,
  };

  dispatchCounters.total += 1;
  if (semantics.machineIri) dispatchCounters.joined += 1;
  // Escalation guardrail: re:EscalationDetermination requires RED. The axiom
  // is open-world, so an unstated status is consistent and counted separately
  // from an explicit non-RED, which is a genuine violation.
  if (args.actionCode && ESCALATION_ACTIONS.has(args.actionCode)) {
    const rag = args.ragStatusCode && args.ragStatusCode.length > 0
      ? args.ragStatusCode
      : 'unstated';
    escalationCounters.set(rag, (escalationCounters.get(rag) ?? 0) + 1);
  }

  return semantics;
}
