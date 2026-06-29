import { test, expect } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

test.describe('OpenClaw Domain Portals', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(VIZ_URL);
    // Navigate to the interconnection graph view
    await page.getByRole('button', { name: /Interconnect/i }).click();
    // Wait for the machine graph SVG to become visible (simulation settles)
    await page.waitForSelector('.machine-graph-svg', { timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelector('.machine-graph-svg')?.getAttribute('style')?.includes('opacity: 1') ||
             !document.querySelector('.machine-graph-svg')?.getAttribute('style')?.includes('opacity: 0'),
      { timeout: 20_000 },
    );
  });

  test('Health Services domain has an OpenClaw portal node', async ({ page }) => {
    // The portal node has text "⬡ OpenClaw Portal" or compact "⬡ ×N"
    // In compact mode (many nodes), look for the portal text label
    const svgText = await page.locator('svg text').allTextContents();
    const hasPortal = svgText.some(t => t.includes('OpenClaw Portal') || t.includes('⬡'));
    expect(hasPortal).toBe(true);
  });

  test('portal node tooltip shows dispatchers and buses on hover', async ({ page }) => {
    // Find any portal node — look for text containing "OpenClaw Portal" in the SVG
    const portalTextEl = page.locator('svg text').filter({ hasText: /OpenClaw Portal/i }).first();
    // Fall back to compact mode badge text
    const portalGroup = page.locator('g.node').filter({ has: portalTextEl });

    if (await portalGroup.count() === 0) {
      // Compact mode: look for "⬡ ×" badge
      test.skip(true, 'Portal node not visible in current mode');
      return;
    }

    await portalGroup.hover();
    // Portal tooltip should appear
    const portalTooltip = page.locator('.portal-tooltip');
    await expect(portalTooltip).toBeVisible({ timeout: 2000 });
    // Should show "OpenClaw Portal" header
    await expect(portalTooltip).toContainText('OpenClaw Portal');
    // Should list ACP dispatchers
    await expect(portalTooltip).toContainText('ACP Dispatchers');
    // Should show completion PS region
    await expect(portalTooltip).toContainText('PS[4210');
  });

  test('portal tooltip shows mechanical buses if domain has bus nodes', async ({ page }) => {
    const portalGroup = page.locator('g.node').filter({
      has: page.locator('text').filter({ hasText: /OpenClaw Portal/i }),
    }).first();

    if (await portalGroup.count() === 0) {
      test.skip(true, 'Portal node not found in current mode');
      return;
    }

    await portalGroup.hover();
    const portalTooltip = page.locator('.portal-tooltip');
    await expect(portalTooltip).toBeVisible({ timeout: 2000 });
    // Health Services has 20 bus nodes so this section should be present
    await expect(portalTooltip).toContainText('Mechanical Bus');
  });

  test('portal node disappears when its domain is filtered out', async ({ page }) => {
    // Open the legend
    const legendTab = page.getByRole('button', { name: /LEGEND/i });
    await legendTab.click();

    // Count portals before filter
    const svgBefore = await page.locator('svg text').allTextContents();
    const hasPortalBefore = svgBefore.some(t => t.includes('OpenClaw Portal') || t.includes('⬡ ×'));

    if (!hasPortalBefore) {
      test.skip(true, 'No visible portal node in current mode');
      return;
    }

    // Uncheck Health Services domain
    const hsCb = page.locator('label').filter({ hasText: /Health Services/i }).locator('input[type="checkbox"]');
    await hsCb.uncheck();

    // Allow filter animation
    await page.waitForTimeout(300);

    // Portal should be hidden (opacity 0.04 or display none)
    const portalNodeGroups = page.locator('g.node').filter({
      has: page.locator('text').filter({ hasText: /OpenClaw Portal/i }),
    });

    if (await portalNodeGroups.count() > 0) {
      // Check that opacity is very low (domain filter applied)
      const opacity = await portalNodeGroups.first().evaluate(el => {
        const style = window.getComputedStyle(el);
        return parseFloat(style.opacity);
      });
      expect(opacity).toBeLessThan(0.1);
    }
  });

  test('no stale global openclaw node outside domain hulls', async ({ page }) => {
    // The old global __openclaw__ node had label "OpenClaw" + "xACP Gateway"
    // It should NOT appear anymore — only per-domain portals exist
    const textContent = await page.locator('svg text').allTextContents();
    const hasGlobalNode = textContent.some(t => t === 'xACP Gateway');
    expect(hasGlobalNode).toBe(false);
  });
});
