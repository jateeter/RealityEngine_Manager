import { test, expect, Page, APIRequestContext, APIResponse, TestInfo } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type Runtime = 'lsp' | 'scala' | 'cpp';

interface EngineTarget {
  id: string;
  runtime: Runtime;
}

interface CapturedResponse {
  engine: Runtime;
  method: string;
  url: string;
  path: string;
  status: number;
  ok: boolean;
  bodyBase64: string;
  sha256: string;
  byteLength: number;
}

interface EngineRun {
  engine: EngineTarget;
  captures: CapturedResponse[];
  sourceCountText: string;
  activeCountText: string;
  treeRowCount: number;
  treeLoadedOk: boolean;
  disableSourceCount: number;
  enableSourceCount: number;
  sourcePresentationOk: boolean;
  errors: string[];
}

const ENGINES: EngineTarget[] = [
  { id: 'lsp-1', runtime: 'lsp' },
  { id: 'scala-1', runtime: 'scala' },
  { id: 'cpp-1', runtime: 'cpp' },
];

test.describe.configure({ mode: 'serial' });

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'root';
}

function apiPath(url: string): string | null {
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith('/api/')) return null;
  return `${parsed.pathname}${parsed.search}`;
}

function capturedResponse(engine: Runtime, method: string, url: string, status: number, ok: boolean, body: Buffer): CapturedResponse | null {
  const path = apiPath(url);
  if (!path) return null;
  return {
    engine,
    method,
    url,
    path,
    status,
    ok,
    bodyBase64: body.toString('base64'),
    sha256: sha256(body),
    byteLength: body.length,
  };
}

function comparable(path: string): boolean {
  // Manager control-plane calls are captured, but they are not runtime API
  // responses. They intentionally vary by selected engine instance.
  if (path === '/api/engines') return false;
  if (path === '/api/engines/active') return false;
  if (/^\/api\/engines\/[^/]+\/health$/.test(path)) return false;
  return true;
}

async function waitForTreeRows(page: Page): Promise<{ rowCount: number; loadedOk: boolean }> {
  await page.locator('.rep-body').waitFor({ state: 'visible', timeout: 30_000 });
  try {
    await expect
      .poll(async () => page.locator('.rep-row').count(), {
        timeout: 45_000,
        intervals: [250, 500, 1_000],
      })
      .toBeGreaterThan(0);
    const rowCount = await page.locator('.rep-row').count();
    return { rowCount, loadedOk: true };
  } catch {
    const rowCount = await page.locator('.rep-row').count();
    return { rowCount, loadedOk: false };
  }
}

async function captureRequestResponse(engine: EngineTarget, method: string, response: APIResponse): Promise<CapturedResponse> {
  const body = await response.body();
  const capture = capturedResponse(engine.runtime, method, response.url(), response.status(), response.ok(), body);
  expect(capture, `${method} ${response.url()} should be an API response`).toBeTruthy();
  return capture!;
}

async function switchEngine(request: APIRequestContext, engine: EngineTarget): Promise<CapturedResponse> {
  const res = await request.post('/api/engines/active', {
    data: { id: engine.id },
    headers: { 'Content-Type': 'application/json' },
  });
  const capture = await captureRequestResponse(engine, 'POST', res);
  expect(res.ok(), `engine switch to ${engine.id} failed: ${res.status()}`).toBeTruthy();
  return capture;
}

async function resetPE(request: APIRequestContext, engine: EngineTarget): Promise<CapturedResponse> {
  const res = await request.post('/api/pe/reset', {
    data: {},
    headers: { 'Content-Type': 'application/json' },
  });
  const capture = await captureRequestResponse(engine, 'POST', res);
  expect(res.ok(), `PE reset failed: ${res.status()}`).toBeTruthy();
  return capture;
}

async function loadCompleteTree(page: Page): Promise<{ rowCount: number; loadedOk: boolean }> {
  await page.goto('/');
  await expect(page.locator('.rep-title')).toContainText(/Reality\s*Engine/, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /PE Manager/ })).toBeVisible({ timeout: 10_000 });
  return waitForTreeRows(page);
}

async function openPEManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: /PE Manager/ }).click();
  await expect(page.getByText('PERCEPTION ENGINE', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Assembled Vector - \d+ elements|Assembled Vector . \d+ elements/)).toBeVisible({ timeout: 20_000 });
}

