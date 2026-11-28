// The K-line historical archive, written by Manager (RealityEngine_Manager#372;
// owner, 2026-11-27: Manager writes it itself). The same contract as
// RealityEngine_CI scripts/lib/kline_archive.py (SURFACE_SPEC "The historical
// archive"), so either writer continues where the other stopped:
//
//   root    $RE_KLINE_ARCHIVE_DIR, else $RE_INSTANCE_STATE_DIR/kline-archive,
//           else ~/.reality-engine/kline-archive
//   layout  <participant uuid>/klines/<first>-<last>-<sha8>.jsonl (re-kline-bundle/1)
//           <participant uuid>/isre/<first>-<last>-<sha8>.jsonl   (re-isre-bundle/1)
//           catalog.jsonl, one line per bundle, append-only
//
// A bundle is kept exactly as its engine exported it, written only after its
// header's sha256 matches its body, atomically, then read-only. Exports are
// incremental from the newest commit the catalog holds. The participant comes
// from its clock route, never from an export: an export marks the engine's
// segments exported, which lets its budget evict them.

import { createHash } from 'crypto';
import { appendFileSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { canonical } from './analysis.js';
import type { Http, Instance } from './panel.js';

export type Kind = 'klines' | 'isre';
export const KINDS: Record<Kind, { format: string; route: string; field: 'since' | 'from'; record: string;
  commitOf: (r: any) => number | undefined; clock: string; url: (i: Instance) => string | undefined }> = {
  klines: { format: 're-kline-bundle/1', route: '/api/klines/export', field: 'since', record: 're-kline/1',
            commitOf: r => r?.close?.commit, clock: '/api/engine/clock', url: i => i.re_url },
  isre: { format: 're-isre-bundle/1', route: '/api/isre-composition/export', field: 'from', record: 're-isre-composition/1',
          commitOf: r => r?.re?.commit, clock: '/api/clock', url: i => i.pe_url },
};

export interface CatalogEntry {
  kind: Kind; format: string; participant: string; instanceId: string; runtime: string;
  file: string; bytes: number; count: number; records: number; sha256: string;
  firstCommit: number; lastCommit: number; header: any; archivedAt: string;
}

export function archiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RE_KLINE_ARCHIVE_DIR) return env.RE_KLINE_ARCHIVE_DIR;
  return join(env.RE_INSTANCE_STATE_DIR || join(homedir(), '.reality-engine'), 'kline-archive');
}

export function readCatalog(root: string): CatalogEntry[] {
  const path = join(root, 'catalog.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export function cursor(entries: CatalogEntry[], participant: string, kind: Kind): number {
  const lasts = entries.filter(e => e.participant === participant && e.kind === kind).map(e => e.lastCommit);
  return lasts.length ? Math.max(...lasts) + 1 : 0;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** The header and body of a bundle whose sha256 and count check out, else throws. */
export function verifyBundle(text: string, format: string): { header: any; body: string } {
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error('a bundle has a header line and a body');
  const header = JSON.parse(text.slice(0, nl));
  const body = text.slice(nl + 1);
  if (header.format !== format) throw new Error(`expected ${format}, got ${JSON.stringify(header.format)}`);
  const digest = sha256Hex(body);
  if (header.sha256 !== digest) throw new Error(`sha256 ${header.sha256} does not match the body (${digest})`);
  const lines = body.split('\n').filter(l => l);
  if (header.count !== lines.length) throw new Error(`count ${header.count} but ${lines.length} lines`);
  return { header, body };
}

function writeSealed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, 0o444);
  renameSync(tmp, path);
}

function appendCatalog(root: string, entry: CatalogEntry): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'catalog.jsonl'), canonical(entry) + '\n');
}

export interface ArchiveResult { instance: string; kind: Kind; result: string; participant?: string;
  records?: number; commits?: [number, number]; file?: string; from?: number }

const pad = (n: number) => String(n).padStart(12, '0');

/** Export KIND from one instance from its cursor and archive it. */
export async function archiveOne(http: Http, root: string, entries: CatalogEntry[], inst: Instance, kind: Kind,
                                 now: () => Date = () => new Date()): Promise<ArchiveResult> {
  const spec = KINDS[kind];
  const base = spec.url(inst)?.replace(/\/+$/, '');
  const line: ArchiveResult = { instance: inst.id, kind, result: '' };
  if (!base) return { ...line, result: 'no-url' };
  const clock = await http.get(`${base}${spec.clock}`);
  const participant = String(clock.data?.instance ?? '').toLowerCase();
  if (clock.status !== 200 || !participant) return { ...line, result: 'the participant names no instance on its clock route' };
  const start = cursor(entries, participant, kind);
  const r = await http.postText(`${base}${spec.route}`, { [spec.field]: start });
  if (r.status === 404) return { ...line, participant, result: 'unsupported' };
  if (r.status !== 200) return { ...line, participant, result: `export ${r.status}` };
  const { header, body } = verifyBundle(r.text, spec.format);
  if (String(header.source?.instance ?? '').toLowerCase() !== participant) {
    throw new Error(`the bundle's source.instance is not ${participant}`);
  }
  const commits = body.split('\n').filter(l => l).map(l => JSON.parse(l))
    .filter(rec => rec.format === spec.record).map(spec.commitOf).filter((c): c is number => typeof c === 'number');
  if (!commits.length) return { ...line, participant, result: 'nothing new', from: start };
  const first = Math.min(...commits), last = Math.max(...commits);
  const file = join(participant, kind, `${pad(first)}-${pad(last)}-${header.sha256.slice(0, 8)}.jsonl`);
  writeSealed(join(root, file), r.text);
  const entry: CatalogEntry = {
    kind, format: spec.format, participant, instanceId: inst.id, runtime: inst.runtime,
    file, bytes: Buffer.byteLength(r.text, 'utf8'), count: header.count, records: commits.length,
    sha256: header.sha256, firstCommit: first, lastCommit: last, header,
    archivedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  appendCatalog(root, entry);
  entries.push(entry);
  return { ...line, participant, result: 'archived', records: commits.length, commits: [first, last], file };
}

/** The archived records of PARTICIPANT's KIND whose commit is in [from, to]. */
export function archivedRecords(root: string, participant: string, kind: Kind, from = 0, to = Number.MAX_SAFE_INTEGER): any[] {
  const spec = KINDS[kind];
  const out: any[] = [];
  for (const e of readCatalog(root)) {
    if (e.participant !== participant || e.kind !== kind || e.lastCommit < from || e.firstCommit > to) continue;
    const { body } = verifyBundle(readFileSync(join(root, e.file), 'utf8'), e.format);
    for (const l of body.split('\n')) {
      if (!l) continue;
      const rec = JSON.parse(l);
      const c = spec.commitOf(rec);
      if (rec.format !== spec.record || (typeof c === 'number' && c >= from && c <= to)) out.push(rec);
    }
  }
  return out;
}
