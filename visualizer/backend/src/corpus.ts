/**
 * corpus — machine-corpus catalog + domain-scoped load orchestration
 * (Manager#31).
 *
 * Scans the catalog root (MACHINES_CATALOG_DIR, else MACHINES_DIR, else
 * ../RealityEngine_Machines/machines) plus any extra source roots into a
 * selection tree with three root branches:
 *
 *   core/<category>     — machines/core/*.json grouped by metadata.category
 *   domains/<name>      — machines/domains/<name>/*.json (one node per dir)
 *   corpus/<category>   — root *.json grouped by metadata.category
 *
 * The catalog is what CAN be loaded: the full corpus, whatever bounded subset
 * the engines booted with (Manager#256). Extra roots (localAIStack's own
 * data/machines) contribute their top-level files to corpus/<category>, where
 * a bounded working corpus has always placed them.
 *
 * Every corpus machine carries metadata.category (verified across the full
 * 1150-file corpus), so grouping uses that authoritative field — no
 * heuristic classification. Loading POSTs each file's raw body to the
 * active RE's /api/machines, the same contract seed-machines.sh exercises
 * against all three engines.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface CorpusMachine {
  id: string;
  name: string;
  file: string;       // absolute path — never sent to clients
  relFile: string;    // path relative to MACHINES_DIR — client-safe
  category: string;
  nodeKey: string;    // tree node this machine belongs to
}

export interface CorpusTreeNode {
  key: string;
  label: string;
  count: number;
  machines: Array<{ id: string; name: string; relFile: string }>;
  children?: CorpusTreeNode[];
}

export interface CorpusScan {
  machinesDir: string;
  extraDirs: string[];
  scannedAt: number;
  totalMachines: number;
  machines: CorpusMachine[];
  tree: CorpusTreeNode[];
}

const SCAN_TTL_MS = 30_000;
let cache: CorpusScan | null = null;

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => {
      try { return statSync(join(dir, f)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

function readMachineEntry(file: string, machinesDir: string, nodeKeyPrefix: string): CorpusMachine | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const m = j.machine ?? j;
    const meta = m.metadata ?? {};
    const category = String(meta.category ?? meta.domain ?? 'uncategorized').toLowerCase();
    return {
      id: String(m.id ?? ''),
      name: String(m.name ?? ''),
      file,
      relFile: file.slice(machinesDir.length + 1),
      category,
      nodeKey: `${nodeKeyPrefix}/${category}`,
    };
  } catch {
    return null;
  }
}

function groupByCategory(
  entries: CorpusMachine[],
  branchKey: string,
  branchLabel: string,
): CorpusTreeNode | null {
  if (entries.length === 0) return null;
  const byCat = new Map<string, CorpusMachine[]>();
  for (const e of entries) {
    const list = byCat.get(e.category) ?? [];
    list.push(e);
    byCat.set(e.category, list);
  }
  const children: CorpusTreeNode[] = [...byCat.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, list]) => ({
      key: `${branchKey}/${cat}`,
      label: cat,
      count: list.length,
      machines: list
        .map(m => ({ id: m.id, name: m.name, relFile: m.relFile }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  return {
    key: branchKey,
    label: branchLabel,
    count: entries.length,
    machines: [],
    children,
  };
}

export function scanCorpus(
  machinesDir: string,
  force = false,
  extraDirs: string[] = [],
): CorpusScan {
  // Accept either convention: the machines/ directory itself, or the
  // RealityEngine_Machines repo root (startUniverse exports MACHINES_DIR as
  // the repo root) — descend into machines/ when it exists.
  let dir = resolve(machinesDir);
  try {
    if (statSync(join(dir, 'machines')).isDirectory()) dir = join(dir, 'machines');
  } catch { /* already the machines directory */ }
  const extras = extraDirs.map(d => resolve(d)).filter(d => d !== dir);
  if (!force && cache && cache.machinesDir === dir
      && cache.extraDirs.join('\0') === extras.join('\0')
      && Date.now() - cache.scannedAt < SCAN_TTL_MS) {
    return cache;
  }

  const machines: CorpusMachine[] = [];
  const tree: CorpusTreeNode[] = [];

  // core/<category>
  const coreEntries = listJsonFiles(join(dir, 'core'))
    .map(f => readMachineEntry(f, dir, 'core'))
    .filter((e): e is CorpusMachine => e !== null);
  machines.push(...coreEntries);
  const coreNode = groupByCategory(coreEntries, 'core', 'Core');
  if (coreNode) tree.push(coreNode);

  // domains/<name> — one node per subdirectory, no category split
  const domainDirs = listSubdirs(join(dir, 'domains'));
  if (domainDirs.length > 0) {
    const children: CorpusTreeNode[] = [];
    for (const d of domainDirs.sort()) {
      const entries = listJsonFiles(join(dir, 'domains', d))
        .map(f => readMachineEntry(f, dir, `domains/${d}`))
        .filter((e): e is CorpusMachine => e !== null)
        // domain dir wins over per-file category for node membership
        .map(e => ({ ...e, nodeKey: `domains/${d}` }));
      if (entries.length === 0) continue;
      machines.push(...entries);
      children.push({
        key: `domains/${d}`,
        label: d,
        count: entries.length,
        machines: entries
          .map(m => ({ id: m.id, name: m.name, relFile: m.relFile }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    if (children.length > 0) {
      tree.push({
        key: 'domains',
        label: 'Domains',
        count: children.reduce((n, c) => n + c.count, 0),
        machines: [],
        children,
      });
    }
  }

  // corpus/<category> — root-level files, then each extra root's. A name the
  // corpus already holds is not offered twice: corpus filenames are globally
  // unique, and an extra root restating one would load the same machine again.
  const rootEntries = listJsonFiles(dir)
    .map(f => readMachineEntry(f, dir, 'corpus'))
    .filter((e): e is CorpusMachine => e !== null);
  const seen = new Set(machines.concat(rootEntries).map(m => m.relFile.split('/').pop()));
  for (const extra of extras) {
    for (const e of listJsonFiles(extra)
      .map(f => readMachineEntry(f, extra, 'corpus'))
      .filter((e): e is CorpusMachine => e !== null)) {
      if (seen.has(e.relFile)) continue;
      seen.add(e.relFile);
      rootEntries.push(e);
    }
  }
  machines.push(...rootEntries);
  const rootNode = groupByCategory(rootEntries, 'corpus', 'Corpus');
  if (rootNode) tree.push(rootNode);

  cache = {
    machinesDir: dir,
    extraDirs: extras,
    scannedAt: Date.now(),
    totalMachines: machines.length,
    machines,
    tree,
  };
  return cache;
}

/**
 * Resolve a load selection to concrete machines. `nodeKeys` select whole
 * tree nodes by key prefix ('core', 'corpus/agriculture', 'domains/energy');
 * `machineIds` select individual machines by id. Deduplicated by file.
 */
export function resolveSelection(
  scan: CorpusScan,
  nodeKeys: string[] = [],
  machineIds: string[] = [],
): CorpusMachine[] {
  const wantedIds = new Set(machineIds);
  const picked = new Map<string, CorpusMachine>();
  for (const m of scan.machines) {
    const nodeMatch = nodeKeys.some(k => m.nodeKey === k || m.nodeKey.startsWith(`${k}/`));
    // corpus files usually carry no id — accept name as the selection key too
    if (nodeMatch || wantedIds.has(m.id) || wantedIds.has(m.name)) picked.set(m.file, m);
  }
  return [...picked.values()];
}

export interface LoadResultRecord {
  id: string;
  relFile: string;
  status: 'loaded' | 'skipped' | 'failed';
  error?: string;
  // The id the engine holds the machine under: minted or declared at ingest
  // for a loaded machine, the resident one's for a skipped machine. Absent
  // when the engine did not say. Ids are per runtime, so this is not a
  // cross-engine identity; it is what the paired PE's bootstrap filters on.
  engineId?: string;
}

/**
 * POST each selected machine's raw file body to the active RE — the
 * seed-machines.sh contract. Corpus files carry no machine id (engines
 * assign one at import), so presence is matched by machine NAME against
 * `existingKeys` (which should contain both engine ids and names).
 * Skipped unless `replace` is set. Concurrency-limited.
 *
 * When `existingKeys` is a Map (key -> engine id) a skipped machine records
 * the resident machine's `engineId`; `postMachine` may resolve to the id the
 * engine ingested the machine under, which a loaded machine records.
 */
export async function loadMachines(
  selection: CorpusMachine[],
  existingKeys: ReadonlySet<string> | ReadonlyMap<string, string>,
  postMachine: (rawBody: string) => Promise<string | void>,
  replace = false,
  concurrency = 8,
): Promise<LoadResultRecord[]> {
  const results: LoadResultRecord[] = [];
  const queue = [...selection];

  async function worker(): Promise<void> {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const identity = m.id || m.name;
      // Presence is decided by the corpus `name`, which every runtime keeps,
      // never by `id`: ids are minted per runtime (SURFACE_SPEC "Machines are
      // compared by what they produce"), so C++ and Scala report a minted id even
      // for a machine whose file declares one, and an id check missed it there
      // and posted it again, which the engine versions as "<name> v2" while LSP,
      // keeping the declared id, skipped it. Only a machine with no name falls
      // back to its id.
      const presenceKey = m.name || m.id;
      if (!replace && presenceKey && existingKeys.has(presenceKey)) {
        const engineId = existingKeys instanceof Map ? existingKeys.get(presenceKey) : undefined;
        results.push({ id: identity, relFile: m.relFile, status: 'skipped', ...(engineId ? { engineId } : {}) });
        continue;
      }
      try {
        const raw = readFileSync(m.file, 'utf8');
        const engineId = await postMachine(raw);
        results.push({ id: identity, relFile: m.relFile, status: 'loaded', ...(engineId ? { engineId } : {}) });
      } catch (e: any) {
        results.push({
          id: identity,
          relFile: m.relFile,
          status: 'failed',
          error: String(e?.response?.status ?? e?.message ?? e).slice(0, 200),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, selection.length) }, worker));
  return results;
}

/**
 * The engine ids whose test sequences a load should intern on the paired PE
 * (RealityEngine_Manager#304): every machine the load placed or found
 * resident, never one that failed. A skipped machine is included because
 * being resident on the RE says nothing about its sources on the PE, and the
 * bootstrap is idempotent per machine.
 *
 * Null when a placed machine has no engine id — the engine did not say what
 * it ingested — so the caller interns unfiltered rather than miss it.
 */
export function internableEngineIds(results: ReadonlyArray<LoadResultRecord>): string[] | null {
  const ids = new Set<string>();
  for (const r of results) {
    if (r.status === 'failed') continue;
    if (!r.engineId) return null;
    ids.add(r.engineId);
  }
  return [...ids];
}
