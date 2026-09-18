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

/**
 * Serialise a schema for comparison, with object keys sorted.
 *
 * Sorting here rather than only in `extractSchema` because both sides of every
 * comparison pass through this function, and only one of them came from
 * `extractSchema`. The CANONICAL_* constants are hand-written literals, and
 * `JSON.stringify` preserves their declaration order — so a canonical whose
 * fields happen not to be in alphabetical order failed against a sorted actual
 * with an identical key set, reporting a divergence that did not exist.
 *
 * `CANONICAL_PE_STATE` did exactly that: it declares `perceptionDimension`
 * after `sources`, the runtimes sort it before, and the diff was two identical
 * schemas in different orders.
 */
function schemaStr(s: Schema): string {
  const sorted = (v: Schema): Schema => {
    if (Array.isArray(v)) return v.map(sorted);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sorted(x)])
    );
  };
  return JSON.stringify(sorted(s), null, 2);
}

// ── The observable boundary ───────────────────────────────────────────────────

/**
 * Keys a runtime may carry that its peers need not, filtered before comparison
 * rather than reported as divergence.
 *
 * SURFACE_SPEC.md, "The observable boundary": internal augmentation is
 * permitted and is not divergence, and when it reaches the observable interface
 * the correct handling is to **filter it there** — not to require every other
 * runtime to implement it. `valuesPacked` (RealityEngine_CI#208) was very nearly
 * "fixed" by implementing base64 bit-packing in a third runtime, byte-for-byte
 * across three languages, to satisfy a field no consumer reads.
 *
 * **RealityEngine_CI is the authority for this list**, in
 * `scripts/regression-pe-step-contract.py::BOUNDARY_FILTERED`. This is a second
 * copy, and a second copy of a contract is the duplication problem this project
 * keeps meeting — so it is small, it names its master, and adding a key here is
 * a decision that belongs in SURFACE_SPEC's "Already-settled instances" first.
 */
const BOUNDARY_FILTERED: Record<string, ReadonlySet<string>> = {
  // cpp emits `dispatch`; scala emits a top-level `id` which is engine-local
  // identity in any case. Both named by parity_identity.shape_only_keys as
  // reported-never-compared.
  'push.response': new Set(['dispatch', 'id']),
  // Emitted by LSP and C++ under `compact`, absent on Scala, consumed by
  // nothing, and derivable from `values` plus the machine's `bitsPerElement`.
  'push.step.mergeBatch[]': new Set(['valuesPacked']),
  // Measured 2026-09-17 against cpp-1 + lsp-1 + scala-1: all three PE sources
  // carry `metadata` (holding `segments`) and an always-empty `sequence`. The
  // TypeScript PE declares `segments` as a top-level source field and no
  // frontend reads either one, so this is augmentation that reaches the
  // boundary rather than contract. Filed as a contract question; filtered here
  // so it is named and auditable rather than failing this gate anonymously.
  'state.sources[]': new Set(['metadata', 'sequence']),
};

/** Drop the filtered keys at one probe point, leaving the comparison to the rest. */
function applyBoundary(schema: Schema, probe: string): Schema {
  const filtered = BOUNDARY_FILTERED[probe];
  if (!filtered || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([k]) => !filtered.has(k))
  );
}

/**
 * A key whose value is `null` is not an observation.
 *
 * C++ and Scala carry `error: null` on a success response where LSP omits the
 * key. All three are reporting the same absence of an error, and treating that
 * as a schema divergence would fail every success path at once.
 */
function dropNulls(schema: Schema): Schema {
  if (Array.isArray(schema)) return schema.map(dropNulls);
  if (typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([, v]) => v !== 'null')
      .map(([k, v]) => [k, dropNulls(v)])
  );
}

/**
 * Report every engine's divergence, not the first.
 *
 * The per-engine assertions used to run in a loop that threw on the first
 * failure, so a property every runtime shared was reported under one runtime's
 * name — `[lsp] /api/pe/state schema diverges from canonical`. RealityEngine_Manager#151
 * read that as an engine-specific contract divergence and proposed splitting it
 * out for its own triage. It was universal: all three emitted the same two
 * extra fields. One engine's name on a universal finding sends the next reader
 * to the wrong runtime.
 */
function expectAllConform(
  engines: EngineRef[],
  schemas: Record<string, Schema>,
  canonical: Schema,
  surface: string,
): void {
  const diverged = engines
    .map(({ runtime }) => ({ runtime, actual: schemaStr(schemas[runtime]) }))
    .filter(({ actual }) => actual !== schemaStr(canonical));
  expect(
    diverged.map(d => d.runtime),
    `${surface} diverges from the canonical schema on ` +
    `${diverged.length} of ${engines.length} runtimes ` +
    `(${diverged.length === engines.length ? 'ALL — this is a canonical-schema ' +
      'question, not an engine defect' : 'a subset — this is an engine difference'}):\n` +
    diverged.map(d => `  [${d.runtime}] ${d.actual}`).join('\n') +
    `\n  expected: ${schemaStr(canonical)}`,
  ).toEqual([]);
}

