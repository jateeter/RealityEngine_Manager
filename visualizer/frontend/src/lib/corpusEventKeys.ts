// Reading machine structure while the corpus is mid-rename.
//
// RealityEngine_CI#220 layer 1 renames three keys that describe the shape of a
// machine, in the corpus and in every engine response that echoes one:
//
//     vectors        -> events
//     outputVectors  -> outputEvents
//     nextVectorIds  -> nextEventIds
//
// The four runtimes cannot flip in the same instant, so for one landing the
// views must read whichever spelling the engine they are pointed at happens to
// emit. These accessors are that tolerance, in one place, so layer 1c can
// delete this file rather than hunt the fallbacks down individually.
//
// Why accessors rather than `x.events ?? x.vectors` at each site: the reads
// here sit behind `any` — the machine export is parsed untyped — so a missed
// site does not fail the build. It renders an empty graph instead, which is the
// failure mode this whole rename has to avoid. Routing every read through a
// named function makes the remaining sites greppable, and makes "did we get
// them all?" a question `tsc` can help with once the `any` goes.

/** A sequence as it arrives from an engine, in either spelling. */
export interface EventSequenceShaped {
  events?: unknown;
  vectors?: unknown;
}

/** An event as it arrives from an engine, in either spelling. */
export interface RealityEventShaped {
  outputEvents?: unknown;
  outputVectors?: unknown;
  nextEventIds?: unknown;
  nextVectorIds?: unknown;
}

// Canonical first, legacy second, empty array last. Every accessor returns an
// array so callers never repeat an Array.isArray guard, and a machine that is
// genuinely empty is indistinguishable from one whose key we failed to find —
// which is precisely why the corpus-load count check in layer 1b exists.
function firstArray<T>(...candidates: unknown[]): T[] {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

/** The events of a critical event sequence. */
export function sequenceEvents<T = any>(sequence: EventSequenceShaped | null | undefined): T[] {
  return firstArray<T>(sequence?.events, sequence?.vectors);
}

/** The output events a Reality Event fires when it matches. */
export function outputEvents<T = any>(event: RealityEventShaped | null | undefined): T[] {
  return firstArray<T>(event?.outputEvents, event?.outputVectors);
}

/** The ids of the events armed by this one. */
export function nextEventIds(event: RealityEventShaped | null | undefined): string[] {
  return firstArray<string>(event?.nextEventIds, event?.nextVectorIds);
}
