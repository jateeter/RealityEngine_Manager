import { PerceptionEngine } from '../PerceptionEngine';
import { foldUnitInterval, osreFoldCells } from '../osreFold';
import type { TestSourceConfig } from '../types';

/**
 * A source on an OSRE cell is folded with the OSRE value by the writing
 * machine's declared operator over [0..1] (ARBITER_CONTRACT.md §4.4b).
 */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;

describe('foldUnitInterval', () => {
  it.each([
    ['or', 0.3, 0.6, 0.6], ['join', 0.3, 0.6, 0.6], ['and', 0.3, 0.6, 0.3], ['meet', 0.3, 0.6, 0.3],
    ['discrete-median', 0.3, 0.6, 0.3], ['strong-disjunction', 0.7, 0.6, 1], ['strong-conjunction', 0.7, 0.6, 0.3],
    ['strong-conjunction', 0.2, 0.3, 0], ['xor', 0.25, 1, 0.75], ['nor', 0.25, 0.5, 0.5], ['nand', 0.25, 0.5, 0.75],
    ['not-a-name', 0.25, 0.5, 0.5],
  ])('%s(%p, %p) = %p', (op, s, o, want) => {
    expect(near(foldUnitInterval(op as string, s as number, o as number), want as number)).toBe(true);
  });
});

describe('osreFoldCells', () => {
  it('maps mergeBatch output cells to their machine operator, first by name on shared cells', () => {
    const step = { mergeBatch: [
      { machineId: 'm-z', region: { offset: 10, length: 2 } },
      { machineId: 'm-a', region: { offset: 11, length: 2 } },
    ] };
    const machines: Record<string, { name: string; outputMergeTransformation: string }> = {
      'm-z': { name: 'Zeta', outputMergeTransformation: 'and' },
      'm-a': { name: 'Alpha', outputMergeTransformation: 'strong-disjunction' },
    };
    expect([...osreFoldCells(step, (id) => machines[id])]).toEqual([
      [10, 'and'], [11, 'strong-disjunction'], [12, 'strong-disjunction'],
    ]);
  });
});

describe('assembly with an OSRE term', () => {
  it('folds a source on an OSRE cell and leaves OSRE-only cells alone', () => {
    const engine = new PerceptionEngine(64);
    const ps = Array.from({ length: 64 }, (_, i) => (i >= 50 && i <= 52 ? 0.6 : 0));
    engine.updateFromPerceptualSpace(ps);
    engine.addSource({
      name: 'OSRE lane seed', type: 'test', region: { offset: 50, length: 2 }, active: true,
      machineId: 'm', machineName: 'm', sequenceName: 's', inputs: [[0.3, 0.3]], loop: true,
    } as unknown as Omit<TestSourceConfig, 'id'>);
    expect(near(engine.assembleVector()[50]!, 0.3)).toBe(true);
    engine.setOsreFold(new Map([[50, 'or'], [51, 'and'], [52, 'or']]));
    const v = engine.assembleVector();
    expect(near(v[50]!, 0.6)).toBe(true);
    expect(near(v[51]!, 0.3)).toBe(true);
    expect(near(v[52]!, 0.6)).toBe(true);
    engine.reset();
    expect(near(engine.assembleVector()[50]!, 0.3)).toBe(true);
  });
});
