/**
 * Reading Reality Event fields while the rename is in flight.
 *
 * RealityEngine_CI#220 layer 2 renames seven response-body keys. The engines
 * migrate one runtime at a time — the parity comparison canonicalises both
 * spellings, so a migrated engine and an unmigrated one compare equal — which
 * means this frontend can be pointed at any mixture of them.
 *
 *     inputVector      -> inputEvent
 *     activeVectors    -> activeEvents
 *     totalVectors     -> totalEvents
 *     vectorDimension  -> eventDimension
 *     matchedVectors   -> matchedEvents
 *     activatedVectors -> activatedEvents
 *     initialVectorIds -> initialEventIds
 *
 * Every read goes through here rather than being spelled out at ~20 call
 * sites. A missed engine site fails loudly, because the parity gate reports an
 * unexpected key set; a missed read here fails *quietly* — the value arrives
 * `undefined` and a panel renders blank — so the fallback is defined once where
 * it can be checked rather than repeated where it can be forgotten.
 *
 * The canonical name is tried first, so an engine emitting both during its own
 * transition is read as the new one.
 *
 * **Delete this file when the rename completes.** At that point every runtime
 * emits the canonical spelling, and these functions are an indirection with no
 * remaining purpose — leaving them behind is how a migration quietly never
 * finishes.
 *
 * Out of scope, deliberately: `outputVectors` is a *corpus schema* key
 * (#220 layer 1, ~66 reads here) and does not move with this layer.
 * `initialVectors` and `totalActiveVectors` are adjacent names the issue does
 * not list at all.
 */

type Loose = Record<string, any> | null | undefined;

/** The Reality Event a step was driven with. */
export const readInputEvent = (o: Loose): number[] | undefined =>
  o?.['inputEvent'] ?? o?.['inputVector'];

/** Reality Events a sequence matched on this step. */
export const readMatchedEvents = (o: Loose): string[] =>
  o?.['matchedEvents'] ?? o?.['matchedVectors'] ?? [];

/** Reality Events a sequence activated on this step. */
export const readActivatedEvents = (o: Loose): string[] =>
  o?.['activatedEvents'] ?? o?.['activatedVectors'] ?? [];

/** How many Reality Events a machine declares. */
export const readTotalEvents = (o: Loose): number | undefined =>
  o?.['totalEvents'] ?? o?.['totalVectors'];

/** How many Reality Events are currently active. */
export const readActiveEvents = (o: Loose): number | undefined =>
  o?.['activeEvents'] ?? o?.['activeVectors'];

/** Width of the perceptual space. */
export const readEventDimension = (o: Loose): number | undefined =>
  o?.['eventDimension'] ?? o?.['vectorDimension'];

/** Ids of the initial Reality Events of a sequence. */
export const readInitialEventIds = (o: Loose): string[] =>
  o?.['initialEventIds'] ?? o?.['initialVectorIds'] ?? [];
