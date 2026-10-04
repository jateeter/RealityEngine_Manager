/**
 * A source on an OSRE cell is folded with the OSRE value by the writing
 * machine's declared outputMergeTransformation, over [0..1]
 * (ARBITER_CONTRACT.md §4.4b, owner decision 2026-10-02) — the operator the
 * fold already applies to that machine's outputs. The PE meets LLM-provided
 * values in [0..1], so each operator is used in its multi-valued form with
 * chain top 1; a Boolean gate's first-order form would collapse them.
 */

/** The declared operator applied to source value `s` and OSRE value `o`. Unknown names fold as `or`. */
export function foldUnitInterval(transformation: string, s: number, o: number): number {
  switch (transformation) {
    case 'and':
    case 'meet':
    case 'discrete-median':
      return Math.min(s, o);
    case 'strong-disjunction':
      return Math.min(1, s + o);
    case 'strong-conjunction':
      return Math.max(0, s + o - 1);
    case 'xor':
      return Math.max(Math.min(s, 1 - o), Math.min(1 - s, o));
    case 'nor':
      return 1 - Math.max(s, o);
    case 'nand':
      return 1 - Math.min(s, o);
    default:
      return Math.max(s, o); // or, join
  }
}

interface MachineLike { name?: unknown; outputMergeTransformation?: unknown }

/**
 * Every cell of every mergeBatch output region in `step`, mapped to the writing
 * machine's operator. Where several machines' outputs cover a cell, the first by
 * machine NAME decides — ids are minted per runtime, so id order would differ.
 */
export function osreFoldCells(step: unknown, getMachine: (id: string) => MachineLike | undefined): Map<number, string> {
  return new Map([...osreFoldCellsWithMachine(step, getMachine)].map(([cell, v]) => [cell, v.transformation]));
}

/** As osreFoldCells, keeping the writing machine's name: the name goes into
 * the fold's record (RealityEngine_CI#525). */
export function osreFoldCellsWithMachine(
  step: unknown,
  getMachine: (id: string) => MachineLike | undefined,
): Map<number, { name: string; transformation: string }> {
  const batch = (step as { mergeBatch?: unknown } | null)?.mergeBatch;
  const byCell = new Map<number, { name: string; transformation: string }>();
  if (!Array.isArray(batch)) return new Map();
  for (const op of batch as Array<Record<string, any>>) {
    const machineId = typeof op?.machineId === 'string' ? op.machineId : '';
    const offset = typeof op?.region?.offset === 'number' ? op.region.offset : -1;
    const length = typeof op?.region?.length === 'number' ? op.region.length : 0;
    if (!machineId || offset < 0) continue;
    const m = getMachine(machineId);
    const name = typeof m?.name === 'string' ? m.name : typeof op.machineName === 'string' ? op.machineName : machineId;
    const transformation = typeof m?.outputMergeTransformation === 'string' ? m.outputMergeTransformation : 'or';
    for (let cell = offset; cell < offset + length; cell++) {
      const prior = byCell.get(cell);
      if (!prior || name < prior.name) byCell.set(cell, { name, transformation });
    }
  }
  return byCell;
}
