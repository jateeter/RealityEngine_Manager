// The successor of a workflow step (owner, 2026-11-09; localAssetStorageStack
// ROADMAP phase 9): the signal and the continuation pass on to the next clone
// in the workflow, and that next clone is named by the template machine's own
// interconnections — its `document-workflow-handoff` edges. No step chooses its
// successor (D10): the corpus does.

/** A machine as the RE serves it (`GET /api/machines/:id`), the part read here. */
export interface TemplateMachine {
  id: string;
  metadata?: { interconnections?: unknown[] } & Record<string, unknown>;
}

/** The case keys a frame carries (lifecycle `frame.case`). */
export interface FrameCase {
  delimiter?: string;
  assetType?: string | null;
}

/** A corpus file stem as the engines turn it into a machine id. */
export const machineIdOf = (stem: string): string =>
  `machine-${stem.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

interface Handoff { sourceMachine: string; targetMachine: string; assetTypeId?: string }

const isHandoff = (e: unknown): e is Handoff =>
  !!e && typeof e === 'object'
  && (e as Record<string, unknown>).type === 'document-workflow-handoff'
  && typeof (e as Record<string, unknown>).sourceMachine === 'string'
  && typeof (e as Record<string, unknown>).targetMachine === 'string';

/**
 * The next template, or null when the template hands off to nothing: then the
 * step was the workflow's last, and terminating it closes the frame's head
 * (D11).
 *
 * The template's own outgoing handoffs are those whose `sourceMachine` is the
 * template (by file stem). When the frame names an asset type, the handoff for
 * that asset type is taken; otherwise the first, in declared order, so every
 * engine side reading the same corpus takes the same one.
 */
export function successorOf(template: TemplateMachine, kase: FrameCase): string | null {
  const edges = (template.metadata?.interconnections ?? []).filter(isHandoff)
    .filter((e) => machineIdOf(e.sourceMachine) === template.id);
  if (edges.length === 0) return null;
  const chosen = kase.assetType ? edges.find((e) => e.assetTypeId === kase.assetType) ?? null : edges[0];
  return chosen ? machineIdOf(chosen.targetMachine) : null;
}
