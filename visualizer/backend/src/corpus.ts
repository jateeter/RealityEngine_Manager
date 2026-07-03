/**
 * corpus — machine-corpus catalog + domain-scoped load orchestration
 * (Manager#31).
 *
 * Scans MACHINES_DIR (default ../RealityEngine_Machines/machines) into a
 * selection tree with three root branches:
 *
 *   core/<category>     — machines/core/*.json grouped by metadata.category
 *   domains/<name>      — machines/domains/<name>/*.json (one node per dir)
 *   corpus/<category>   — root *.json grouped by metadata.category
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

export function scanCorpus(machinesDir: string, force = false): CorpusScan {
  const dir = resolve(machinesDir);
  if (!force && cache && cache.machinesDir === dir && Date.now() - cache.scannedAt < SCAN_TTL_MS) {
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

  // corpus/<category> — root-level files
  const rootEntries = listJsonFiles(dir)
    .map(f => readMachineEntry(f, dir, 'corpus'))
    .filter((e): e is CorpusMachine => e !== null);
  machines.push(...rootEntries);
  const rootNode = groupByCategory(rootEntries, 'corpus', 'Corpus');
  if (rootNode) tree.push(rootNode);

  cache = {
    machinesDir: dir,
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
}

/**
 * POST each selected machine's raw file body to the active RE — the
 * seed-machines.sh contract. Corpus files carry no machine id (engines
 * assign one at import), so presence is matched by machine NAME against
 * `existingKeys` (which should contain both engine ids and names).
 * Skipped unless `replace` is set. Concurrency-limited.
 */
export async function loadMachines(
  selection: CorpusMachine[],
  existingKeys: Set<string>,
  postMachine: (rawBody: string) => Promise<void>,
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
      if (!replace && identity && existingKeys.has(identity)) {
        results.push({ id: identity, relFile: m.relFile, status: 'skipped' });
        continue;
      }
      try {
        const raw = readFileSync(m.file, 'utf8');
        await postMachine(raw);
        results.push({ id: identity, relFile: m.relFile, status: 'loaded' });
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
