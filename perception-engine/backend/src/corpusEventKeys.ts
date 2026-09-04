// Reading machine structure while the corpus is mid-rename.
//
// RealityEngine_CI#220 layer 1 renames the key that holds a sequence's events:
//
//     vectors -> events
//
// The PE bootstraps one `test` source per `machine.metadata.inputSequences`
// entry, and reads each entry's events to build the source's input rows. That
// read is the single most dangerous one in this repository, because nothing
// downstream raises when it comes back empty: a sequence with no events is
// skipped, the machine falls into the `noSequences` reason bucket, and
// `bootstrapSourcesFromMachines` reports success having created nothing.
//
// So the fallback lives here, in a module a test can import — `server.ts` calls
// `listen()` at import time and cannot be pulled into a test process.

/** A machine input sequence as it arrives from an engine, in either spelling. */
export interface InputSequenceShaped {
  name?: string;
  events?: number[][];
  /** Pre-#220 spelling. Read it through `sequenceEvents`, never directly. */
  vectors?: number[][];
  recur?: boolean;
}

/**
 * The events of an input sequence, canonical spelling first.
 *
 * Always an array, so callers do not repeat an `Array.isArray` guard and an
 * absent key is not confused with a present-but-not-an-array one.
 */
export function sequenceEvents(seq: InputSequenceShaped | null | undefined): number[][] {
  if (Array.isArray(seq?.events)) return seq.events;
  if (Array.isArray(seq?.vectors)) return seq.vectors;
  return [];
}