async function importSources(page: Page): Promise<void> {
  const importButton = page.getByTitle('Import test sources from machine inputSequences');
  await expect(importButton).toBeVisible({ timeout: 10_000 });
  await importButton.click();
  await expect(importButton).toContainText('Import', { timeout: 60_000 });
}

async function forceAllSourcesOn(page: Page): Promise<void> {
  const toggleAll = page.getByRole('button', { name: /^(All Off|Mixed)$/ });
  if (await toggleAll.count() && await toggleAll.first().isEnabled()) {
    await toggleAll.first().click();
  }
  await expect(page.getByTitle('Enable source')).toHaveCount(0, { timeout: 15_000 });
}

async function returnToTree(page: Page): Promise<{ rowCount: number; loadedOk: boolean }> {
  await page.getByTitle('Back to Reality Engine').click();
  await expect(page.getByRole('button', { name: /PE Manager/ })).toBeVisible({ timeout: 30_000 });
  return waitForTreeRows(page);
}

async function captureEngineFlow(page: Page, engine: EngineTarget): Promise<EngineRun> {
  const captures: CapturedResponse[] = [];
  const errors: string[] = [];

  const listener = async (response: any) => {
    let body: Buffer;
    try {
      body = await response.body();
    } catch {
      body = Buffer.from('');
    }

    const capture = capturedResponse(
      engine.runtime,
      response.request().method(),
      response.url(),
      response.status(),
      response.ok(),
      body
    );
    if (capture) captures.push(capture);
  };

  page.on('response', listener);
  try {
    const tree = await loadCompleteTree(page);
    if (!tree.loadedOk) {
      errors.push('tree visualization loaded with zero machine/domain/CES rows');
    }
    await openPEManager(page);
    await importSources(page);

    let sourcePresentationOk = true;
    try {
      await expect(page.locator('text=/^Sources \\([1-9]/').first()).toBeVisible({ timeout: 15_000 });
      await forceAllSourcesOn(page);
      await expect(page.getByTitle('Disable source').first()).toBeVisible({ timeout: 15_000 });
    } catch (error: any) {
      sourcePresentationOk = false;
      errors.push(`source presentation failed: ${error?.message ?? String(error)}`);
    }

    const sourceCountText = await page.locator('text=/^Sources \\(/').first().innerText().catch(() => 'Sources (?)');
    const activeCountText = await page.locator('text=/\\d+\\/\\d+ active/').first().innerText().catch(() => '?/? active');
    const disableSourceCount = await page.getByTitle('Disable source').count();
    const enableSourceCount = await page.getByTitle('Enable source').count();

    const returnedTree = await returnToTree(page);
    if (!returnedTree.loadedOk) {
      errors.push('returned tree view had zero machine/domain/CES rows');
    }

    return {
      engine,
      captures,
      sourceCountText,
      activeCountText,
      treeRowCount: Math.max(tree.rowCount, returnedTree.rowCount),
      treeLoadedOk: tree.loadedOk && returnedTree.loadedOk,
      disableSourceCount,
      enableSourceCount,
      sourcePresentationOk,
      errors,
    };
  } finally {
    page.off('response', listener);
  }
}

function latestComparableBySignature(run: EngineRun): Map<string, CapturedResponse> {
  const out = new Map<string, CapturedResponse>();
  for (const capture of run.captures) {
    if (!comparable(capture.path)) continue;
    out.set(`${capture.method} ${capture.path}`, capture);
  }
  return out;
}

function compareRuns(runs: EngineRun[]) {
  const byRuntime = Object.fromEntries(
    runs.map(run => [run.engine.runtime, latestComparableBySignature(run)])
  ) as Record<Runtime, Map<string, CapturedResponse>>;

  const signatures = [...byRuntime.lsp.keys()]
    .filter(sig => byRuntime.scala.has(sig) && byRuntime.cpp.has(sig))
    .sort();

  const mismatches = [];
  for (const signature of signatures) {
    const lsp = byRuntime.lsp.get(signature)!;
    const scala = byRuntime.scala.get(signature)!;
    const cpp = byRuntime.cpp.get(signature)!;
    const sameStatus = lsp.status === scala.status && lsp.status === cpp.status;
    const sameBytes = lsp.bodyBase64 === scala.bodyBase64 && lsp.bodyBase64 === cpp.bodyBase64;
    if (!sameStatus || !sameBytes) {
      mismatches.push({
        signature,
        status: { lsp: lsp.status, scala: scala.status, cpp: cpp.status },
        byteLength: { lsp: lsp.byteLength, scala: scala.byteLength, cpp: cpp.byteLength },
        sha256: { lsp: lsp.sha256, scala: scala.sha256, cpp: cpp.sha256 },
      });
    }
  }

  return {
    comparableSignatures: signatures,
    mismatches,
    skippedManagerControlCalls: runs.map(run => ({
      runtime: run.engine.runtime,
      count: run.captures.filter(c => !comparable(c.path)).length,
    })),
  };
}

