import { test, expect, Page } from '@playwright/test';

/**
 * Reality Engine Visualizer — landing-surface E2E (Scala engine).
 *
 * Rewritten from the legacy "Output Stream" spec, which (a) failed to even
 * parse — two `filter({ hasText: /\\[.../ })` calls used double-escaped regex
 * *literals*, producing an unterminated character class so Playwright reported
 * "No tests found" — and (b) asserted a UI that no longer exists ("OUTPUT
 * STREAM" panel, "NAND Gate"/"Multi-Step"/"Generate" buttons).
 *
 * In the current frontend `OutputStreamVisualization` lives inside
 * `MachineContainerView`, which is not wired into `App`'s routing
 * (`selection` | `interconnection` | `perceptual-engine`), so it is
 * unreachable from the running app. The reachable landing surface is
 * `RealityEnginePanelView`: a domain → machine → CES tree fed by the active
 * engine, with an EngineSwitcher whose active runtime is the Scala engine in
 * the standard universe. These tests target that surface. The frontend is
 * intentionally left unchanged.
 */

const TITLE = /Reality\s*Engine/;

test.describe('Reality Engine Visualizer (Scala engine) E2E', () => {
  let page: Page;

  test.beforeEach(async ({ page: testPage }) => {
    page = testPage;
    await page.goto('/');
    // The wordmark ("Reality" + accent " Engine") renders without any backend.
    await expect(page.locator('.rep-title')).toContainText(TITLE, { timeout: 30000 });
  });

  test.describe('Landing surface', () => {
    test('renders the Reality Engine header and subtitle', async () => {
      await expect(page.locator('.rep-title')).toContainText(TITLE);
      await expect(page.locator('.rep-subtitle')).toContainText('perception');
    });

    test('shows the toolbar stats (machines · CES · domains)', async () => {
      const stats = page.locator('.rep-toolbar-stats');
      await expect(stats).toBeVisible();
      await expect(stats).toContainText('machines');
      await expect(stats).toContainText('CES');
      await expect(stats).toContainText('domains');
    });

    test('exposes the primary navigation buttons', async () => {
      await expect(page.getByRole('button', { name: /Interconnect/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /PE Manager/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
    });
  });

  test.describe('Machine tree (loaded from the Scala engine)', () => {
    test('renders the domain tree with at least one machine domain', async () => {
      const tree = page.getByRole('tree', { name: /Machines grouped by domain/ });
      await expect(tree).toBeVisible({ timeout: 30000 });
      await expect(tree.getByRole('treeitem').first()).toBeVisible();
    });

    test('expands a domain to reveal its machines', async () => {
      const tree = page.getByRole('tree', { name: /Machines grouped by domain/ });
      await expect(tree).toBeVisible({ timeout: 30000 });

      const domainRow = tree.getByRole('treeitem').first();
      await expect(domainRow).toHaveAttribute('aria-level', '1');
      await domainRow.click();
      // After expanding, a level-2 (machine) row should appear.
      await expect(tree.locator('[role="treeitem"][aria-level="2"]').first())
        .toBeVisible({ timeout: 10000 });
    });

    test('search narrows the tree and reports no matches for nonsense', async () => {
      const tree = page.getByRole('tree', { name: /Machines grouped by domain/ });
      await expect(tree).toBeVisible({ timeout: 30000 });

      await page.getByPlaceholder(/search domains/).fill('zzz-no-such-machine-xyz');
      await expect(page.getByText('no machines found')).toBeVisible({ timeout: 10000 });

      // Clearing the search restores the tree.
      await page.locator('.rep-search-clear').click();
      await expect(tree).toBeVisible();
    });

    test('filter buttons toggle active state', async () => {
      const examples = page.getByRole('button', { name: 'examples', exact: true });
      await examples.click();
      await expect(examples).toHaveClass(/is-active/);

      const all = page.getByRole('button', { name: 'all', exact: true });
      await all.click();
      await expect(all).toHaveClass(/is-active/);
    });
  });

  test.describe('Engine switcher — Scala runtime', () => {
    test('shows the active engine instance', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
    });

    test('active runtime is the Scala engine', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
      // The active instance's runtime badge text is the runtime id ("scala").
      await expect(switcher).toContainText('scala');
    });

    test('dropdown lists engine instances with RE/PE endpoints', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
      await switcher.click();

      await expect(page.getByText('Engine Instances')).toBeVisible();
      // Each instance row shows "RE <url> · PE <url>".
      await expect(page.getByText(/RE .+ · PE /).first()).toBeVisible();
    });
  });

  test.describe('Status footer (Scala RE/PE health)', () => {
    test('shows RE and PE status pills and surface version', async () => {
      const footer = page.locator('.rep-status-bar');
      await expect(footer).toBeVisible();
      await expect(footer).toContainText('RE');
      await expect(footer).toContainText('PE');
      await expect(footer).toContainText('surface v1.1.0');
    });
  });

  test.describe('Help overlay (deterministic, no backend)', () => {
    test('opens the navigation guide and closes on Escape', async () => {
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(page.getByText('Navigation Guide')).toBeVisible();
      await expect(page.getByText('Keyboard Shortcuts')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.getByText('Navigation Guide')).toBeHidden();
    });
  });
});
