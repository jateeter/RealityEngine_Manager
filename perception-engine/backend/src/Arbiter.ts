/**
 * Output arbiter — RealityEngine_Machines docs/ARBITER_CONTRACT.md.
 *
 * assembleVector() previously wrote each source's region straight into the
 * output buffer as it iterated `activeSources`, so where two sources target the
 * same cell the last one iterated won. Set iteration order is insertion order,
 * which makes that stable — worse than nondeterministic, because a wrong
 * resolution reproduces perfectly and reads as correct.
 *
 * Every admissible rule here is a commutative monoid (contract §4.1). That is
 * the load-bearing property: it is what lets the resolve phase be sharded across
 * cells in any order, and what lets four independent runtimes agree on the same
 * IS(k+1). `first` and `last` satisfy none of it.
 */

export type Determinism = 'deterministic' | 'measured' | 'generated';

/**
 * Provider is an open registry, not a closed enum — integration surfaces
 * register here (contract §3). An unregistered surface is treated as
 * `generated`: misclassifying a generated source as measured would let
 * irreproducible content outrank a reading, which is the failure §4.3a exists to
 * prevent.
 */
const DETERMINISM_BY_PROVIDER: Record<string, Determinism> = {
  machine: 'deterministic',
  sensor: 'measured',
  mqtt: 'measured',
  healthkit: 'measured',
  stream: 'measured',
  ui: 'measured',
  synthetic: 'measured',
  acp: 'generated',
  mcp: 'generated',
  localai: 'generated',
};

const CLASS_RANK: Record<Determinism, number> = {
  deterministic: 3,
  measured: 2,
  generated: 1,
};

const RAG_RANK: Record<string, number> = { GREEN: 0, AMBER: 1, RED: 2 };
const LIFE_SAFETY_RANK = 3;

export function determinismOf(provider: string): Determinism {
  return DETERMINISM_BY_PROVIDER[provider] ?? 'generated';
}

export function severityRank(rag?: string | null, lifeSafety = false): number {
  if (lifeSafety) return LIFE_SAFETY_RANK;
  return rag ? (RAG_RANK[rag] ?? 0) : 0;
}

export interface Contribution {
  cell: number;
  value: number;
  provider: string;
  originId: string;
  cesId?: string;
  outputVectorId?: string;
  ragStatusCode?: string | null;
  lifeSafety?: boolean;
}

export interface ArbitrationRecord {
  instant: number;
  cell: number;
  rule: string;
  resolved: number;
  contributors: Contribution[];
  suppressed: Contribution[];
}

export interface RegistryEntry {
  cell: number;
  rule: string;
  withinRank?: string;
  providerRanks?: Record<string, number>;
}

function pickBy(cs: Contribution[], score: (c: Contribution) => number, want: 'max' | 'min'): Contribution[] {
  const scores = cs.map(score);
  const best = want === 'max' ? Math.max(...scores) : Math.min(...scores);
  return cs.filter((_, i) => scores[i] === best);
}

/**
 * Resolve one cell.
 *
 * Returns the value and a record naming what was suppressed. A discarded agent
 * assessment must stay attributable — "the agent's answer was thrown away" is
 * exactly the operational fact the domain bus exists to surface (§6).
 */
export function resolveCell(
  cell: number,
  instant: number,
  contributions: Contribution[],
  entry?: RegistryEntry,
): { value: number; record: ArbitrationRecord | null } {
  if (contributions.length === 0) return { value: 0, record: null };
  // A single contributor resolves to itself regardless of declared rule (§4.5)
  // and needs no record.
  if (contributions.length === 1) return { value: contributions[0].value, record: null };

  const rule = entry?.rule ?? 'PRECEDENCE';
  let winners: Contribution[];

  switch (rule) {
    case 'OR':
    case 'MAX':
      winners = pickBy(contributions, (c) => c.value, 'max');
      break;
    case 'AND':
    case 'MIN':
      winners = pickBy(contributions, (c) => c.value, 'min');
      break;
    case 'SEVERITY': {
      const top = pickBy(contributions, (c) => severityRank(c.ragStatusCode, c.lifeSafety), 'max');
      winners = pickBy(top, (c) => c.value, 'max');
      break;
    }
    case 'MEAN': {
      // Floating-point addition is not associative, so a parallel MEAN would not
      // be order-independent. The canonical order makes it deterministic; the
      // sum is serial within a cell, and cells stay independent.
      const ordered = [...contributions].sort((a, b) =>
        (a.originId + (a.cesId ?? '') + (a.outputVectorId ?? '')).localeCompare(
          b.originId + (b.cesId ?? '') + (b.outputVectorId ?? ''),
        ),
      );
      const mean = ordered.reduce((s, c) => s + c.value, 0) / ordered.length;
      return {
        value: mean,
        record: { instant, cell, rule, resolved: mean, contributors: ordered, suppressed: [] },
      };
    }
    default: {
      // PRECEDENCE — rank by determinism class, not provider identity. A
      // deterministic contribution is derivable from the corpus and IS(k)
      // alone; a generated one is not derivable from anything, and letting the
      // irreproducible term win makes IS(k+1) irreproducible too.
      const ranks = entry?.providerRanks ?? {};
      const rankOf = (c: Contribution) => ranks[c.provider] ?? CLASS_RANK[determinismOf(c.provider)];
      const atTop = pickBy(contributions, rankOf, 'max');
      switch (entry?.withinRank) {
        case 'SEVERITY': {
          const top = pickBy(atTop, (c) => severityRank(c.ragStatusCode, c.lifeSafety), 'max');
          winners = pickBy(top, (c) => c.value, 'max');
          break;
        }
        case 'MIN':
        case 'AND':
          winners = pickBy(atTop, (c) => c.value, 'min');
          break;
        // §4.3a default when withinRank is absent
        default:
          winners = pickBy(atTop, (c) => c.value, 'max');
      }
    }
  }

  const resolved = winners[0].value;
  const winnerSet = new Set(winners);
  return {
    value: resolved,
    record: {
      instant,
      cell,
      rule,
      resolved,
      contributors: contributions,
      suppressed: contributions.filter((c) => !winnerSet.has(c)),
    },
  };
}

/**
 * Resolve a whole instant.
 *
 * Cells never interact, so this shards by cell and the shard count cannot change
 * the result — acceptance criterion 3. `Promise.all` over shards buys concurrency
 * but not parallelism on Node's single loop; the contract points at
 * worker_threads for large contended sets, and the shape here keeps that a
 * drop-in change because each shard is already an independent pure reduction.
 */
export function resolveAll(
  byCell: Map<number, Contribution[]>,
  instant: number,
  lookup: (cell: number) => RegistryEntry | undefined,
): { values: Map<number, number>; records: ArbitrationRecord[] } {
  const values = new Map<number, number>();
  const records: ArbitrationRecord[] = [];
  for (const [cell, cs] of byCell) {
    const { value, record } = resolveCell(cell, instant, cs, lookup(cell));
    values.set(cell, value);
    if (record) records.push(record);
  }
  return { values, records };
}
