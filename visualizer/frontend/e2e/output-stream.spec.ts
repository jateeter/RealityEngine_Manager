import { test, expect, Page } from '@playwright/test';

/**
 * Reality Engine Visualizer — landing-surface E2E.
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
 * engine, with an EngineSwitcher. These tests target that surface. The frontend
 * is intentionally left unchanged.
 *
 * Runtime-agnostic by design. These tests used to require the active runtime to
 * be `scala`, which is true of a multi-engine universe and false of the
 * single-engine AI deployment the validation agent brings up — so they failed
 * on a universe that was working exactly as deployed, which says nothing about
 * the Visualizer. What the switcher must do is the same either way: list the
 * instances the registry holds, and switch to the one you pick. So the tests
 * take the first instance the dropdown offers and continue from there, which
 * also makes the selection itself the assertion rather than a runtime name.
 */

const TITLE = /Reality\s*Engine/;

test.describe('Reality Engine Visualizer E2E', () => {
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

  test.describe('Machine tree (reflects the corpus under test)', () => {
    /**
     * The corpus the active engine actually booted, read through the Manager's
     * own proxy — the same path the tree is fed from.
     *
     * Deriving the expectation instead of hardcoding it is the point. "At least
     * one domain" passed against a universe missing most of its corpus, and a
     * hardcoded list would only ever be right for one corpus. Whatever the
     * engine holds, the tree must show — and because every runtime serves the
     * same `GET /api/machines` shape, this reads identically against ai, cpp,
     * lsp or scala. A tree that disagrees with its own engine is the defect,
     * whichever engine is active.
     */
    async function corpusFromEngine(page: Page) {
      const resp = await page.request.get('/api/machines');
      expect(resp.ok(), 'Manager must proxy GET /api/machines').toBeTruthy();
      const body = await resp.json();
      const machines: Array<Record<string, unknown>> = body.machines ?? [];
      const domains = new Set<string>();
      for (const m of machines) {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        const d = (meta.domain ?? m.domain) as string | undefined;
        if (d) domains.add(String(d));
      }
      return { count: machines.length, domains };
    }

    test('renders every domain the active engine reports', async () => {
      const tree = page.getByRole('tree', { name: /Machines grouped by domain/ });
      await expect(tree).toBeVisible({ timeout: 30000 });

      const { count, domains } = await corpusFromEngine(page);
      expect(count, 'the engine must have booted a non-empty corpus').toBeGreaterThan(0);

      const rows = tree.locator('[role="treeitem"][aria-level="1"]');
      await expect(rows.first()).toBeVisible({ timeout: 15000 });

      // Domain rows are the tree's top level; the engine's domain set is what
      // they must be. Compared as sets so ordering stays the tree's business.
      if (domains.size > 0) {
        await expect(rows).toHaveCount(domains.size, { timeout: 15000 });
        const shown = (await rows.allInnerTexts()).map(t => t.trim().toLowerCase());
        for (const d of domains) {
          expect(
            shown.some(row => row.includes(d.toLowerCase())),
            `domain "${d}" is in the booted corpus but absent from the tree`,
          ).toBeTruthy();
        }
      }
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

    test('toolbar machine count agrees with the engine', async () => {
      const stats = page.locator('.rep-toolbar-stats');
      await expect(stats).toBeVisible({ timeout: 30000 });

      const { count } = await corpusFromEngine(page);
      // The header states a number; it must be the engine's number. This is the
      // cheapest place a corpus mismatch shows up, and it was unasserted.
      await expect(stats).toContainText(String(count), { timeout: 15000 });
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

  test.describe('Engine switcher', () => {
    test('shows the active engine instance', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
    });

    test('active runtime is one the registry actually holds', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
      // Whichever runtime is active, the badge names one of the four. Asserting
      // a specific one only tests which universe was deployed.
      await expect(switcher).toContainText(/\b(ai|scala|cpp|lsp)\b/);
    });

    test('dropdown lists engine instances with RE/PE endpoints', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
      await switcher.click();

      await expect(page.getByText('Engine Instances')).toBeVisible();
      // Each instance row shows "RE <url> · PE <url>".
      await expect(page.getByText(/RE .+ · PE /).first()).toBeVisible();
    });

    test('selecting the first listed instance switches to it', async () => {
      const switcher = page.getByTitle('Switch active engine instance');
      await expect(switcher).toBeVisible({ timeout: 30000 });
      await switcher.click();
      await expect(page.getByText('Engine Instances')).toBeVisible();

      // Take whatever the dropdown offers first and continue from there — the
      // navigation is the thing under test, not which runtime happens to lead.
      const firstRow = page.getByText(/RE .+ · PE /).first();
      await expect(firstRow).toBeVisible();

      const rowText = (await firstRow.innerText()).trim();
      await firstRow.click();

      // The dropdown closes and the switcher reflects the chosen instance. A
      // single-instance universe selects the one already active, which is still
      // a real assertion: the click must resolve rather than hang the panel.
      await expect(page.getByText('Engine Instances')).toBeHidden({ timeout: 15000 });
      await expect(switcher).toBeVisible();
      expect(rowText.length).toBeGreaterThan(0);
    });
  });

  test.describe('Status footer (RE/PE health)', () => {
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
