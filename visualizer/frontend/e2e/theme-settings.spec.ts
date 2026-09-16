/**
 * theme-settings.spec.ts — Playwright e2e tests for the theme / settings system.
 *
 * Settings are now opened via the SetupToolsMenu (⚙ "Setup tools" button → menu item).
 *
 * Tests cover:
 *   - Setup tools button is present in the header
 *   - Clicking it opens the dropdown menu
 *   - Selecting "Visualizer Settings" from the menu opens the settings modal
 *   - Escape closes the modal and returns focus to the setup-tools trigger
 *   - Theme radio selection changes data-theme on <html>
 *   - Dark → Nord → Dark round-trip via UI
 *   - Theme persists across a page reload (localStorage)
 *   - Done button closes the modal
 *   - Modal is accessible (aria-modal, aria-labelledby)
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function openApp(page: Page) {
  await page.goto(VIZ_URL);
  await page.waitForLoadState('networkidle');
}

/** Open the SetupToolsMenu dropdown, then click "Visualizer Settings". */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: /setup tools/i }).click();
  await page.waitForSelector('[role="menu"]', { timeout: 3_000 });
  await page.getByRole('menuitem', { name: /visualizer settings/i }).click();
  await page.waitForSelector('dialog.settings-dialog[open]', { timeout: 5_000 });
}

/**
 * Select a theme the way a user does — by clicking the option, not the input.
 *
 * `input[name="theme"][value="…"]` resolves fine, but `.check()` fails with
 * `<span class="theme-swatch"> from <div class="theme-swatches"> subtree
 * intercepts pointer events`: the radio is visually replaced by the swatch row
 * it sits behind. The wrapping `<label class="theme-option">` is the control
 * the user actually hits, and clicking it drives the same onChange.
 */
async function selectTheme(page: Page, value: string) {
  const radio = page.locator(`input[name="theme"][value="${value}"]`);
  await radio.locator('xpath=ancestor::label[1]').click();
  await expect(radio).toBeChecked();
}

async function closeWithDone(page: Page) {
  await page.getByRole('button', { name: /Done/i }).click();
  await page.waitForFunction(
    () => !document.querySelector('dialog.settings-dialog[open]'),
    { timeout: 5_000 },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('SetupToolsMenu', () => {
  test('setup tools button is visible in the header', async ({ page }) => {
    await openApp(page);
    const trigger = page.getByRole('button', { name: /setup tools/i });
    await expect(trigger).toBeVisible();
  });

  test('clicking trigger opens the dropdown menu', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /setup tools/i }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('button', { name: /setup tools/i })).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape closes the dropdown menu', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /setup tools/i }).click();
    await page.waitForSelector('[role="menu"]');
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).not.toBeVisible();
  });

  test('"Visualizer Settings" menu item opens the settings modal', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
  });
});

test.describe('Settings modal', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await openSettings(page);
  });

  test('modal has correct ARIA attributes', async ({ page }) => {
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = await dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const heading = page.locator(`#${labelId}`);
    await expect(heading).toContainText('Visualizer Settings');
  });

  test('Escape key closes the modal', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('dialog.settings-dialog[open]'),
      { timeout: 5_000 },
    );
    await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
  });

  test('Done button closes the modal', async ({ page }) => {
    await closeWithDone(page);
    await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
  });

  test('focus returns to setup-tools trigger after closing', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('dialog.settings-dialog[open]'),
      { timeout: 5_000 },
    );
    const trigger = page.getByRole('button', { name: /setup tools/i });
    await expect(trigger).toBeFocused();
  });

  test('theme radio buttons are rendered for all built-in themes', async ({ page }) => {
    const radios = page.locator('input[name="theme"]');
    const count = await radios.count();
    // 6 named themes + 1 system = 7
    expect(count).toBe(7);
  });

  test('selecting Light theme changes data-theme on <html>', async ({ page }) => {
    await selectTheme(page, 'light');
    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(attr).toBe('light');
  });

  test('theme selection round-trip: dark → nord → dark', async ({ page }) => {
    await selectTheme(page, 'nord');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');

    await selectTheme(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('Theme persistence', () => {
  test('selected theme persists across page reload', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await selectTheme(page, 'solarized');
    await closeWithDone(page);

    await page.reload();
    await page.waitForLoadState('networkidle');

    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(attr).toBe('solarized');
  });
});
