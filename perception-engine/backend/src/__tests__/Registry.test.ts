/**
 * Integration Registry — loader + status contract tests.
 *
 * Covers Phase 0 of docs/INTEGRATION_ROADMAP.md.  Asserts wire compatibility
 * with the C++ `integration_status()` shape and the path / failure
 * resolution behaviour from `load_integration_registry()`.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  COMPLETION_ENDPOINT,
  emptyRegistryState,
  integrationStatus,
  loadRegistry,
  resolveRegistryPath,
} from '../integrations/Registry.js';

const here = resolve(fileURLToPath(import.meta.url), '..');
// resolve walks: __tests__ → src → backend → perception-engine → RealityEngine_Manager
const MANAGER_ROOT = resolve(here, '..', '..', '..', '..');
// The canonical integration-registry example is shipped by the CI orchestrator
// repo (RealityEngine_CI/config), a required sibling of RealityEngine_Manager —
// not by this repo. Resolve it there. The acceptance test below is skipped when
// the sibling is absent (e.g. an isolated Manager checkout) so it never
// false-fails; override with RE_INTEGRATIONS_EXAMPLE if it lives elsewhere.
const WORKSPACE_ROOT = resolve(MANAGER_ROOT, '..');
const EXAMPLE_REGISTRY =
  process.env.RE_INTEGRATIONS_EXAMPLE ??
  join(WORKSPACE_ROOT, 'RealityEngine_CI', 'config', 'integrations.example.json');

function writeJson(path: string, body: unknown): void {
  writeFileSync(path, JSON.stringify(body), 'utf8');
}

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  // realpath the temp dir so macOS `/var/folders/...` → `/private/var/folders/...`
  // comparisons match the path the loader echoes back from `resolveRegistryPath`.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 're-registry-test-')));
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

// ─── resolveRegistryPath ─────────────────────────────────────────────────

describe('resolveRegistryPath', () => {
  it('returns null when env is unset and no config/integrations.json exists', () => {
    process.chdir(workDir);
    expect(resolveRegistryPath(undefined)).toBeNull();
    expect(resolveRegistryPath('')).toBeNull();
  });

  it('falls back to config/integrations.json relative to CWD when present', () => {
    mkdirSync(join(workDir, 'config'));
    const expected = join(workDir, 'config', 'integrations.json');
    writeJson(expected, { integrations: [], sourceMappings: [] });
    process.chdir(workDir);
    expect(resolveRegistryPath(undefined)).toBe(expected);
  });

  it('honours an absolute INTEGRATIONS_CONFIG path verbatim', () => {
    const path = join(workDir, 'custom.json');
    writeJson(path, {});
    expect(resolveRegistryPath(path)).toBe(path);
  });

  it('resolves a relative INTEGRATIONS_CONFIG against CWD', () => {
    process.chdir(workDir);
    writeJson(join(workDir, 'r.json'), {});
    expect(resolveRegistryPath('r.json')).toBe(join(workDir, 'r.json'));
  });
});

// ─── loadRegistry ────────────────────────────────────────────────────────

describe('loadRegistry', () => {
  it('returns the empty state when path is null/undefined', () => {
    const s = loadRegistry(null);
    expect(s).toEqual(emptyRegistryState());
    expect(loadRegistry(undefined)).toEqual(emptyRegistryState());
  });

  it('loads a valid registry and indexes sourceMappings by id', () => {
    const path = join(workDir, 'r.json');
    writeJson(path, {
      version: '1.0',
      integrations: [
        { id: 'a', kind: 'mqtt', enabled: true },
        { id: 'b', kind: 'openai', enabled: false },
      ],
      sourceMappings: [
        { id: 'm1', sensorId: 's1', region: { offset: 10, length: 4 }, ttlMs: 1000 },
        { id: 'm2', sensorIdTemplate: 'agent.{agent}.x', ttlMs: 2000 },
        { id: '', sensorId: 'should-skip' }, // empty id is dropped
      ],
    });

    const s = loadRegistry(path);
    expect(s.loaded).toBe(true);
    expect(s.path).toBe(path);
    expect(s.error).toBeNull();
    expect(s.sourceMappingIndex.size).toBe(2);
    expect(s.sourceMappingIndex.get('m1')?.sensorId).toBe('s1');
    expect(s.sourceMappingIndex.get('m2')?.sensorIdTemplate).toBe('agent.{agent}.x');
  });

  it('reports an error and keeps loaded:false on malformed JSON', () => {
    const path = join(workDir, 'bad.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    const s = loadRegistry(path);
    expect(s.loaded).toBe(false);
    expect(s.path).toBe(path);
    expect(s.error).toBeTruthy();
    expect(s.sourceMappingIndex.size).toBe(0);
  });

  it('reports an error when the file does not exist', () => {
    const path = join(workDir, 'missing.json');
    const s = loadRegistry(path);
    expect(s.loaded).toBe(false);
    expect(s.path).toBe(path);
    expect(s.error).toBeTruthy();
  });

  it('rejects a JSON file whose top level is not an object', () => {
    const path = join(workDir, 'arr.json');
    writeJson(path, [1, 2, 3]);
    const s = loadRegistry(path);
    expect(s.loaded).toBe(false);
    expect(s.error).toMatch(/must be a JSON object/i);
  });
});

// ─── integrationStatus (wire shape) ──────────────────────────────────────

describe('integrationStatus — wire shape', () => {
  it('returns the C++-compatible empty body when no registry is loaded', () => {
    const body = integrationStatus(emptyRegistryState());
    expect(body).toEqual({
      loaded: false,
      path: null,
      error: null,
      integrationCount: 0,
      sourceMappingCount: 0,
      integrations: [],
      sourceMappings: [],
      completionEndpoint: COMPLETION_ENDPOINT,
    });
  });

  it('mirrors integrations exactly with three keys per entry', () => {
    const path = join(workDir, 'r.json');
    writeJson(path, {
      integrations: [
        { id: 'a', kind: 'mqtt', enabled: true, extra: 'kept-in-config-not-status' },
        { id: 'b', kind: 'openai' }, // enabled defaults to false
      ],
      sourceMappings: [],
    });
    const body = integrationStatus(loadRegistry(path));
    expect(body.integrationCount).toBe(2);
    expect(body.integrations).toEqual([
      { id: 'a', kind: 'mqtt', enabled: true },
      { id: 'b', kind: 'openai', enabled: false },
    ]);
  });

  it('normalises source-mapping rows: missing region/ttlMs become null, missing strings become ""', () => {
    const path = join(workDir, 'r.json');
    writeJson(path, {
      integrations: [],
      sourceMappings: [
        { id: 'full', sensorId: 's', sensorIdTemplate: 't', region: { offset: 1, length: 2 }, ttlMs: 9 },
        { id: 'sparse' },
      ],
    });
    const body = integrationStatus(loadRegistry(path));
    expect(body.sourceMappingCount).toBe(2);
    const sparse = body.sourceMappings.find((m) => m.id === 'sparse')!;
    expect(sparse.sensorId).toBe('');
    expect(sparse.sensorIdTemplate).toBe('');
    expect(sparse.region).toBeNull();
    expect(sparse.ttlMs).toBeNull();
    const full = body.sourceMappings.find((m) => m.id === 'full')!;
    expect(full.region).toEqual({ offset: 1, length: 2 });
    expect(full.ttlMs).toBe(9);
  });

  it('surfaces loader errors on the status body', () => {
    const path = join(workDir, 'bad.json');
    writeFileSync(path, 'not json', 'utf8');
    const body = integrationStatus(loadRegistry(path));
    expect(body.loaded).toBe(false);
    expect(body.path).toBe(path);
    expect(body.error).toBeTruthy();
    expect(body.integrationCount).toBe(0);
    expect(body.sourceMappingCount).toBe(0);
  });

  // Runs against the canonical example shipped in the CI sibling repo; skipped
  // (not failed) when that sibling is not checked out alongside this repo.
  const exampleIt = existsSync(EXAMPLE_REGISTRY) ? it : it.skip;
  exampleIt('matches the acceptance criterion against the shipped example registry', () => {
    // The CI orchestrator ships `config/integrations.example.json` per Phase 0 acceptance.
    // Asserts the architecture-doc mapping is present + shaped correctly,
    // and the integration set covers the five provider kinds the roadmap
    // calls out — without pinning the exact mapping/integration counts so
    // a future example update doesn't break this test.
    const body = integrationStatus(loadRegistry(EXAMPLE_REGISTRY));
    expect(body.loaded).toBe(true);
    expect(body.path).toBe(EXAMPLE_REGISTRY);
    expect(body.error).toBeNull();
    expect(body.completionEndpoint).toBe('/api/integrations/completions');
    expect(body.integrationCount).toBeGreaterThanOrEqual(5);
    expect(body.sourceMappingCount).toBeGreaterThanOrEqual(1);
    const kinds = new Set(body.integrations.map((i) => i.kind));
    for (const k of ['acp', 'healthkit', 'localai', 'mqtt', 'ollama', 'openai']) {
      expect(kinds.has(k)).toBe(true);
    }
    const archDocMapping = body.sourceMappings.find((m) => m.id === 'agent-completion-risk');
    expect(archDocMapping).toBeDefined();
    expect(archDocMapping?.region).toEqual({ offset: 4200, length: 4 });
    expect(archDocMapping?.sensorIdTemplate).toBe('agent.{agent}.completion');
    const acpMapping = body.sourceMappings.find((m) => m.id === 'acp-openclaw-completion');
    expect(acpMapping).toBeDefined();
    expect(acpMapping?.region).toEqual({ offset: 4210, length: 4 });
    expect(acpMapping?.sensorIdTemplate).toBe('acp.openclaw.{agent}.completion');
  });
});