// ── Engine roster ─────────────────────────────────────────────────────────────

type EngineRef = { id: string; runtime: string };

/** The three runtimes this comparison is about. */
const REQUIRED_RUNTIMES = ['lsp', 'scala', 'cpp'] as const;

/**
 * The roster, resolved from the registry rather than hardcoded.
 *
 * This was a literal `[{id:'lsp-1'},{id:'scala-1'},{id:'cpp-1'}]`. Instance ids
 * are a property of how a universe was launched, not of the contract: a
 * single-engine deployment registers one instance called `default`, so
 * `switchEngine` asked the Manager for `lsp-1`, got a correct 404, and the
 * suite failed in setup — **before comparing a single byte**.
 *
 * That is worse than a red test. The failure was reported under the name
 * "GET /api/pe/state — schema is byte-equivalent across lsp, scala, and cpp",
 * so a reader scanning the gate saw a cross-engine schema divergence that had
 * never been checked. The test claimed coverage it did not have, and its truth
 * was unknown in both directions (RealityEngine_Manager#119).
 *
 * Now: ask the registry what it holds. If the three runtimes are not all
 * present, skip with a *declared reason* naming what was found — the
 * participation-state discipline from RealityEngine_CI/SURFACE_SPEC.md, where
 * `not-configured` is a conforming answer and silence is not.
 */
