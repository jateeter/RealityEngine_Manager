/**
 * pe-source-arcs.spec.ts — Playwright e2e for PE-source feed-forward arcs
 * in the Machine Interconnection view (Manager#27).
 *
 * Seeds a sensor source over a machine's input region through the
 * registry-aware Manager proxy, ACTIVATES it with one value write, then
 * asserts the provenance pill and its feed-forward arc render and that the
 * GraphFilterPanel "PE Sources" chip hides them. Cleans up afterwards.
 *
 * Engine-agnostic: engines that do not emit `origin` yet group under the
 * 'sensor' provenance — assertions only rely on the pill/arc classes.
 *
 * WHY THE VALUE WRITE
 * -------------------
 * The overlay draws `peSources.filter(s => s.type === 'sensor' && s.active &&
 * !!s.region)`. This spec used to seed with `active: true` and assert the pill
 * — and the PE stores that source `active: false`, every time.
 *
 * That is the PE's contract, not a bug: a source is DECLARED inactive and
 * becomes active on its first value, because an active source contributes its
 * region to every vector the PE assembles, so registering one active changes
 * what the engine perceives before any data exists. Verified against a live
 * cpp-1/lsp-1/scala-1 universe: POST with `active: true` stores false, PATCH
 * `{active: true}` is likewise refused, and `POST /api/sensors/<sensorId>`
 * with values flips it to true. Across the whole PE at full corpus, sources
 * matching the overlay's filter numbered **zero** — so all three tests here
 * asserted something the data could not produce.
 *
 * The value write goes straight to the engine's PE, not through the Manager
 * proxy, because the proxy exposes no sensor-value route — see the note in
 * `activateSource` below.
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

let seededSourceId: string | null = null;

async function openInterconnections(page: Page) {
  await page.goto(VIZ_URL);
  await page.getByRole('button', { name: /Interconnect/i }).click();
  await page.waitForSelector('svg.machine-graph-svg', { timeout: 20_000 });
}

/**
 * Give the seeded sensor its first value, which is what makes it active.
 *
 * Posted to each engine's own PE rather than through `${VIZ_URL}/api/pe/...`:
 * the Manager proxy carries `/api/pe/sources` (GET/POST/PATCH/DELETE),
 * `/api/pe/push` and `/api/pe/reset`, but no route onto the PE's
 * `POST /api/sensors/:id`. So a sensor source can be created through Manager
 * and never fed through Manager, and the overlay Manager renders for it can
 * never light up from Manager's own API surface. Recorded rather than worked
 * around here — widening the proxy is a product change, not a test fix.
 *
 * Writes to every engine in the roster because source creation fans out
 * unevenly: the seeded probe landed on cpp-1 and scala-1 but not lsp-1 on a
 * live universe, the same 2-1 registration split as RealityEngine_CI#358. A
 * 404 from an engine that never received the source is expected, not a
 * failure, so each write is independent.
 */
async function activateSource(page: Page, sensorId: string): Promise<number> {
  const enginesRes = await page.request.get(`${VIZ_URL}/api/engines`);
  if (!enginesRes.ok()) return 0;
  const instances: Array<Record<string, unknown>> =
    (await enginesRes.json()).instances ?? [];

  let activated = 0;
  for (const inst of instances) {
    const peUrl = String(inst.pe_url ?? '');
    if (!peUrl) continue;
    const res = await page.request
      .post(`${peUrl}/api/sensors/${sensorId}`, { data: { values: [0.9, 0.8] } })
      .catch(() => null);
    if (res?.ok()) activated += 1;
  }
  return activated;
}

