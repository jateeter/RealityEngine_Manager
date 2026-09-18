/**
 * load-machines-modal.spec.ts — Playwright e2e for the Load Machines modal
 * (Manager#31). Opens the setup-tools menu, launches the modal, verifies the
 * corpus tree renders with counts, exercises tri-state selection, and loads
 * one small domain into the active engine (skip-if-present keeps this
 * idempotent against a full-corpus engine).
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

async function openModal(page: Page) {
  await page.goto(VIZ_URL);
  await page.getByRole('button', { name: /Setup tools/i }).click();
  await page.getByRole('menuitem', { name: /Load Machines/i }).click();
  await page.waitForSelector('.lmm-modal', { timeout: 10_000 });
}

test.describe('Load Machines modal', () => {
  test.beforeEach(async ({ page }) => {
    const tree = await page.request.get(`${VIZ_URL}/api/corpus/tree`);
    if (!tree.ok()) test.skip(true, 'corpus tree endpoint unavailable');
    await openModal(page);
  });

  test('corpus tree renders with counts and loaded badges', async ({ page }) => {
    await expect(page.getByTestId('load-machines-row').first()).toBeVisible({ timeout: 15_000 });
    const counts = page.locator('.lmm-node-count');
    expect(await counts.count()).toBeGreaterThan(0);
    await expect(counts.first()).toContainText(/\d+\/\d+ loaded/);
  });

  test('tri-state selection updates the footer count', async ({ page }) => {
    await expect(page.getByTestId('load-machines-row').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('load-machines-count')).toHaveText('0 selected');

    const firstNodeCheckbox = page.locator('.lmm-node-row input[type="checkbox"]').first();
    await firstNodeCheckbox.check();
    await expect(page.getByTestId('load-machines-count')).not.toHaveText('0 selected');

    await firstNodeCheckbox.uncheck();
    await expect(page.getByTestId('load-machines-count')).toHaveText('0 selected');
  });

  test('filter narrows the tree', async ({ page }) => {
    await expect(page.getByTestId('load-machines-row').first()).toBeVisible({ timeout: 15_000 });
    const before = await page.getByTestId('load-machines-row').count();
    await page.locator('.lmm-filter').fill('zzz-no-such-machine-zzz');
    const after = await page.getByTestId('load-machines-row').count();
    expect(after).toBeLessThan(before);
  });

  test('loading a small selection reports a summary', async ({ page }) => {
    await expect(page.getByTestId('load-machines-row').first()).toBeVisible({ timeout: 15_000 });

    // Pick a child node ('domains' is default-expanded); skip-if-present
    // makes re-runs report skips instead of duplicating machines.
    let childCheckbox = page
      .locator('.lmm-node-body .lmm-node-row input[type="checkbox"]')
      .first();
    if (await childCheckbox.count() === 0) {
      await page.locator('.lmm-expander:enabled').first().click();
      childCheckbox = page
        .locator('.lmm-node-body .lmm-node-row input[type="checkbox"]')
        .first();
    }
    if (await childCheckbox.count() === 0) test.skip(true, 'no child nodes in corpus tree');
    await childCheckbox.check();

    // Load into EVERY engine, not just the active one.
    //
    // `POST /api/corpus/load` targets the active engine unless `allEngines` is
    // set — deliberately, "never implicit" (Manager#31 Phase 4) — and the
    // modal defaults the box to false. So this test used to leave one engine
    // holding machines the other two did not, and the suite switches engines as
    // it runs, so which engine ended up ahead depended on ordering.
    //
    // That asymmetry outlives this test. Every later cross-runtime comparison in
    // the suite is then made against runtimes holding different corpora, which
    // `RealityEngine_CI/scripts/CLAUDE.md` names as the thing that must not
    // happen: "sources must be equalised before anything is compared ... the
    // trajectory comparison will faithfully report the difference as engine
    // divergence."
    //
    // It is what `tree-to-pe-manager-equivalence` was still failing on after its
    // own comparison defects were fixed — that test passes alone and failed in
    // suite (RealityEngine_Manager#151). The guardrail is right; a test that
    // mutates a shared universe is the one that has to opt in.
    const allEngines = page.locator('.lmm-bootstrap input[type="checkbox"]').last();
    const single = await page.getByText(/^All \d+ engines$/).count() === 0;
    if (!single) {
      await allEngines.check();
      await expect(allEngines).toBeChecked();
    }

    const loadBtn = page.locator('.lmm-load-btn');
    await expect(loadBtn).toBeEnabled();
    await loadBtn.click();

    await expect(page.locator('.lmm-summary')).toBeVisible({ timeout: 60_000 });
    // A request-level error also renders a summary — require a clean result.
    await expect(page.locator('.lmm-summary')).not.toHaveClass(/has-failures/);
    await expect(page.locator('.lmm-summary')).toContainText(/failed 0/);
  });
});
