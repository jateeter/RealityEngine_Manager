/**
 * SourceMapper — resolveCompletion contract tests.
 *
 * Mirrors the wire contract of `RealityEngine_CPP::ingest_completion`
 * (see src/perception_engine_server.cpp).  Each test maps to one row of
 * the Phase 1 acceptance criteria in docs/INTEGRATION_ROADMAP.md.
 */

import { describe, it, expect } from '@jest/globals';

import { emptyRegistryState, loadRegistry } from '../integrations/Registry.js';
import {
  resolveCompletion,
  substituteSensorIdTemplate,
  sourceIdPart,
} from '../integrations/SourceMapper.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function registryWith(mapping: object): ReturnType<typeof loadRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'sm-test-'));
  const path = join(dir, 'r.json');
  writeFileSync(path, JSON.stringify({
    integrations: [],
    sourceMappings: [mapping],
  }), 'utf8');
  const state = loadRegistry(path);
  rmSync(dir, { recursive: true, force: true });
  return state;
}

// ── helpers ──────────────────────────────────────────────────────────────

describe('sourceIdPart', () => {
  it('replaces unsafe chars with underscores and trims edges', () => {
    expect(sourceIdPart('hello world!')).toBe('hello_world');
    expect(sourceIdPart('  ::weird/id::  ')).toBe('weird_id');
    expect(sourceIdPart('agent.42-name_v1')).toBe('agent.42-name_v1');
    expect(sourceIdPart(undefined)).toBe('');
  });
});

describe('substituteSensorIdTemplate', () => {
  it('substitutes the four standard tokens', () => {
    expect(
      substituteSensorIdTemplate('agent.{provider}.{agent}.{correlationId}.{envelopeId}.x', {
        provider: 'openai', agent: 'risk', correlationId: 'corr_1', envelopeId: 'env_2',
      }),
    ).toBe('agent.openai.risk.corr_1.env_2.x');
  });
});

// ── resolveCompletion: error paths ───────────────────────────────────────

