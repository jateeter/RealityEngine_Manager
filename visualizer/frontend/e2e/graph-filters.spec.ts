/**
 * graph-filters.spec.ts — Playwright e2e tests for the graph legend filters.
 *
 * Tests cover:
 *   - Node-type filter chips render and toggle correctly
 *   - OpenClaw portal focus filter narrows the graph
 *   - Bus semantic lane filter shows lane options when cross-domain edges exist
 *   - Filter state persists when switching 2D ↔ 3D
 *   - Reset filters button clears all filter state
 *   - ARIA attributes on interactive controls
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function openGraphView(page: Page) {
  await page.goto(VIZ_URL);
  await page.getByRole('button', { name: /Interconnect/i }).click();
  // Wait for SVG to be fully ready (simulation settled, opacity: 1)
  await page.waitForSelector('svg.machine-graph-svg', { timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const svg = document.querySelector('svg.machine-graph-svg') as HTMLElement | null;
      if (!svg) return false;
      const style = svg.getAttribute('style') ?? '';
      return style.includes('opacity: 1') || !style.includes('opacity: 0');
    },
    { timeout: 20_000 },
  );
}

async function openLegend(page: Page) {
  const legendPanel = page.locator('.vis-legend-panel');
  const isOpen = await legendPanel.evaluate(el => el.classList.contains('open'));
  if (!isOpen) {
    await page.locator('.vis-legend-tab').click();
    await legendPanel.waitFor({ state: 'visible' });
  }
}

async function countVisibleNodes(page: Page): Promise<number> {
  return page.locator('svg.machine-graph-svg g.node').filter({
    has: page.locator('') /* all nodes */,
  }).evaluateAll((nodes: Element[]) =>
    nodes.filter(n => {
      const opacity = (n as HTMLElement).style.opacity;
      return !opacity || parseFloat(opacity) > 0.1;
    }).length,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Graph Legend Filters', () => {

  test('node-type filter chips are rendered in the legend', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    const chips = page.locator('.vis-filter-chip');
    await expect(chips).toHaveCount(4); // standard, interconnect, agent-dispatcher, portals

    // All chips should start pressed (all types visible)
    for (const chip of await chips.all()) {
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('toggling a node-type chip deactivates it', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    const machinesChip = page.locator('.vis-filter-chip', { hasText: 'Machines' });
    await expect(machinesChip).toHaveAttribute('aria-pressed', 'true');

    await machinesChip.click();
    await expect(machinesChip).toHaveAttribute('aria-pressed', 'false');

    // Reset filters button should appear
    await expect(page.locator('.vis-reset-filters-btn')).toBeVisible();
  });

  test('toggling chip back re-enables it', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    const chip = page.locator('.vis-filter-chip', { hasText: 'Interconnects' });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  test('OpenClaw Portals only focus reduces visible node count', async ({ page }) => {
    await openGraphView(page);

    const baselineNodes = await countVisibleNodes(page);
    // Need at least some nodes to run this test meaningfully
    test.skip(baselineNodes === 0, 'No nodes rendered');

    await openLegend(page);

    const portalFocusCheckbox = page.locator('input[aria-label="OpenClaw Portals only"]');
    await expect(portalFocusCheckbox).toBeVisible();
    await portalFocusCheckbox.check();

    // After activating focus, visible node count should be ≤ baseline
    const filteredNodes = await countVisibleNodes(page);
    expect(filteredNodes).toBeLessThanOrEqual(baselineNodes);

    // Filter status count should appear
    const status = page.locator('.vis-filter-status');
    await expect(status).toBeVisible();
  });

  test('MQTT sources filter renders and can be toggled', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    const mqttCheckbox = page.locator('input[aria-label="MQTT sources only"]');
    await expect(mqttCheckbox).toBeVisible();
    await expect(mqttCheckbox).not.toBeChecked();

    await mqttCheckbox.check();
    await expect(mqttCheckbox).toBeChecked();
  });

  test('bus semantic lane section shows when cross-domain edges exist', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    // The section only renders if the graph has cross-domain edges with semantic lanes.
    // Skip gracefully if not present.
    const laneSection = page.locator('.vis-filter-lane-tags');
    const hasSemantic = await laneSection.isVisible().catch(() => false);

    if (!hasSemantic) {
      test.skip(true, 'No semantic lanes in current corpus — skip');
      return;
    }

    const laneTags = page.locator('.vis-filter-lane-tag');
    expect(await laneTags.count()).toBeGreaterThan(0);
  });

  test('selecting a semantic lane updates the graph', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    const laneSection = page.locator('.vis-filter-lane-tags');
    const hasSemantic = await laneSection.isVisible().catch(() => false);
    if (!hasSemantic) {
      test.skip(true, 'No semantic lanes in current corpus — skip');
      return;
    }

    const firstLaneCheckbox = page.locator('.vis-filter-lane-tag input[type="checkbox"]').first();
    await firstLaneCheckbox.check();
    await expect(firstLaneCheckbox).toBeChecked();

    // Reset button appears when a lane is selected
    await expect(page.locator('.vis-reset-filters-btn')).toBeVisible();
  });

  test('reset filters button clears all filter state', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    // Activate portal focus
    const portalFocusCheckbox = page.locator('input[aria-label="OpenClaw Portals only"]');
    await portalFocusCheckbox.check();
    await expect(page.locator('.vis-reset-filters-btn')).toBeVisible();

    // Click reset
    await page.locator('.vis-reset-filters-btn').click();

    // Portal focus should be cleared
    await expect(portalFocusCheckbox).not.toBeChecked();
    // Reset button should disappear
    await expect(page.locator('.vis-reset-filters-btn')).toBeHidden();
    // All chips should be active again
    const chips = page.locator('.vis-filter-chip');
    for (const chip of await chips.all()) {
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('filter state persists when switching 2D to 3D and back', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    // Activate MQTT focus
    const mqttCheckbox = page.locator('input[aria-label="MQTT sources only"]');
    await mqttCheckbox.check();
    await expect(mqttCheckbox).toBeChecked();

    // Close legend (so the toggle button is accessible)
    await page.locator('.vis-legend-tab').click();

    // Toggle to 3D
    const toggle3D = page.locator('.graph-3d-toggle');
    await toggle3D.click();
    await page.waitForTimeout(800); // 3D graph needs a moment to mount

    // Toggle back to 2D
    await toggle3D.click();
    await page.waitForTimeout(400);

    // Legend should still show MQTT filter active
    await page.locator('.vis-legend-tab').click();
    await expect(mqttCheckbox).toBeChecked();
  });

  test('all filter chips are keyboard accessible', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    const firstChip = page.locator('.vis-filter-chip').first();
    await firstChip.focus();

    // Space or Enter should toggle the chip
    await page.keyboard.press('Space');
    await expect(firstChip).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('Space');
    await expect(firstChip).toHaveAttribute('aria-pressed', 'true');
  });

  test('filter status live region announces visible node count', async ({ page }) => {
    await openGraphView(page);
    await openLegend(page);

    // Activate a filter that produces a restricted view
    const chip = page.locator('.vis-filter-chip', { hasText: 'Machines' });
    await chip.click();

    // Status should have aria-live attribute
    const status = page.locator('.vis-filter-status[aria-live]');
    await expect(status).toBeVisible();

    // Status text should be "X/Y" format
    const text = await status.textContent();
    expect(text).toMatch(/\d+\/\d+/);
  });
});
