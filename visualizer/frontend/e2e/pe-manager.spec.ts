import { test, expect, Page } from '@playwright/test';

/**
 * PE Manager E2E — one test per engine runtime (lsp, scala, cpp).
 *
 * Flow under test:
 *   1. Initiate the application (load landing surface)
 *   2. Select the target engine via the EngineSwitcher
 *   3. Open PE Manager
 *   4. Import sources from machine inputSequences (bootstrap)
 *   5. Validate full visual display of sources and assembled-vector
 *      interconnects in the heatmap
 *
 * Engine instances must be running before these tests execute:
 *   lsp-1   → ports RE:5601 / PE:5600
 *   scala-1 → ports RE:5101 / PE:5100
 *   cpp-1   → ports RE:5301 / PE:5300
 */

// ── Shared helpers ────────────────────────────────────────────────────────────

const TITLE = /Reality\s*Engine/;

async function loadApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.rep-title')).toContainText(TITLE, { timeout: 30_000 });
}

async function selectEngine(page: Page, instanceId: string, runtime: string): Promise<void> {
  const switcher = page.getByTitle('Switch active engine instance');
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  await expect(page.getByText('Engine Instances')).toBeVisible({ timeout: 5_000 });

  // Each instance row is a <button> containing the instance ID as text.
  // Clicking it calls api.setActiveEngine and closes the dropdown.
  await page.getByText(instanceId, { exact: true }).click();

  // The switcher button reflects the newly active engine's ID and runtime badge.
  await expect(switcher).toContainText(instanceId, { timeout: 10_000 });
  await expect(switcher).toContainText(runtime,     { timeout: 5_000 });
}

async function openPEManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: /PE Manager/ }).click();
  // "PERCEPTION ENGINE" header in the view title confirms the view rendered.
  await expect(page.getByText('PERCEPTION ENGINE')).toBeVisible({ timeout: 20_000 });
}

async function importSources(page: Page): Promise<void> {
  const importBtn = page.getByTitle('Import test sources from machine inputSequences');
  await expect(importBtn).toBeVisible({ timeout: 10_000 });
  await importBtn.click();
  // During import the button text changes to '…'; waits until it reads 'Import' again.
  await expect(importBtn).toContainText('Import', { timeout: 30_000 });
}

// ── Test 1: LSP engine ────────────────────────────────────────────────────────

test.describe('PE Manager — lsp engine', () => {
  test('[lsp] full E2E: select engine → PE Manager → import sources → verify sources and assembled-vector', async ({ page }) => {
    // Step 1 — initiate the application
    await loadApp(page);

    // Step 2 — select the LSP engine instance
    await selectEngine(page, 'lsp-1', 'lsp');

    // Step 3 — open PE Manager
    await openPEManager(page);

    // Assembled vector heatmap renders as soon as PE /api/state resolves.
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible({ timeout: 20_000 });
    // Sources panel header is present (may start at "Sources (0)").
    await expect(page.getByText(/^Sources \(/)).toBeVisible({ timeout: 10_000 });
    // ⊞ Vector tab is active.
    await expect(page.getByText('⊞ Vector')).toBeVisible();

    // Step 4 — import sources from machine inputSequences
    await importSources(page);

    // Step 5a — sources panel is populated (N > 0)
    // Matches "Sources (1)", "Sources (12)", … but NOT "Sources (0)".
    await expect(page.getByText(/^Sources \([1-9]/)).toBeVisible({ timeout: 15_000 });

    // At least one source card with its toggle button is visible.
    await expect(
      page.getByTitle(/^(Disable|Enable) source$/).first()
    ).toBeVisible({ timeout: 10_000 });

    // Step 5b — assembled-vector (interconnects) heatmap reflects the sources
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible();

    // Step 5c — hover the first source card to verify region highlighting is wired
    const firstCard = page.getByTitle(/^(Disable|Enable) source$/).first()
      .locator('xpath=ancestor::div[1]'); // immediate parent SourceCard wrapper
    await firstCard.hover();
    // The heatmap must still be present after hover (no crash).
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible();
  });
});

// ── Test 2: Scala engine ──────────────────────────────────────────────────────

test.describe('PE Manager — scala engine', () => {
  test('[scala] full E2E: select engine → PE Manager → import sources → verify sources and assembled-vector', async ({ page }) => {
    // Step 1 — initiate the application
    await loadApp(page);

    // Step 2 — select the Scala engine instance
    await selectEngine(page, 'scala-1', 'scala');

    // Step 3 — open PE Manager
    await openPEManager(page);

    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Sources \(/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('⊞ Vector')).toBeVisible();

    // Step 4 — import sources
    await importSources(page);

    // Step 5a — sources panel populated
    await expect(page.getByText(/^Sources \([1-9]/)).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTitle(/^(Disable|Enable) source$/).first()
    ).toBeVisible({ timeout: 10_000 });

    // Step 5b — assembled-vector heatmap
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible();

    // Step 5c — hover first source; heatmap region highlight must not crash
    const firstCard = page.getByTitle(/^(Disable|Enable) source$/).first()
      .locator('xpath=ancestor::div[1]');
    await firstCard.hover();
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible();
  });
});

// ── Test 3: C++ engine ────────────────────────────────────────────────────────

test.describe('PE Manager — cpp engine', () => {
  test('[cpp] full E2E: select engine → PE Manager → import sources → verify sources and assembled-vector', async ({ page }) => {
    // Step 1 — initiate the application
    await loadApp(page);

    // Step 2 — select the C++ engine instance
    await selectEngine(page, 'cpp-1', 'cpp');

    // Step 3 — open PE Manager
    await openPEManager(page);

    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Sources \(/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('⊞ Vector')).toBeVisible();

    // Step 4 — import sources
    await importSources(page);

    // Step 5a — sources panel populated
    await expect(page.getByText(/^Sources \([1-9]/)).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTitle(/^(Disable|Enable) source$/).first()
    ).toBeVisible({ timeout: 10_000 });

    // Step 5b — assembled-vector heatmap
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible();

    // Step 5c — hover first source; heatmap region highlight must not crash
    const firstCard = page.getByTitle(/^(Disable|Enable) source$/).first()
      .locator('xpath=ancestor::div[1]');
    await firstCard.hover();
    await expect(page.getByText(/Assembled Vector — \d+ elements/)).toBeVisible();
  });
});
