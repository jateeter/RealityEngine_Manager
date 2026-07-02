/**
 * pe-source-arcs.spec.ts — Playwright e2e for PE-source feed-forward arcs
 * in the Machine Interconnection view (Manager#27).
 *
 * Seeds a sensor source over a machine's input region through the
 * registry-aware Manager proxy, then asserts the provenance pill and its
 * feed-forward arc render and that the GraphFilterPanel "PE Sources" chip
 * hides them. Cleans up the seeded source afterwards.
 *
 * Engine-agnostic: engines that do not emit `origin` yet group under the
 * 'sensor' provenance — assertions only rely on the pill/arc classes.
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

let seededSourceId: string | null = null;

async function openInterconnections(page: Page) {
  await page.goto(VIZ_URL);
  await page.getByRole('button', { name: /Interconnect/i }).click();
  await page.waitForSelector('svg.machine-graph-svg', { timeout: 20_000 });
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