test.describe('PE-source feed-forward arcs', () => {
  test.beforeEach(async ({ page }) => {
    // Find a machine with a perceptual mapping to stimulate.
    const machinesResp = await page.request.get(`${VIZ_URL}/api/machines`);
    if (!machinesResp.ok()) test.skip(true, 'machines endpoint unavailable');
    const machines = (await machinesResp.json()).machines ?? [];
    const target = machines.find((m: any) => m.perceptualMapping?.input?.length > 0);
    if (!target) test.skip(true, 'no machine with a perceptual mapping');

    const { offset, length } = target.perceptualMapping.input;
    const create = await page.request.post(`${VIZ_URL}/api/pe/sources`, {
      data: {
        type: 'sensor',
        name: 'e2e-pe-arc-probe',
        sensorId: 'e2e_pe_arc_probe',
        region: { offset, length: Math.min(length, 4) },
        active: true,
        origin: 'mqtt',
        lastValue: [],
        lastUpdated: null,
        ttlMs: 600_000,
      },
    });
    if (!create.ok()) test.skip(true, `PE source create failed (${create.status()})`);
    const body = await create.json();
    seededSourceId = body?.source?.id ?? body?.id ?? null;

    // Declared, not yet active. Without this the overlay has nothing to draw
    // and all three tests below fail on a selector that could never match.
    const activated = await activateSource(page, 'e2e_pe_arc_probe');
    if (activated === 0) {
      test.skip(true, 'no engine accepted the sensor value; source stays inactive');
    }

    // Confirm the contract actually held before asserting on the render, so a
    // failure below is about the graph rather than about activation.
    const check = await page.request.get(`${VIZ_URL}/api/pe/sources`);
    const sources: Array<Record<string, unknown>> = check.ok()
      ? ((await check.json()).sources ?? [])
      : [];
    const probe = sources.find(s => s.sensorId === 'e2e_pe_arc_probe');
    expect(probe, 'seeded probe missing from the active engine').toBeTruthy();
    expect(probe?.active, 'seeded probe did not activate after its value write').toBe(true);

    // The graph fetches /api/pe/sources on mount, so navigating after
    // seeding is sufficient — no wait for the poll interval needed.
    await openInterconnections(page);
  });

  test.afterEach(async ({ page }) => {
    if (seededSourceId) {
      await page.request.delete(`${VIZ_URL}/api/pe/sources/${seededSourceId}`).catch(() => {});
      seededSourceId = null;
    }
  });

  test('provenance pill renders for the seeded source', async ({ page }) => {
    const pill = page.locator('g.node.pe-source');
    await expect(pill.first()).toBeVisible({ timeout: 20_000 });
    const pillText = await pill.first().locator('text').allTextContents();
    expect(pillText.join(' ')).toContain('PE SOURCES');
  });

  test('feed-forward arc connects the pill into the graph', async ({ page }) => {
    await expect(page.locator('g.node.pe-source').first()).toBeVisible({ timeout: 20_000 });
    const arcs = page.locator('path.pe-source-edge');
    expect(await arcs.count()).toBeGreaterThan(0);
  });

  test('PE Sources filter chip hides and restores pills and arcs', async ({ page }) => {
    await expect(page.locator('g.node.pe-source').first()).toBeVisible({ timeout: 20_000 });

    // Open the legend panel and toggle the PE Sources node-type chip.
    const legendPanel = page.locator('.vis-legend-panel');
    const isOpen = await legendPanel.evaluate(el => el.classList.contains('open')).catch(() => false);
    if (!isOpen) {
      await page.locator('.vis-legend-tab').click();
      await legendPanel.waitFor({ state: 'visible' });
    }
    const chip = page.locator('.vis-filter-chip', { hasText: 'PE Sources' });
    await expect(chip).toBeVisible({ timeout: 5_000 });

    // Filtered-out nodes are dimmed (opacity 0.04), not removed.
    const pill = page.locator('g.node.pe-source').first();
    await chip.click();
    await expect.poll(async () =>
      parseFloat(await pill.evaluate(el => (el as SVGGElement).style.opacity || '1')),
      { timeout: 5_000 },
    ).toBeLessThan(0.1);

    await chip.click();
    await expect.poll(async () =>
      parseFloat(await pill.evaluate(el => (el as SVGGElement).style.opacity || '1')),
      { timeout: 5_000 },
    ).toBe(1);
  });
});
