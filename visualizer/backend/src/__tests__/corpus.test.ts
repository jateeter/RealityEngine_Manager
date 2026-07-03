/**
 * Unit tests for the corpus catalog + load orchestration (Manager#31).
 * Builds a throwaway fixture corpus on disk; no network.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanCorpus, resolveSelection, loadMachines } from '../corpus.js';

let dir: string;

function machineFile(path: string, name: string, category: string): void {
  writeFileSync(path, JSON.stringify({
    machine: { name, metadata: { category } },
    version: 1,
  }));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'corpus-test-'));
  machineFile(join(dir, 'A1.json'), 'Alpha One', 'agriculture');
  machineFile(join(dir, 'A2.json'), 'Alpha Two', 'agriculture');
  machineFile(join(dir, 'D1.json'), 'Delta One', 'data-center');
  mkdirSync(join(dir, 'domains', 'energy'), { recursive: true });
  machineFile(join(dir, 'domains', 'energy', 'E1.json'), 'Energy One', 'energy');
  mkdirSync(join(dir, 'core'));
  machineFile(join(dir, 'core', 'C1.json'), 'Core One', 'digital-logic');
  writeFileSync(join(dir, 'broken.json'), '{not json');
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('scanCorpus', () => {
  it('builds core/domains/corpus branches grouped by metadata.category', () => {
    const scan = scanCorpus(dir, true);
    expect(scan.totalMachines).toBe(5); // broken.json skipped
    const keys = scan.tree.map(t => t.key).sort();
    expect(keys).toEqual(['core', 'corpus', 'domains']);

    const corpus = scan.tree.find(t => t.key === 'corpus')!;
    expect(corpus.children!.map(c => c.key).sort())
      .toEqual(['corpus/agriculture', 'corpus/data-center']);
    expect(corpus.children!.find(c => c.key === 'corpus/agriculture')!.count).toBe(2);

    const domains = scan.tree.find(t => t.key === 'domains')!;
    expect(domains.children![0].key).toBe('domains/energy');
    expect(domains.children![0].machines[0].name).toBe('Energy One');
  });

  it('caches within TTL and honors force', () => {
    const a = scanCorpus(dir);
    const b = scanCorpus(dir);
    expect(b).toBe(a);
    const c = scanCorpus(dir, true);
    expect(c).not.toBe(a);
  });
});

describe('resolveSelection', () => {
  it('resolves node keys with prefix coverage and machine names', () => {
    const scan = scanCorpus(dir, true);
    const byNode = resolveSelection(scan, ['corpus/agriculture']);
    expect(byNode.map(m => m.name).sort()).toEqual(['Alpha One', 'Alpha Two']);

    const parent = resolveSelection(scan, ['domains']);
    expect(parent.map(m => m.name)).toEqual(['Energy One']);

    const byName = resolveSelection(scan, [], ['Delta One']);
    expect(byName.map(m => m.name)).toEqual(['Delta One']);

    const both = resolveSelection(scan, ['corpus/agriculture'], ['Alpha One']);
    expect(both).toHaveLength(2); // deduplicated by file
  });
});

describe('loadMachines', () => {
  it('posts unseen machines and skips existing ones by name', async () => {
    const scan = scanCorpus(dir, true);
    const selection = resolveSelection(scan, ['corpus/agriculture']);
    const posted: string[] = [];
    const results = await loadMachines(
      selection,
      new Set(['Alpha Two']),
      async raw => { posted.push(JSON.parse(raw).machine.name); },
    );
    expect(posted).toEqual(['Alpha One']);
    expect(results.find(r => r.id === 'Alpha Two')!.status).toBe('skipped');
    expect(results.find(r => r.id === 'Alpha One')!.status).toBe('loaded');
  });

  it('replace bypasses the presence check', async () => {
    const scan = scanCorpus(dir, true);
    const selection = resolveSelection(scan, [], ['Alpha Two']);
    const posted: string[] = [];
    const results = await loadMachines(
      selection, new Set(['Alpha Two']),
      async raw => { posted.push(JSON.parse(raw).machine.name); },
      true,
    );
    expect(posted).toEqual(['Alpha Two']);
    expect(results[0].status).toBe('loaded');
  });

  it('captures per-machine failures without aborting the batch', async () => {
    const scan = scanCorpus(dir, true);
    const selection = resolveSelection(scan, ['corpus']);
    const results = await loadMachines(
      selection, new Set(),
      async raw => {
        if (JSON.parse(raw).machine.name === 'Delta One') throw new Error('boom');
      },
    );
    expect(results.filter(r => r.status === 'loaded')).toHaveLength(2);
    const failed = results.find(r => r.status === 'failed')!;
    expect(failed.id).toBe('Delta One');
    expect(failed.error).toContain('boom');
  });
});
