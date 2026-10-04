import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PerceptionEngine, providerOf } from '../PerceptionEngine.js';
import { arbitrationRegistry } from '../ArbitrationRegistry.js';
import { determinismOf } from '../Arbiter.js';
import type { TestSourceConfig } from '../types.js';

/**
 * The fold on a declared cell (ARBITER_CONTRACT.md §4.4b, amended 2026-10-04,
 * RealityEngine_CI#525): the arbitration registry's rule governs, so under
 * PRECEDENCE {acp:1, machine:3} a machine at 0 beats an agent at 1 — the one
 * pair where T_M ('or' = max) would let the generated value win. Every fold is
 * recorded and counted; undeclared cells keep T_M.
 */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;

describe('the provider of a source', () => {
  it('is the first origin segment through the surface aliases', () => {
    expect(providerOf({ type: 'sensor', origin: 'acp.openclaw.target.assessment' })).toBe('acp');
    expect(providerOf({ type: 'sensor', origin: 'openclaw' })).toBe('acp');
    expect(providerOf({ type: 'sensor', origin: 'ollama' })).toBe('localai');
    expect(providerOf({ type: 'sensor', origin: 'localai.x-mcp-y' })).toBe('localai'); // never a substring
    expect(providerOf({ type: 'sensor', origin: 'mqtt' })).toBe('mqtt');
    expect(providerOf({ type: 'sensor' })).toBe('sensor');
    expect(providerOf({ type: 'test', origin: 'signal' })).toBe('synthetic');
    expect(determinismOf(providerOf({ type: 'sensor', origin: 'somesurface.x' }))).toBe('generated');
  });
});

describe('the Source-vs-OSRE fold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-fold-'));
  const declared = path.join(dir, 'declared.json');
  const empty = path.join(dir, 'empty.json');
  const saved = process.env.ARBITRATION_REGISTRY;

  beforeAll(() => {
    fs.writeFileSync(declared, JSON.stringify({ entries: [
      { cell: 50, rule: 'PRECEDENCE', providerRanks: { acp: 1, machine: 3 } },
      { cell: 52, rule: 'PRECEDENCE', providerRanks: { acp: 3, machine: 3 } },
      { cell: 53, rule: 'PRECEDENCE', providerRanks: { acp: 1, machine: 3 } },
    ] }));
    fs.writeFileSync(empty, JSON.stringify({ entries: [] }));
    process.env.ARBITRATION_REGISTRY = declared;
    arbitrationRegistry.load();
  });
  afterAll(() => {
    process.env.ARBITRATION_REGISTRY = empty;
    arbitrationRegistry.load();
    if (saved === undefined) delete process.env.ARBITRATION_REGISTRY;
    else process.env.ARBITRATION_REGISTRY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies a declared PRECEDENCE, keeps T_M elsewhere, and records every fold', () => {
    const engine = new PerceptionEngine(64);
    engine.updateFromPerceptualSpace(Array.from({ length: 64 }, (_, i) => (i === 51 ? 0.2 : 0)));
    engine.addSource({
      name: 'agent assessment', type: 'test', region: { offset: 50, length: 3 }, active: true,
      origin: 'acp.openclaw.target.assessment',
      machineId: 'm', machineName: 'm', sequenceName: 's', inputs: [[1, 1, 1]], loop: true,
    } as unknown as Omit<TestSourceConfig, 'id'>);
    // A seed the cell does not name, on declared cell 53: it keeps T_M.
    engine.addSource({
      name: 'unnamed seed', type: 'test', region: { offset: 53, length: 1 }, active: true,
      machineId: 'm', machineName: 'm', sequenceName: 's', inputs: [[1]], loop: true,
    } as unknown as Omit<TestSourceConfig, 'id'>);
    engine.setOsreFold(new Map([
      [50, { name: 'Peer', transformation: 'or' }],
      [51, { name: 'Peer', transformation: 'or' }],
      [52, { name: 'Peer', transformation: 'or' }],
      [53, { name: 'Peer', transformation: 'or' }],
    ]));
    const v = engine.assembleVector();
    expect(near(v[50]!, 0)).toBe(true); // PRECEDENCE: the machine's 0 beats the agent's 1 (5a)
    expect(near(v[51]!, 1)).toBe(true); // undeclared: T_M = max(1, 0.2)
    expect(near(v[52]!, 1)).toBe(true); // equal ranks fall back to T_M
    expect(near(v[53]!, 1)).toBe(true); // an unnamed provider keeps T_M on a declared cell

    engine.recordContention();
    const { folds, counters } = engine.getContention();
    expect(folds.map((f) => f.cell)).toEqual([50, 51, 52, 53]);
    expect(folds[3]).toMatchObject({ review: 'provider-unranked', source: { provider: 'synthetic' } });
    expect(folds[0]).toMatchObject({ resolution: 'declared-rule', rule: 'PRECEDENCE', kept: 'osre',
      osre: { machine: 'Peer', provider: 'machine' }, source: { provider: 'acp' } });
    expect(folds[1]).toMatchObject({ resolution: 'osre-fold', operator: 'or', kept: 'source' });
    expect(folds[2]).toMatchObject({ resolution: 'osre-fold', declaredRule: 'PRECEDENCE' });
    expect(counters[0]).toMatchObject({ contended: 1, suppressed: 1 });

    engine.assembleVector(); // a read assembles, but never records or counts
    expect(engine.getContention().counters[0]).toMatchObject({ contended: 1 });
    engine.reset();
    expect(engine.getContention().folds).toEqual([]);
  });
});
