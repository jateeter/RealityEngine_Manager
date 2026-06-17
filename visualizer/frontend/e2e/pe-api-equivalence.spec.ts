import { test, expect } from '@playwright/test';

/**
 * PE API byte-equivalence tests.
 *
 * Asserts that every PE-facing endpoint returns structurally identical JSON
 * (same keys, same value types at every nesting level) regardless of which
 * engine runtime is active.  Tests fail and show the exact schema diff when
 * any runtime diverges from the others.
 *
 * Endpoints covered:
 *   GET  /api/pe/state
 *   POST /api/pe/sources/bootstrap-from-machines
 *   POST /api/pe/push
 *
 * Expected canonical schema is derived from the TypeScript PEFullState,
 * PEBootstrapResult, and PEPushResult interfaces in types.ts.
 *
 * These tests run serially because engine-switching is global backend state.
 */

// ── Schema extraction ─────────────────────────────────────────────────────────

type Schema = string | Schema[] | { [k: string]: Schema };

/**
 * Recursively extract the structural schema of a JSON value:
 *   null             → 'null'
 *   boolean          → 'boolean'
 *   number           → 'number'
 *   string           → 'string'
 *   []               → []
 *   [v, ...]         → [schema(v)]   (only first element; type assumed uniform)
 *   { k: v, … }     → { k: schema(v), … }  (keys sorted for stable comparison)
 */
function extractSchema(value: unknown): Schema {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length > 0 ? [extractSchema(value[0])] : [];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, extractSchema(v)])
    );
  }
  return typeof value;
}

function schemaStr(s: Schema): string {
  return JSON.stringify(s, null, 2);
}

// ── Engine roster ─────────────────────────────────────────────────────────────

const ENGINES = [
  { id: 'lsp-1',   runtime: 'lsp'   },
  { id: 'scala-1', runtime: 'scala' },
  { id: 'cpp-1',   runtime: 'cpp'   },
] as const;

// ── Canonical schemas (from TypeScript interfaces in types.ts) ────────────────

/**
 * PEFullState — expected shape after bootstrap (sources non-empty).
 * Field names and nesting must match the frontend's TypeScript type exactly.
 *
 * Divergences currently known:
 *   LSP   emits "dimension"  instead of "vectorSize"
 *   CPP   emits "vectorSize" ✓ but also emits extra source fields
 *                              "metadata" and "sequence"
 *   Scala emits neither "dimension" nor "vectorSize"
 */
const CANONICAL_PE_STATE: Schema = {
  assembledVector: ['number'],
  auto: { intervalMs: 'number', running: 'boolean' },
  globalStep: 'number',
  lastPush: 'null',
  matchAlgorithm: 'string',
  sources: [{
    active: 'boolean',
    id: 'string',
    inputs: [['number']],
    loop: 'boolean',
    machineId: 'string',
    machineName: 'string',
    name: 'string',
    region: { length: 'number', offset: 'number' },
    sequenceName: 'string',
    type: 'string',
  }],
  vectorSize: 'number',
};

/**
 * PEBootstrapResult — expected shape from bootstrap-from-machines.
 *
 * Divergences currently known:
 *   Scala returns { success, sources[] } — missing created/skipped/machinesSeen/errors/vectorSize
 *   CPP   returns { created, sources[] } — missing skipped/machinesSeen/errors/vectorSize/success
 *   LSP   returns { created, skipped, machinesSeen, errors[], vectorSize } — missing sources[]
 */
const CANONICAL_BOOTSTRAP: Schema = {
  created: 'number',
  errors: ['string'],
  machinesSeen: 'number',
  skipped: 'number',
  vectorSize: 'number',
};

/**
 * PEPushResult — expected shape from POST /api/pe/push.
 *
 * Divergences currently known:
 *   CPP   returns step: null
 *   Scala has extra top-level "id" field; step is missing several LSP keys
 *   LSP   step has extra keys: eventBus, inputVector, perceptualSpaceIsDebugProjection, success
 *         mergeBatch entries use "values" where Scala uses "vector"
 */
const CANONICAL_PUSH: Schema = {
  globalStep: 'number',
  step: {
    activeRegions: [],
    machineResults: [],
    mergeBatch: [{
      machineId: 'string',
      region: { length: 'number', offset: 'number' },
      vector: ['number'],
    }],
    perceptualSpace: ['number'],
    stepNumber: 'number',
    timestamp: 'number',
  },
  success: 'boolean',
  timestamp: 'number',
};

// ── Helper: switch active engine and return the engine ID ─────────────────────

