/**
 * Dispatch Ledger — contract tests.
 *
 * Mirrors `RealityEngine_CPP::dispatch_ledger` + `update_dispatch_record`
 * (src/perception_engine_server.cpp).  Each test maps to one acceptance
 * criterion in docs/INTEGRATION_ROADMAP.md §Phase 3.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEFAULT_CAPACITY, Ledger } from '../dispatch/Ledger.js';
import type { DispatchRecord } from '../dispatch/types.js';
import type { TriggerEnvelope } from '../triggers/types.js';

const NOW = 1_700_000_000_000;

function envelope(envelopeId: string): TriggerEnvelope {
  return {
    schemaVersion: '1.0.0',
    envelopeType: 'ces.terminal.event',
    envelopeId,
    correlationId: 'corr-' + envelopeId,
    emittedAtMs: NOW,
    source: { engine: 'PE', observedEngine: 'RE', endpoint: 'http://reality:3001' },
    ces: {
      machineId: 'm-1', machineName: 'M1', machineCode: 'M001',
      sequenceId: 's-1', sequenceName: 's-1', outputIndex: 0, stepNumber: 0,
      perceptualMapping: { output: { offset: 0, length: 2 } },
      provenance: [], deprecation: null,
    },
    outputVector: { values: [1, 0], encoding: 'vector', semantics: [], assertedLabel: 'cell_0' },
    projection: null, governance: null,
    dispatch: {
      agent: 'agent_x', action: '', agentActionsCatalog: [], trigger: 't',
      endpoint: { kind: 'dry-run', url: '', mutation: '', schemaRef: '' },
    },
  };
}

function record(id: string, overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id,
    envelopeId: `env-${id}`,
    correlationId: `corr-${id}`,
    status: 'recorded',
    mode: 'dry-run',
    target: 'agent_x',
    machineId: 'm-1',
    sequenceId: 's-1',
    ragStatusCode: 'RED',
    processStatus: 'error',
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    providerReceipt: null,
    envelope: envelope(`env-${id}`),
    ...overrides,
  };
}

let workDir: string;
beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 're-ledger-test-')));
});
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

// ── append / list / get ─────────────────────────────────────────────────

describe('Ledger — append/list/get', () => {
  it('preserves insertion order and lookups by id', () => {
    const l = new Ledger();
    l.append(record('a'));
    l.append(record('b'));
    l.append(record('c'));
    expect(l.size()).toBe(3);
    expect(l.list().map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(l.get('b')?.id).toBe('b');
    expect(l.get('nope')).toBeUndefined();
  });

  it('default capacity is 256 with FIFO eviction', () => {
    const l = new Ledger();
    for (let i = 0; i < 260; i++) l.append(record(String(i)));
    expect(l.size()).toBe(DEFAULT_CAPACITY);
    const ids = l.list().map((r) => r.id);
    expect(ids[0]).toBe('4');
    expect(ids.at(-1)).toBe('259');
  });

  it('honours an explicit capacity override', () => {
    const l = new Ledger({ capacity: 3 });
    l.append(record('a'));
    l.append(record('b'));
    l.append(record('c'));
    l.append(record('d'));
    expect(l.list().map((r) => r.id)).toEqual(['b', 'c', 'd']);
  });
});

// ── update (PATCH semantics) ────────────────────────────────────────────

describe('Ledger.update — wire-compatible with C++ update_dispatch_record', () => {
  it('returns undefined for unknown ids', () => {
    const l = new Ledger();
    expect(l.update('nope', { status: 'sent' })).toBeUndefined();
  });

  it('sets status / error / attempts and bumps updatedAt', () => {
    let clock = NOW;
    const l = new Ledger({ now: () => ++clock });
    l.append(record('a'));
    const updated = l.update('a', { status: 'sent', error: 'transient', attempts: 3 });
    expect(updated?.status).toBe('sent');
    expect(updated?.error).toBe('transient');
    expect(updated?.attempts).toBe(3);
    expect(updated?.updatedAt).toBeGreaterThan(NOW);
  });

  it('clearError empties the error field', () => {
    const l = new Ledger();
    l.append(record('a', { error: 'boom' }));
    const updated = l.update('a', { clearError: true });
    expect(updated?.error).toBe('');
  });

  it('incrementAttempts bumps when no explicit attempts given', () => {
    const l = new Ledger();
    l.append(record('a', { attempts: 4 }));
    const updated = l.update('a', { incrementAttempts: true });
    expect(updated?.attempts).toBe(5);
  });

  it('explicit attempts wins over incrementAttempts', () => {
    const l = new Ledger();
    l.append(record('a', { attempts: 4 }));
    const updated = l.update('a', { attempts: 9, incrementAttempts: true });
    expect(updated?.attempts).toBe(9);
  });

  it('merges providerReceipt and folds provider/adapter/externalRunId into it', () => {
    const l = new Ledger();
    l.append(record('a', { providerReceipt: { foo: 1 } }));
    const updated = l.update('a', {
      providerReceipt: { bar: 2 },
      provider: 'openai',
      adapter: 'responses-api',
      externalRunId: 'run_42',
    });
    expect(updated?.providerReceipt).toEqual({
      foo: 1, bar: 2,
      provider: 'openai', adapter: 'responses-api', externalRunId: 'run_42',
    });
  });

  it('silently ignores unknown / forbidden fields (envelope is immutable)', () => {
    const l = new Ledger();
    l.append(record('a'));
    const beforeEnv = l.get('a')!.envelope;
    const updated = l.update('a', {
      // @ts-expect-error — intentionally forbidden
      envelope: { schemaVersion: 'attack' },
      // @ts-expect-error
      machineId: 'attacker',
      status: 'sent',
    });
    expect(updated?.status).toBe('sent');
    expect(updated?.envelope).toEqual(beforeEnv);
    expect(updated?.machineId).toBe('m-1');
  });
});

// ── toUpdatedEvent ──────────────────────────────────────────────────────

describe('Ledger.toUpdatedEvent', () => {
  it('returns the C++-shaped WS payload', () => {
    const l = new Ledger({ now: () => NOW + 1 });
    l.append(record('a'));
    const updated = l.update('a', { status: 'sent', incrementAttempts: true })!;
    expect(l.toUpdatedEvent(updated)).toEqual({
      type: 'dispatch.record.updated',
      dispatchId: 'a',
      status: 'sent',
      target: 'agent_x',
      attempts: 1,
      timestamp: NOW + 1,
    });
  });
});

// ── persistence ─────────────────────────────────────────────────────────

describe('Ledger — JSONL persistence', () => {
  it('appends one line per mutation', () => {
    const path = join(workDir, 'ledger.jsonl');
    const l = new Ledger({ persistencePath: path });
    l.append(record('a'));
    l.update('a', { status: 'sent' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const last = JSON.parse(lines[1]!) as DispatchRecord;
    expect(last.id).toBe('a');
    expect(last.status).toBe('sent');
  });

  it('replays the file on construction, last-write-wins per id', () => {
    const path = join(workDir, 'ledger.jsonl');
    const l1 = new Ledger({ persistencePath: path });
    l1.append(record('a'));
    l1.append(record('b'));
    l1.update('a', { status: 'sent' });

    const l2 = new Ledger({ persistencePath: path });
    expect(l2.size()).toBe(2);
    expect(l2.get('a')?.status).toBe('sent');   // PATCH replayed
    expect(l2.get('b')?.status).toBe('recorded');
  });

  it('skips malformed lines on replay', () => {
    const path = join(workDir, 'ledger.jsonl');
    writeFileSync(path, [
      JSON.stringify(record('a')),
      '{ not json',
      '',
      JSON.stringify(record('b')),
    ].join('\n'), 'utf8');
    const l = new Ledger({ persistencePath: path });
    expect(l.list().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('trims replayed content to capacity', () => {
    const path = join(workDir, 'ledger.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(JSON.stringify(record(String(i))));
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    const l = new Ledger({ persistencePath: path });
    expect(l.size()).toBe(DEFAULT_CAPACITY);
    expect(l.list()[0]!.id).toBe('44');   // 300 - 256
  });
});
