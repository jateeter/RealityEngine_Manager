import { test, expect } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

test.describe('OpenClaw Domain Portals', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(VIZ_URL);
    // Navigate to the interconnection graph view
    await page.getByRole('button', { name: /Interconnect/i }).click();
    // `.graph-svg` is MachineInterconnectionGraph's svg. The Interconnect button
    // renders MachineGraphView, whose svg is `.machine-graph-svg` — verified
    // against a live universe, where `.graph-svg` is absent and
    // `.machine-graph-svg` is present. Every test in this file failed here, in
    // beforeEach, before reaching an assertion about portals.
    await page.waitForSelector('svg.machine-graph-svg', { timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const svg = document.querySelector('svg.machine-graph-svg');
        const style = svg?.getAttribute('style') ?? '';
        return !!svg && (style.includes('opacity: 1') || !style.includes('opacity: 0'));
      },
      { timeout: 20_000 },
    );
  });

  /**
   * Asserted on the node, not on its caption.
   *
   * This used to scan `svg text` for the literal "OpenClaw Portal" and failed
   * in every run. The portals were there the whole time — three of them, ids
   * `__openclaw_portal_{ai,healthservices,healthpersonal}__`, carrying role
   * `openclaw-virtual`. What changed is the caption: MachineGraphView renders
   * a compact "⬡ ×<dispatchers>" plus the first word of the domain label, so
   * a Health Services portal reads "Health" / "⬡ ×20" and contains the string
   * "OpenClaw" nowhere at all.
   *
   * The sibling MachineInterconnectionGraph does render the long caption, and
   * this spec was written against it — but the Interconnect button renders
   * MachineGraphView (#153). Rather than chase the caption, this asserts what
   * a portal IS: a node the graph marks as a portal, one per domain holding
   * agent-dispatchers. A caption is a decoration and may change again.
   */
  test('a portal node exists for each domain with agent-dispatchers', async ({ page }) => {
    const portals = page.locator('g.node.openclaw-portal');
    await expect(portals.first()).toBeVisible({ timeout: 20_000 });

    const ids = await portals.evaluateAll(els =>
      els.map(el => String((el as unknown as { __data__?: { id?: string } }).__data__?.id ?? '')));

    expect(ids.length, 'the corpus has agent-dispatchers, so it must have portals')
      .toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `portal node has an unexpected id: ${id}`)
        .toMatch(/^__openclaw_portal_[a-z]+__$/);
    }

    // Health Services carries the largest dispatcher group in this corpus, so
    // its portal is the one whose absence would be most obviously wrong.
    expect(ids, `portals present: ${JSON.stringify(ids)}`)
      .toContain('__openclaw_portal_healthservices__');
  });

  test('portal node tooltip shows dispatchers and buses on hover', async ({ page }) => {
    const portalGroup = page.locator('g.openclaw-portal').first();

    if (await portalGroup.count() === 0) {
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
    const portalGroup = page.locator('g.openclaw-portal').first();

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

    // Addressed by class, not caption. Scanning `svg text` for "OpenClaw
    // Portal" found nothing here — see the first test — so this skipped itself
    // on every run and asserted nothing at all. A skip that reports "not in
    // current mode" for a mode that is present is worse than a failure.
    const healthPortal = page.locator('g.node.openclaw-portal').filter({
      has: page.locator(':scope'),
    });
    await expect(healthPortal.first()).toBeVisible({ timeout: 20_000 });

    const before = await healthPortal.count();
    expect(before, 'a portal must be present before filtering it out')
      .toBeGreaterThan(0);

    // Uncheck Health Services. The domain filter is a checkbox inside
    // `label.vis-legend-domain-row`, not a button — `getByRole('button', …)`
    // matched nothing and timed out, which is the second half of why this test
    // never ran: it skipped on the caption above, and could not have clicked
    // anything had it got this far.
    const healthRow = page.locator('.vis-legend-domain-row', { hasText: /Health Services/i }).first();
    await expect(healthRow).toBeVisible({ timeout: 10_000 });
    await healthRow.locator('input[type="checkbox"]').click();

    // The HEALTH SERVICES portal specifically, not `.first()`. There are three
    // portals and DOM order is the simulation's business — `.first()` was the
    // `ai` one, whose opacity is correctly unaffected by unchecking a different
    // domain, so the test failed while the app was right.
    const portalIds = await page.locator('g.node.openclaw-portal').evaluateAll(els =>
      els.map(el => String((el as unknown as { __data__?: { id?: string } }).__data__?.id ?? '')));
    const healthIndex = portalIds.indexOf('__openclaw_portal_healthservices__');
    expect(healthIndex, `no health-services portal among ${JSON.stringify(portalIds)}`)
      .toBeGreaterThanOrEqual(0);

    // Filtered-out nodes are dimmed rather than removed, matching how the
    // PE-source chip behaves, so poll the opacity instead of a fixed wait.
    const target = page.locator('g.node.openclaw-portal').nth(healthIndex);
    await expect.poll(
      async () => parseFloat(
        await target.evaluate(el => window.getComputedStyle(el).opacity || '1')),
      { timeout: 10_000 },
    ).toBeLessThan(0.5);
  });

  test('no stale global openclaw node outside domain hulls', async ({ page }) => {
    // The old global __openclaw__ node had label "OpenClaw" + "xACP Gateway"
    // It should NOT appear anymore — only per-domain portals exist
    const textContent = await page.locator('svg text').allTextContents();
    const hasGlobalNode = textContent.some(t => t === 'xACP Gateway');
    expect(hasGlobalNode).toBe(false);

    // The old global node carried the id `__openclaw__`. Checking the id as
    // well as the caption, because the caption is exactly what stopped being
    // reliable in the test above.
    const ids = await page.locator('g.node').evaluateAll(els =>
      els.map(el => String((el as unknown as { __data__?: { id?: string } }).__data__?.id ?? '')));
    expect(ids, 'the retired global gateway node is still in the graph')
      .not.toContain('__openclaw__');
  });
});
