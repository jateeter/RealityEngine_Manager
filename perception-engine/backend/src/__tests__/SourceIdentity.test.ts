import { PerceptionEngine } from '../PerceptionEngine';
import type { TestSourceConfig } from '../types';

/**
 * POST /api/sources keeps a caller-supplied id, as C++, LSP and Scala do
 * (C++ PerceptionEngine::add_source). This PE used to mint one regardless, so
 * a caller that deleted by the id it registered got a 404 and leaked the
 * source (RealityEngine_Machines#126).
 */
const seed = (over: Record<string, unknown> = {}) =>
  ({
    name: 'Seed', type: 'test', region: { offset: 0, length: 4 }, active: true,
    inputs: [[0, 1, 0, 1]], loop: false, ...over,
  }) as unknown as Omit<TestSourceConfig, 'id'>;

describe('PerceptionEngine.addSource identity', () => {
  it('keeps a caller-supplied id, so removal by that id works', () => {
    const engine = new PerceptionEngine();
    const s = engine.addSource(seed({ id: 'envelope-contract-1' }));
    expect(s.id).toBe('envelope-contract-1');
    expect(engine.removeSource('envelope-contract-1')).toBe(true);
    expect(engine.getSources().length).toBe(0);
  });

  it('mints an id when none, or an empty one, is supplied', () => {
    const engine = new PerceptionEngine();
    const a = engine.addSource(seed());
    const b = engine.addSource(seed({ id: '' }));
    expect(a.id).toMatch(/.+/);
    expect(b.id).toMatch(/.+/);
    expect(a.id).not.toBe(b.id);
  });

  it('replaces the source already holding the id, rather than adding a second', () => {
    const engine = new PerceptionEngine();
    engine.addSource(seed({ id: 'dup', name: 'First' }));
    engine.addSource(seed({ id: 'dup', name: 'Second', active: false }));
    const all = engine.getSources().filter(s => s.id === 'dup');
    expect(all.map(s => s.name)).toEqual(['Second']);
    expect(all[0]!.active).toBe(false);
  });
});