describe('resolveCompletion — error paths', () => {
  it('rejects a non-object body', () => {
    const r = resolveCompletion('not an object' as any, emptyRegistryState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/JSON object/i);
    }
  });

  it('returns 404 with the C++-shaped message for an unknown sourceMappingId', () => {
    const r = resolveCompletion(
      { sourceMappingId: 'does-not-exist', values: [1] },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toBe('Unknown sourceMappingId "does-not-exist"');
    }
  });

  it('honours the legacy alias `mappingId`', () => {
    const r = resolveCompletion(
      { mappingId: 'still-missing', values: [1] },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Unknown sourceMappingId "still-missing"');
  });

  it('rejects a request with no values', () => {
    const r = resolveCompletion({} as any, emptyRegistryState());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

// ── resolveCompletion: resolution semantics ──────────────────────────────

describe('resolveCompletion — resolution semantics', () => {
  it('uses body.sensorId when present (highest precedence)', () => {
    const reg = registryWith({
      id: 'm1',
      sensorId: 'mapping.sensor',
      sensorIdTemplate: 'agent.{agent}.x',
      region: { offset: 10, length: 4 },
      ttlMs: 1000,
    });
    const r = resolveCompletion(
      { sourceMappingId: 'm1', sensorId: 'explicit.sensor', agent: 'risk', values: [1, 2, 3, 4] },
      reg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.sensorId).toBe('explicit.sensor');
  });

  it('falls back to mapping.sensorId when body.sensorId is absent', () => {
    const reg = registryWith({ id: 'm', sensorId: 'mapping.sensor' });
    const r = resolveCompletion(
      { sourceMappingId: 'm', values: [1] },
      reg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.sensorId).toBe('mapping.sensor');
  });

  it('substitutes sensorIdTemplate tokens when no sensorId is set', () => {
    const reg = registryWith({
      id: 'agent-completion-risk',
      sensorIdTemplate: 'agent.{provider}.{agent}.{correlationId}.completion',
    });
    const r = resolveCompletion(
      {
        sourceMappingId: 'agent-completion-risk',
        provider: 'openai', agent: 'risk', correlationId: 'corr_1', envelopeId: 'env_2',
        values: [1, 0, 0.82, 0],
      },
      reg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.sensorId).toBe('agent.openai.risk.corr_1.completion');
  });

  it('defaults to agent.<agent>.completion when nothing else resolves', () => {
    const r = resolveCompletion(
      { agent: 'risk', values: [1, 2] },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.sensorId).toBe('agent.risk.completion');
  });

  it('agentId is an accepted alias for agent', () => {
    const r = resolveCompletion(
      { agentId: 'paging', values: [1] },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.sensorId).toBe('agent.paging.completion');
      expect(r.ctx.agent).toBe('paging');
    }
  });

  it('id is an accepted alias for completionId', () => {
    const r = resolveCompletion(
      { id: 'cmpl_123', values: [1] },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ctx.completionId).toBe('cmpl_123');
  });

  it('merges inline sourceMapping over the registry mapping (inline wins per key)', () => {
    const reg = registryWith({
      id: 'm',
      sensorId: 'from-registry',
      region: { offset: 0, length: 2 },
      ttlMs: 1000,
    });
    const r = resolveCompletion(
      {
        sourceMappingId: 'm',
        sourceMapping: { region: { offset: 4200, length: 4 }, ttlMs: 99 },
        values: [1, 0, 0.82, 0],
      },
      reg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.sensorId).toBe('from-registry'); // inline didn't override sensorId
      expect(r.signal.region).toEqual({ offset: 4200, length: 4 });
      expect(r.signal.ttlMs).toBe(99);
    }
  });

  it('body.region overrides mapping.region', () => {
    const reg = registryWith({ id: 'm', sensorId: 's', region: { offset: 0, length: 1 } });
    const r = resolveCompletion(
      { sourceMappingId: 'm', region: { offset: 42, length: 8 }, values: [1] },
      reg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.region).toEqual({ offset: 42, length: 8 });
  });
});

// ── resolveCompletion: defaults & context ─────────────────────────────────

describe('resolveCompletion — defaults & context', () => {
  it('applies C++-matching defaults', () => {
    const r = resolveCompletion(
      { values: [1] },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.ttlMs).toBe(300_000);
      expect(r.signal.triggerPush).toBe(false);   // commit-only
      expect(r.signal.compactPush).toBe(true);
      expect(r.signal.active).toBe(true);
      expect(r.ctx.provider).toBe('external');
      expect(r.ctx.agent).toBe('agent');
    }
  });

  it('preserves metadata pass-through on the context', () => {
    const r = resolveCompletion(
      { values: [1], metadata: { reason: 'unit-test' } },
      emptyRegistryState(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ctx.metadata).toEqual({ reason: 'unit-test' });
  });

  it('matches the Phase-1 acceptance example end-to-end', () => {
    // Mirrors the curl example from §Completion Ingest of INTEGRATION_ARCHITECTURE.md.
    const reg = registryWith({
      id: 'agent-completion-risk',
      sensorIdTemplate: 'agent.{agent}.completion',
      region: { offset: 4200, length: 4 },
      ttlMs: 300_000,
    });
    const r = resolveCompletion(
      {
        provider: 'openai',
        agent: 'paging-decision',
        correlationId: 'corr_123',
        envelopeId: 'env_456',
        sourceMappingId: 'agent-completion-risk',
        values: [1, 0, 0.82, 0],
        ttlMs: 300_000,
        triggerPush: false,
      },
      reg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.sensorId).toBe('agent.paging-decision.completion');
      expect(r.signal.region).toEqual({ offset: 4200, length: 4 });
      expect(r.signal.values).toEqual([1, 0, 0.82, 0]);
      expect(r.signal.ttlMs).toBe(300_000);
      expect(r.signal.triggerPush).toBe(false);
      expect(r.ctx.sourceMappingId).toBe('agent-completion-risk');
      expect(r.ctx.correlationId).toBe('corr_123');
      expect(r.ctx.envelopeId).toBe('env_456');
    }
  });
});
