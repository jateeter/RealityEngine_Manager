import { resolveCell, resolveAll, determinismOf, severityRank } from '../Arbiter.js';
import type { Contribution, RegistryEntry } from '../Arbiter.js';

/**
 * Conformance checks for RealityEngine_Machines docs/ARBITER_CONTRACT.md.
 *
 * The properties here are the ones no live probe can establish: that resolution
 * does not depend on the order contributions arrive in, nor on how the resolve
 * phase is sharded. Those are the entire basis for parallelising the arbiter,
 * and a violation would be invisible in any single run.
 */

const c = (
  value: number,
  provider: string,
  originId: string,
  ragStatusCode?: string,
): Contribution => ({ cell: 1, value, provider, originId, cesId: 'seq', outputVectorId: 'ov', ragStatusCode });

describe('determinism classification', () => {
  it('treats an unregistered surface as generated', () => {
    expect(determinismOf('machine')).toBe('deterministic');
    expect(determinismOf('mqtt')).toBe('measured');
    expect(determinismOf('acp')).toBe('generated');
    // A surface nobody registered must not outrank a reading by default.
    expect(determinismOf('some-future-surface')).toBe('generated');
  });

  it('ranks life-safety above RED', () => {
    expect(severityRank('RED')).toBeLessThan(severityRank('GREEN', true));
  });
});

describe('PRECEDENCE', () => {
  const entry: RegistryEntry = { cell: 1, rule: 'PRECEDENCE' };

  it('never lets a generated contribution override a deterministic one', () => {
    // The generated value is larger, so a MAX-based merge would take it.
    const { value, record } = resolveCell(1, 0, [c(0, 'machine', 'm1'), c(1, 'acp', 'agent-1')], entry);
    expect(value).toBe(0);
    expect(record?.suppressed.map((s) => s.provider)).toEqual(['acp']);
  });

  it('applies withinRank instead of falling back to MAX', () => {
    const withSeverity: RegistryEntry = { cell: 1, rule: 'PRECEDENCE', withinRank: 'SEVERITY' };
    // Two machine determinations plus an agent: RED asserts 0, AMBER asserts 1.
    // MAX would take 1; SEVERITY within the winning class must take 0.
    const { value } = resolveCell(
      1,
      0,
      [c(1, 'machine', 'm-amber', 'AMBER'), c(0, 'machine', 'm-red', 'RED'), c(1, 'acp', 'a1')],
      withSeverity,
    );
    expect(value).toBe(0);
  });

  it('honours a per-cell providerRanks override', () => {
    const raised: RegistryEntry = { cell: 1, rule: 'PRECEDENCE', providerRanks: { acp: 9, machine: 3 } };
    const { value } = resolveCell(1, 0, [c(0, 'machine', 'm1'), c(1, 'acp', 'a1')], raised);
    expect(value).toBe(1);
  });
});

describe('SEVERITY', () => {
  it('resolves by RAG rank before value', () => {
    const { value } = resolveCell(
      1,
      0,
      [c(1, 'machine', 'a', 'AMBER'), c(0, 'machine', 'b', 'RED')],
      { cell: 1, rule: 'SEVERITY' },
    );
    expect(value).toBe(0);
  });
});

describe('order independence', () => {
  const entry: RegistryEntry = { cell: 1, rule: 'PRECEDENCE', withinRank: 'SEVERITY' };
  const base = [
    c(1, 'machine', 'm-amber', 'AMBER'),
    c(0, 'machine', 'm-red', 'RED'),
    c(0.7, 'acp', 'agent-1'),
    c(0.3, 'mqtt', 'sensor-1'),
  ];

  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  it('resolves identically under every arrival order', () => {
    // Acceptance criteria 2 and 4. This is the externally visible form of the
    // commutative-monoid requirement, and the property most likely to break once
    // sources arrive asynchronously.
    const results = new Set(permutations(base).map((p) => resolveCell(1, 0, p, entry).value));
    expect(results.size).toBe(1);
  });

  it('MEAN is order-independent under its canonical ordering', () => {
    // Floating-point addition is not associative, so MEAN is admissible only
    // with the contract's canonical contributor order.
    const cs = [c(0.1, 'machine', 'c'), c(0.2, 'machine', 'a'), c(0.7, 'machine', 'b')];
    const results = new Set(permutations(cs).map((p) => resolveCell(1, 0, p, { cell: 1, rule: 'MEAN' }).value));
    expect(results.size).toBe(1);
  });
});

describe('records', () => {
  it('emits none for a single contributor and resolves to it', () => {
    const { value, record } = resolveCell(1, 0, [c(0.42, 'acp', 'a1')], undefined);
    expect(value).toBe(0.42);
    expect(record).toBeNull();
  });

  it('accounts for every contribution', () => {
    const cs = [c(0, 'machine', 'm1'), c(1, 'acp', 'a1'), c(0.5, 'mcp', 'a2')];
    const { record } = resolveCell(1, 0, cs, { cell: 1, rule: 'PRECEDENCE' });
    // contributors ∪ suppressed must equal the full set — a discarded agent
    // answer has to stay attributable.
    const seen = new Set([...(record?.contributors ?? []), ...(record?.suppressed ?? [])]);
    expect(seen.size).toBe(cs.length);
    expect(record?.suppressed.map((s) => s.provider).sort()).toEqual(['acp', 'mcp']);
  });
});

describe('resolveAll', () => {
  it('resolves cells independently', () => {
    const byCell = new Map<number, Contribution[]>([
      [10, [{ ...c(0, 'machine', 'm1'), cell: 10 }, { ...c(1, 'acp', 'a1'), cell: 10 }]],
      [11, [{ ...c(0.25, 'acp', 'a1'), cell: 11 }]],
    ]);
    const { values, records } = resolveAll(byCell, 0, () => ({ cell: 0, rule: 'PRECEDENCE' }));
    expect(values.get(10)).toBe(0); // machine wins
    expect(values.get(11)).toBe(0.25); // sole contributor
    expect(records).toHaveLength(1); // only the contended cell emits a record
  });
});