async function resolveRoster(
  request: Parameters<Parameters<typeof test>[1]>[0]['request']
): Promise<EngineRef[]> {
  const res = await request.get('/api/engines');
  expect(res.ok(), `GET /api/engines returned ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const instances: Array<Record<string, unknown>> = body.instances ?? [];

  const roster: EngineRef[] = [];
  for (const rt of REQUIRED_RUNTIMES) {
    const hit = instances.find(i => String(i.runtime ?? '').toLowerCase() === rt);
    if (hit) roster.push({ id: String(hit.id), runtime: rt });
  }

  const found = instances.map(i => `${i.id}:${i.runtime}`).join(', ') || '<none>';
  test.skip(
    roster.length < REQUIRED_RUNTIMES.length,
    `needs all of [${REQUIRED_RUNTIMES.join(', ')}]; registry holds [${found}]. ` +
    `not-configured: this universe is not multi-engine, so cross-runtime ` +
    `byte-equivalence cannot be evaluated — it is not being asserted either.`
  );
  return roster;
}

// ── Canonical schemas (from TypeScript interfaces in types.ts) ────────────────

/**
 * PEFullState — expected shape after bootstrap (sources non-empty).
 * Field names and nesting must match the frontend's TypeScript type exactly.
 *
 * The perceptual dimension is named "perceptionDimension" in every runtime.
 * It previously had three different names for the same value — CPP and the
 * TypeScript PE said "vectorSize", LSP said "dimension", Scala said
 * "perceptionDimension" — which made GET /api/state impossible to compare
 * byte-for-byte even once the values agreed (RealityEngine_CI#91).
 *
 * Divergences currently known: none between runtimes.
 *
 * This comment used to read "CPP emits extra source fields metadata and
 * sequence". Measured 2026-09-17 against a live cpp-1 + lsp-1 + scala-1
 * universe, `GET /api/state` is **identical on all three** — 26 schema paths,
 * zero divergent — and all three carry those two fields, not just CPP. They are
 * filtered as boundary augmentation above rather than listed here as a per-
 * runtime quirk, because a "known divergence" that every runtime shares is not
 * a divergence.
 */
const CANONICAL_PE_STATE: Schema = {
  assembledVector: ['number'],
  auto: { intervalMs: 'number', running: 'boolean' },
  globalStep: 'number',
  // `null` describes a PE that has not been pushed to, which is the state a
  // freshly-started universe is in — so this field's post-push shape has never
  // been asserted here, and a real divergence hid behind that.
  //
  // Measured 2026-09-17 after a push: cpp and scala report a timestamp, LSP
  // reports the entire last step object. Same route, same field, two
  // incompatible types. Filed as RealityEngine_CI#407, which has to settle
  // which shape is the contract before this line can assert it.
  //
  // **Settled**: `lastPush` is the last step object, carrying its own
  // `timestamp`, and `null` before any push. SURFACE_SPEC declares it under
  // "`lastPush` is the last step, not when it happened", and CPP and Scala are
  // being moved onto LSP's shape.
  //
  // Still asserted as `'null'` here, because this test reads state without
  // pushing first — so `null` is the conforming value at this point in the run,
  // and asserting the post-push shape would assert something that has not
  // happened yet. The step's shape is checked by the push test below, at
  // declared probe points, which is the only place it can be compared without
  // the comparison tripping over engine-scoped machine ids.
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
  perceptionDimension: 'number',
};

/**
 * PEBootstrapResult — expected shape from bootstrap-from-machines.
 *
 * Divergences currently known: none between runtimes.
 *
 * The three lines that used to sit here — Scala missing five keys, CPP missing
 * five others, LSP missing `sources[]` — were all stale. Measured 2026-09-17,
 * every runtime returns exactly
 * `{created, errors, machinesSeen, skipped, success}`.
 *
 * Two corrections to the canonical itself, both of which would otherwise fail
 * this gate on all three runtimes at once:
 *   `success`     every runtime emits it; it was absent here
 *   `vectorSize`  NO runtime emits it; it was required here. A canonical field
 *                 that no implementation has ever produced is not a contract
 *                 nobody honours — it is a line nobody checked.
 */
const CANONICAL_BOOTSTRAP: Schema = {
  created: 'number',
  // `[]`, not `['string']`. A successful bootstrap reports no errors, so the
  // element type is not observable here — `extractSchema` yields `[]` for an
  // empty array, and a canonical of `['string']` could therefore only match a
  // run in which the bootstrap had failed. Asserting a shape that requires the
  // failure path to be taken is a gate that is green only when something is
  // wrong.
  errors: [],
  machinesSeen: 'number',
  skipped: 'number',
  success: 'boolean',
};

/**
 * PEPushResult — expected shape from POST /api/pe/push.
 *
 * Divergences currently known, measured 2026-09-17 against a live
 * cpp-1 + lsp-1 + scala-1 universe:
 *
 *   `step` is IDENTICAL on all three — same eight keys, and `mergeBatch`
 *   entries carry the same six. So is the content: 698 merge entries, 2036
 *   active regions and 1338 machine results on every runtime.
 *
 *   Only the top level differs, and only by the keys the boundary already
 *   settles: cpp adds `dispatch`, scala adds `id`, and cpp and scala carry
 *   `error: null` where LSP omits the key. Filtered and null-dropped above.
 *
 * Every line the old comment carried was wrong by now: CPP does not return
 * `step: null`, Scala's step is not missing keys, and `mergeBatch` uses
 * `values` on all three rather than `values` on LSP and `vector` on Scala.
 * The canonical below said `vector` and omitted four fields every runtime
 * emits — it could not have matched any of them.
 */
const CANONICAL_PUSH: Schema = {
  globalStep: 'number',
  step: {
    activeRegions: [],
    eventBus: [],
    machineResults: [],
    mergeBatch: [{
      governance: 'null',
      machineId: 'string',
      provenance: 'string',
      region: { length: 'number', offset: 'number' },
      sequenceIds: ['string'],
      values: ['number'],
    }],
    perceptualSpace: ['number'],
    perceptualSpaceIsDebugProjection: 'boolean',
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
    const ENGINES = await resolveRoster(request);
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
      const raw = extractSchema(body) as { [k: string]: Schema };
      // Boundary augmentation is set aside before comparison, and the sources[]
      // element is the probe point that carries it here.
      const sources = Array.isArray(raw.sources) && raw.sources.length > 0
        ? [applyBoundary(raw.sources[0], 'state.sources[]')]
        : raw.sources;
      schemas[runtime] = { ...raw, sources };
    }

    // ── 1. The runtimes agree with each other ──
    //
    // Asserted FIRST, because it is the property this test is named for and the
    // one a reader acts on. It used to run last, after a per-engine canonical
    // check that threw on the first runtime — so cross-engine equivalence was
    // never actually reached, and a canonical mismatch every runtime shared was
    // reported as `[lsp] …` (RealityEngine_Manager#151).
    const distinct = new Set(ENGINES.map(({ runtime }) => schemaStr(schemas[runtime])));
    expect(
      distinct.size,
      '/api/pe/state is not byte-equivalent across the runtimes:\n' +
      ENGINES.map(({ runtime }) => `  [${runtime}] ${schemaStr(schemas[runtime])}`).join('\n'),
    ).toBe(1);

    // ── 2. And they agree with the canonical schema ──
    expectAllConform(ENGINES, schemas, CANONICAL_PE_STATE, 'GET /api/pe/state');
  });

  // ── 2. POST /api/pe/sources/bootstrap-from-machines ───────────────────────
  test('POST /api/pe/sources/bootstrap-from-machines — result schema is byte-equivalent across lsp, scala, and cpp', async ({ request }) => {
    const ENGINES = await resolveRoster(request);
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

    // ── 1. The runtimes agree with each other ──
    const distinct = new Set(ENGINES.map(({ runtime }) => schemaStr(schemas[runtime])));
    expect(
      distinct.size,
      'bootstrap result is not byte-equivalent across the runtimes:\n' +
      ENGINES.map(({ runtime }) => `  [${runtime}] ${schemaStr(schemas[runtime])}`).join('\n'),
    ).toBe(1);

    // ── 2. And they agree with the canonical schema ──
    expectAllConform(ENGINES, schemas, CANONICAL_BOOTSTRAP,
                     'POST /api/pe/sources/bootstrap-from-machines');
  });

  // ── 3. POST /api/pe/push ──────────────────────────────────────────────────
  test('POST /api/pe/push — result schema is byte-equivalent across lsp, scala, and cpp', async ({ request }) => {
    const ENGINES = await resolveRoster(request);
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
      // The response carries the two settled augmentation keys (cpp's
      // `dispatch`, scala's `id`) and, on cpp and scala, `error: null` where
      // LSP omits it. Both are set aside here; `mergeBatch` entries are
      // filtered at their own probe point for `valuesPacked`, which appears
      // only under `compact`.
      const raw = dropNulls(applyBoundary(extractSchema(body), 'push.response')) as
        { [k: string]: Schema };
      const step = raw.step as { [k: string]: Schema } | undefined;
      const mergeBatch = step && Array.isArray(step.mergeBatch) && step.mergeBatch.length > 0
        ? [applyBoundary(step.mergeBatch[0], 'push.step.mergeBatch[]')]
        : step?.mergeBatch;
      schemas[runtime] = step ? { ...raw, step: { ...step, mergeBatch } } : raw;
    }

    // ── Compared at declared probe points, not as whole documents ──
    //
    // A deep comparison of this response cannot work, and the reason is a
    // contract rule rather than an implementation detail: `step.machineResults`
    // is an object **keyed by machine id**, and ids are minted per runtime —
    // the same corpus machine is `machine-1789687061048-341051310` on cpp and
    // `machine-1U4PI1H-506GF8UC6O3K` on lsp. Extracting a schema from it yields
    // 1338 engine-scoped ids as if they were field names, so no two runtimes
    // can ever match (RealityEngine_CI#397; SURFACE_SPEC, "Byte equivalence
    // applies"). `sequenceResults` nests the same problem one level deeper,
    // keyed by sequence name, and which machines fired varies by run.
    //
    // So this compares the key set at each probe point, which is what
    // RealityEngine_CI's `regression-pe-step-contract.py` settled on after the
    // same discovery — and it probes three levels rather than one, because
    // reading only `step` is how #208 regressed after being closed (#231).
    const probe = (runtime: string, path: 'response' | 'step' | 'mergeBatch'): string[] => {
      const s = schemas[runtime] as { [k: string]: Schema };
      const step = s?.step as { [k: string]: Schema } | undefined;
      const node =
        path === 'response' ? s :
        path === 'step' ? step :
        (Array.isArray(step?.mergeBatch) ? step?.mergeBatch[0] : undefined);
      return node && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node).sort() : [];
    };

    for (const path of ['response', 'step', 'mergeBatch'] as const) {
      const byRuntime = Object.fromEntries(
        ENGINES.map(({ runtime }) => [runtime, probe(runtime, path)]));
      const distinct = new Set(Object.values(byRuntime).map(k => JSON.stringify(k)));
      expect(
        distinct.size,
        `POST /api/pe/push — ${path} key set differs across the runtimes:\n` +
        Object.entries(byRuntime).map(([r, k]) => `  [${r}] ${JSON.stringify(k)}`).join('\n'),
      ).toBe(1);
      expect(byRuntime[ENGINES[0].runtime].length,
             `POST /api/pe/push — ${path} reported no keys on any runtime, which is a ` +
             `probe that measured nothing rather than a response with no fields`)
        .toBeGreaterThan(0);
    }

    // The canonical is still checked at the top level and on `step`, where the
    // shape is id-free and a declared contract is meaningful.
    for (const path of ['response', 'step'] as const) {
      const expected = path === 'response'
        ? Object.keys(CANONICAL_PUSH as object).sort()
        : Object.keys((CANONICAL_PUSH as { step: object }).step).sort();
      const diverged = ENGINES
        .map(({ runtime }) => ({ runtime, keys: probe(runtime, path) }))
        .filter(({ keys }) => JSON.stringify(keys) !== JSON.stringify(expected));
      expect(
        diverged.map(d => d.runtime),
        `POST /api/pe/push — ${path} diverges from the canonical key set on ` +
        `${diverged.length} of ${ENGINES.length} runtimes:\n` +
        diverged.map(d => `  [${d.runtime}] ${JSON.stringify(d.keys)}`).join('\n') +
        `\n  expected: ${JSON.stringify(expected)}`,
      ).toEqual([]);
    }
  });
});
