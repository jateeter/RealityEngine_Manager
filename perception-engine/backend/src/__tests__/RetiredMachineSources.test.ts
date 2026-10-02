import { PerceptionEngine } from '../PerceptionEngine';
import type { TestSourceConfig } from '../types';

/**
 * This PE persists its sources across restarts, so an interned source outlived
 * a machine retired from the corpus: `RS Flip Flop (deprecated demo)` kept
 * driving its lane after RealityEngine_Machines#182 and failed the runtime-trace
 * joinability contract (RealityEngine_Machines#126). The bootstrap now removes
 * interned sources whose machine the RE no longer serves.
 */
const interned = (machineId: string, name: string) =>
  ({
    name, type: 'test', region: { offset: 0, length: 2 }, active: true,
    machineId, machineName: name, sequenceName: 'seq', inputs: [[1, 0]], loop: true,
  }) as unknown as Omit<TestSourceConfig, 'id'>;

describe('PerceptionEngine.removeInternedSourcesOutside', () => {
  it('removes interned sources of machines the corpus no longer holds', () => {
    const engine = new PerceptionEngine();
    engine.addSource(interned('machine-kept', 'Kept'));
    engine.addSource(interned('machine-retired', 'RS Flip Flop (deprecated demo)'));
    const removed = engine.removeInternedSourcesOutside(new Set(['machine-kept']));
    expect(removed.map(s => s.name)).toEqual(['RS Flip Flop (deprecated demo)']);
    expect(engine.getSources().map(s => s.name)).toEqual(['Kept']);
  });

  it('never touches a source a caller registered', () => {
    const engine = new PerceptionEngine();
    engine.addSource({
      name: 'Envelope contract seed', type: 'test', region: { offset: 0, length: 2 }, active: true,
      inputs: [[0, 1]], loop: false,
    } as unknown as Omit<TestSourceConfig, 'id'>);
    expect(engine.removeInternedSourcesOutside(new Set())).toEqual([]);
    expect(engine.getSources()).toHaveLength(1);
  });
});
