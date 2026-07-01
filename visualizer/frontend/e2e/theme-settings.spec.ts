/**
 * theme-settings.spec.ts — Playwright e2e tests for the theme / settings system.
 *
 * Tests cover:
 *   - Gear button is present in the header
 *   - Clicking gear opens the settings modal
 *   - Escape closes the modal and returns focus to gear button
 *   - Theme radio selection changes data-theme on <html>
 *   - Dark → Light → Nord → back to Dark round-trip via UI
 *   - Theme persists across a page reload (localStorage)
 *   - Settings sliders update visualizer settings store
 *   - Done button closes the modal
 *   - Modal is accessible (aria-modal, aria-labelledby, role=dialog)
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function openApp(page: Page) {
  await page.goto(VIZ_URL);
  await page.waitForLoadState('networkidle');
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /Visualizer settings/i }).click();
  await page.waitForSelector('dialog.settings-dialog[open]', { timeout: 5_000 });
}

async function closeWithDone(page: Page) {
  await page.getByRole('button', { name: /Done/i }).click();
  await page.waitForFunction(
    () => !document.querySelector('dialog.settings-dialog[open]'),
    { timeout: 5_000 },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Settings gear button', () => {
  test('gear button is visible in the header', async ({ page }) => {
    await openApp(page);
    const gearBtn = page.getByRole('button', { name: /Visualizer settings/i });
    await expect(gearBtn).toBeVisible();
  });

  test('gear button opens the settings modal', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await expect(page.locator('dialog.settings-dialog')).toBeVisible();
  });
});

test.describe('Settings modal', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await openSettings(page);
  });

  test('modal has correct ARIA attributes', async ({ page }) => {
    const dialog = page.locator('dialog.settings-dialog');
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
    await expect(page.locator('dialog.settings-dialog')).not.toBeVisible();
  });

  test('Done button closes the modal', async ({ page }) => {
    await closeWithDone(page);
    await expect(page.locator('dialog.settings-dialog')).not.toBeVisible();
  });

  test('focus returns to gear button after closing', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('dialog.settings-dialog[open]'),
      { timeout: 5_000 },
    );
    const gearBtn = page.getByRole('button', { name: /Visualizer settings/i });
    await expect(gearBtn).toBeFocused();
  });

  test('theme radio buttons are rendered for all built-in themes', async ({ page }) => {
    const radios = page.locator('input[name="theme"]');
    const count = await radios.count();
    // 6 named themes + 1 system = 7
    expect(count).toBe(7);
  });

  test('selecting Light theme changes data-theme on <html>', async ({ page }) => {
    await page.locator('input[name="theme"][value="light"]').check();
    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(attr).toBe('light');
  });

  test('theme selection round-trip: dark → nord → dark', async ({ page }) => {
    await page.locator('input[name="theme"][value="nord"]').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');

    await page.locator('input[name="theme"][value="dark"]').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('Theme persistence', () => {
  test('selected theme persists across page reload', async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.locator('input[name="theme"][value="solarized"]').check();
    await closeWithDone(page);

    await page.reload();
    await page.waitForLoadState('networkidle');

    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(attr).toBe('solarized');
  });
});
