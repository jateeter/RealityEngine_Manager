// K-line analysis (RealityEngine_Manager#372): the panel's histograms, computed
// over records — the engine's live store or the archive — and never by driving
// an engine (owner, 2026-11-27: a re-run recomputes over records). Pure
// functions, so a re-run over the same records gives the same result.

export type Counts = Record<string, number>;

export interface KlineAnalysis {
  klines: number;
  commits: [number, number] | null;
  /** completed, abandoned, subsumed, interrupted/<reason> */
  byOutcome: Counts;
  byMachine: Record<string, Counts>;
  bySequence: Record<string, Counts>;
  /** K-lines closed at each step, keyed by close.step */
  closedPerStep: Counts;
  /** path length (events) -> K-lines */
  pathLengths: Counts;
  /** abandoned K-lines by |value - threshold| at the failing element, in 0.1 bins */
  nearMiss: Counts;
  nearMissNoThreshold: number;
}

export interface CompositionAnalysis {
  records: number;
  commits: [number, number] | null;
  taxonomy: string[];
  /** input cells won per kind/provider/class, summed over records */
  cellsByEntry: Counts;
  /** records whose sources include each kind/provider/class */
  recordsByEntry: Counts;
  causedByRecords: number;
}

const bump = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
const range = (xs: number[]): [number, number] | null => xs.length ? [Math.min(...xs), Math.max(...xs)] : null;

export function outcomeLabel(k: any): string {
  return k?.outcome === 'interrupted' && k?.reason ? `interrupted/${k.reason}` : String(k?.outcome ?? 'unknown');
}

/** The near-miss bin of an abandoned K-line: |value - threshold| in steps of 0.1, capped at 1.0+. */
export function nearMissBin(difference: any): string | null {
  if (!difference || typeof difference.value !== 'number' || typeof difference.threshold !== 'number') return null;
  const d = Math.abs(difference.value - difference.threshold);
  if (d >= 1) return '1.0+';
  const lo = Math.floor(d * 10) / 10;
  return `${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`;
}

export function analyzeKlines(records: any[]): KlineAnalysis {
  const out: KlineAnalysis = {
    klines: 0, commits: null, byOutcome: {}, byMachine: {}, bySequence: {}, closedPerStep: {},
    pathLengths: {}, nearMiss: {}, nearMissNoThreshold: 0,
  };
  const commits: number[] = [];
  for (const k of records) {
    if (k?.format !== 're-kline/1') continue;
    out.klines++;
    const label = outcomeLabel(k);
    const machine = String(k.focal?.machine ?? '');
    const sequence = `${machine}/${k.focal?.sequence ?? ''}`;
    bump(out.byOutcome, label);
    bump((out.byMachine[machine] ??= {}), label);
    bump((out.bySequence[sequence] ??= {}), label);
    if (typeof k.close?.step === 'number') bump(out.closedPerStep, String(k.close.step));
    bump(out.pathLengths, String(Array.isArray(k.path) ? k.path.length : 0));
    if (typeof k.close?.commit === 'number') commits.push(k.close.commit);
    if (k.outcome === 'abandoned') {
      const bin = nearMissBin(k.difference);
      if (bin) bump(out.nearMiss, bin); else out.nearMissNoThreshold++;
    }
  }
  out.commits = range(commits);
  return out;
}

export function analyzeCompositions(records: any[]): CompositionAnalysis {
  const out: CompositionAnalysis = { records: 0, commits: null, taxonomy: [], cellsByEntry: {}, recordsByEntry: {}, causedByRecords: 0 };
  const commits: number[] = [];
  const taxonomies = new Set<string>();
  for (const r of records) {
    if (r?.format !== 're-isre-composition/1') continue;
    out.records++;
    if (typeof r.taxonomy === 'string') taxonomies.add(r.taxonomy);
    if (typeof r.re?.commit === 'number') commits.push(r.re.commit);
    const seen = new Set<string>();
    let caused = false;
    for (const s of Array.isArray(r.sources) ? r.sources : []) {
      const entry = [s.kind, s.provider, s.class].filter(x => x !== undefined && x !== null).join('/');
      const [first, last] = Array.isArray(s.cells) ? s.cells : [0, -1];
      bump(out.cellsByEntry, entry, Math.max(0, last - first + 1));
      seen.add(entry);
      if (s.causedBy) caused = true;
    }
    seen.forEach(e => bump(out.recordsByEntry, e));
    if (caused) out.causedByRecords++;
  }
  out.commits = range(commits);
  out.taxonomy = [...taxonomies].sort();
  return out;
}

/** JSON with object keys sorted at every depth, for comparing values. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The voters' analyses side by side: which summary fields agree across them.
 * No member is the reference (QUORUM_CONTRACT): a field agrees only when every
 * voter that answered has the same value, and a voter that did not answer is
 * named, never counted as agreement. */
export function sideBySide(analyses: Record<string, KlineAnalysis | null>): { agree: string[]; differ: string[]; missing: string[] } {
  const present = Object.entries(analyses).filter(([, a]) => a !== null) as [string, KlineAnalysis][];
  const missing = Object.entries(analyses).filter(([, a]) => a === null).map(([id]) => id);
  const fields: (keyof KlineAnalysis)[] = ['klines', 'byOutcome', 'byMachine', 'closedPerStep', 'pathLengths', 'nearMiss'];
  const agree: string[] = [], differ: string[] = [];
  for (const f of fields) {
    const vals = new Set(present.map(([, a]) => canonical(a[f])));
    (present.length > 1 && vals.size === 1 ? agree : differ).push(f);
  }
  return { agree: missing.length ? [] : agree, differ: missing.length ? fields : differ, missing };
}