async function switchEngine(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  id: string
): Promise<void> {
  const res = await request.post('/api/engines/active', {
    data: { id },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.ok(), `engine switch to ${id} failed: ${res.status()}`).toBeTruthy();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test.describe('PE API byte-equivalence', () => {

  // ── 1. GET /api/pe/state ───────────────────────────────────────────────────
  test('GET /api/pe/state — schema is byte-equivalent across lsp, scala, and cpp', async ({ request }) => {
    const schemas: Record<string, Schema> = {};

    for (const { id, runtime } of ENGINES) {
      await switchEngine(request, id);

      // Bootstrap so sources[] is non-empty, giving a meaningful schema for elements.
      await request.post('/api/pe/sources/bootstrap-from-machines', {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await request.get('/api/pe/state');
      expect(res.ok(), `[${runtime}] GET /api/pe/state returned ${res.status()}`).toBeTruthy();

      const body: unknown = await res.json();
      schemas[runtime] = extractSchema(body);
    }

    // ── Assert each engine matches the canonical schema ──
    for (const { runtime } of ENGINES) {
      expect(
        schemaStr(schemas[runtime]),
        `[${runtime}] /api/pe/state schema diverges from canonical PEFullState:\n` +
        `  actual:   ${schemaStr(schemas[runtime])}\n` +
        `  expected: ${schemaStr(CANONICAL_PE_STATE)}`
      ).toBe(schemaStr(CANONICAL_PE_STATE));
    }

    // ── Assert cross-engine equivalence (lsp = scala = cpp) ──
    expect(
      schemaStr(schemas['scala']),
      'scala /api/pe/state schema diverges from lsp:\n' +
      `  lsp:   ${schemaStr(schemas['lsp'])}\n` +
      `  scala: ${schemaStr(schemas['scala'])}`
    ).toBe(schemaStr(schemas['lsp']));

    expect(
      schemaStr(schemas['cpp']),
      'cpp /api/pe/state schema diverges from lsp:\n' +
      `  lsp: ${schemaStr(schemas['lsp'])}\n` +
      `  cpp: ${schemaStr(schemas['cpp'])}`
    ).toBe(schemaStr(schemas['lsp']));
  });

  // ── 2. POST /api/pe/sources/bootstrap-from-machines ───────────────────────
  test('POST /api/pe/sources/bootstrap-from-machines — result schema is byte-equivalent across lsp, scala, and cpp', async ({ request }) => {
    const schemas: Record<string, Schema> = {};

    for (const { id, runtime } of ENGINES) {
      await switchEngine(request, id);

      // Reset so bootstrap has something to create.
      await request.post('/api/pe/reset', {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await request.post('/api/pe/sources/bootstrap-from-machines', {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.ok(), `[${runtime}] bootstrap returned ${res.status()}`).toBeTruthy();

      const body: unknown = await res.json();
      schemas[runtime] = extractSchema(body);
    }

    // ── Assert each engine matches the canonical schema ──
    for (const { runtime } of ENGINES) {
      expect(
        schemaStr(schemas[runtime]),
        `[${runtime}] bootstrap schema diverges from canonical PEBootstrapResult:\n` +
        `  actual:   ${schemaStr(schemas[runtime])}\n` +
        `  expected: ${schemaStr(CANONICAL_BOOTSTRAP)}`
      ).toBe(schemaStr(CANONICAL_BOOTSTRAP));
    }

    // ── Cross-engine equivalence ──
    expect(
      schemaStr(schemas['scala']),
      'scala bootstrap schema diverges from lsp:\n' +
      `  lsp:   ${schemaStr(schemas['lsp'])}\n` +
      `  scala: ${schemaStr(schemas['scala'])}`
    ).toBe(schemaStr(schemas['lsp']));

    expect(
      schemaStr(schemas['cpp']),
      'cpp bootstrap schema diverges from lsp:\n' +
      `  lsp: ${schemaStr(schemas['lsp'])}\n` +
      `  cpp: ${schemaStr(schemas['cpp'])}`
    ).toBe(schemaStr(schemas['lsp']));
  });

  // ── 3. POST /api/pe/push ──────────────────────────────────────────────────
  test('POST /api/pe/push — result schema is byte-equivalent across lsp, scala, and cpp', async ({ request }) => {
    const schemas: Record<string, Schema> = {};

    for (const { id, runtime } of ENGINES) {
      await switchEngine(request, id);

      // Ensure sources exist so push produces a non-empty step.
      await request.post('/api/pe/sources/bootstrap-from-machines', {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await request.post('/api/pe/push', {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.ok(), `[${runtime}] push returned ${res.status()}`).toBeTruthy();

      const body: unknown = await res.json();
      schemas[runtime] = extractSchema(body);
    }

    // ── Assert each engine matches the canonical schema ──
    for (const { runtime } of ENGINES) {
      expect(
        schemaStr(schemas[runtime]),
        `[${runtime}] push schema diverges from canonical PEPushResult:\n` +
        `  actual:   ${schemaStr(schemas[runtime])}\n` +
        `  expected: ${schemaStr(CANONICAL_PUSH)}`
      ).toBe(schemaStr(CANONICAL_PUSH));
    }

    // ── Cross-engine equivalence ──
    expect(
      schemaStr(schemas['scala']),
      'scala push schema diverges from lsp:\n' +
      `  lsp:   ${schemaStr(schemas['lsp'])}\n` +
      `  scala: ${schemaStr(schemas['scala'])}`
    ).toBe(schemaStr(schemas['lsp']));

    expect(
      schemaStr(schemas['cpp']),
      'cpp push schema diverges from lsp:\n' +
      `  lsp: ${schemaStr(schemas['lsp'])}\n` +
      `  cpp: ${schemaStr(schemas['cpp'])}`
    ).toBe(schemaStr(schemas['lsp']));
  });
});