async function writeCaptureBodies(runs: EngineRun[], testInfo: TestInfo) {
  const outputDir = testInfo.outputPath('api-response-bodies');
  await fs.mkdir(outputDir, { recursive: true });

  const manifest = [];
  let index = 0;
  for (const run of runs) {
    for (const capture of run.captures) {
      const filename = [
        String(index).padStart(4, '0'),
        capture.engine,
        capture.method,
        safeFilePart(capture.path),
        capture.sha256.slice(0, 12),
      ].join('-') + '.body';
      const bodyPath = path.join(outputDir, filename);
      await fs.writeFile(bodyPath, Buffer.from(capture.bodyBase64, 'base64'));
      manifest.push({
        index,
        engine: capture.engine,
        method: capture.method,
        path: capture.path,
        url: capture.url,
        status: capture.status,
        ok: capture.ok,
        byteLength: capture.byteLength,
        sha256: capture.sha256,
        comparable: comparable(capture.path),
        bodyFile: path.relative(testInfo.outputDir, bodyPath),
      });
      index += 1;
    }
  }

  return manifest;
}

test('tree view to PE Manager verifies all sources on and compares captured API response bytes across all engines', async ({ page, request }, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const runs: EngineRun[] = [];

  for (const engine of ENGINES) {
    const setupCaptures = [
      await switchEngine(request, engine),
      await resetPE(request, engine),
    ];
    const run = await captureEngineFlow(page, engine);
    run.captures.unshift(...setupCaptures);
    runs.push(run);
  }

  const comparison = compareRuns(runs);
  const captureManifest = await writeCaptureBodies(runs, testInfo);
  const report = {
    generatedAt: new Date().toISOString(),
    engines: runs.map(run => ({
      id: run.engine.id,
      runtime: run.engine.runtime,
      treeRowCount: run.treeRowCount,
      treeLoadedOk: run.treeLoadedOk,
      sourceCountText: run.sourceCountText,
      activeCountText: run.activeCountText,
      disableSourceCount: run.disableSourceCount,
      enableSourceCount: run.enableSourceCount,
      sourcePresentationOk: run.sourcePresentationOk,
      errors: run.errors,
      capturedApiResponses: run.captures.length,
    })),
    comparison: {
      comparableResponseCount: comparison.comparableSignatures.length,
      comparableSignatures: comparison.comparableSignatures,
      mismatchCount: comparison.mismatches.length,
      mismatches: comparison.mismatches,
      skippedManagerControlCalls: comparison.skippedManagerControlCalls,
    },
    captures: captureManifest,
  };
  const manifestPath = testInfo.outputPath('tree-to-pe-manager-api-byte-capture.json');
  await fs.writeFile(manifestPath, JSON.stringify(report, null, 2));

  await testInfo.attach('tree-to-pe-manager-api-byte-capture.json', {
    path: manifestPath,
    contentType: 'application/json',
  });

  for (const run of runs) {
    expect(run.treeLoadedOk, `${run.engine.runtime} tree should contain loaded machine/domain/CES rows: ${run.errors.join('; ')}`).toBe(true);
    expect(run.treeRowCount, `${run.engine.runtime} tree should contain rows`).toBeGreaterThan(0);
    expect(run.sourcePresentationOk, `${run.engine.runtime} should present imported active sources: ${run.errors.join('; ')}`).toBe(true);
    expect(run.disableSourceCount, `${run.engine.runtime} should present active source toggles`).toBeGreaterThan(0);
    expect(run.enableSourceCount, `${run.engine.runtime} should have all visible sources ON`).toBe(0);
  }

  expect(
    comparison.mismatches,
    `API response byte mismatches:\n${JSON.stringify(comparison.mismatches, null, 2)}`
  ).toEqual([]);
});
