/**
 * ces-tooltip-arcs.spec.ts — the arcs of a machine's CES graph are visible on
 * the tooltip panel under a light theme (RealityEngine_Manager#253).
 *
 * The arcs were drawn — every `<line>` joined, placed and given an arrowhead —
 * in '#e2e8f0', which is the Light theme's panel ground `--re-bg-3` exactly. At
 * 1.00:1 no arc or arrowhead showed under Light, or under System with the OS in
 * light mode, while the event nodes did. The unit test now measures every
 * theme's panel; this one measures what a browser actually paints, in the
 * running app, against a real machine.
 *
 * Fall Detection is the subject: 20 events and 13 transitions in the corpus.
 * Its node can sit outside the visible area of the force layout, so the test
 * pans the canvas to it before hovering, the way an operator would.
 */

import { test, expect, type Page } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';
const MACHINE = 'machine-falldetection';
/** The graph's transitions; the strips' separator lines sit outside `g.tt-graph`. */
const ARCS = 'g.tt-graph line';

type RGB = [number, number, number];
const rgb = (s: string): RGB => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as RGB;
const lum = ([r, g, b]: RGB) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** WCAG contrast of `fg` at `alpha`, composited over `bg`. */
const contrast = (fg: RGB, bg: RGB, alpha = 1) => {
  const over = fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as RGB;
  const [a, b] = [lum(over), lum(bg)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};

async function nodeCenter(page: Page) {
  return page.locator('g.node').evaluateAll((els, id) => {
    const el = els.find(e => (e as unknown as { __data__?: { id?: string } }).__data__?.id === id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, MACHINE);
}

async function openFallDetectionTooltip(page: Page) {
  await page.goto(VIZ_URL);
  await page.getByRole('button', { name: /Interconnect/i }).click();
  await page.locator('g.node').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3_000);   // let the force layout settle

  let c = await nodeCenter(page);
  test.skip(!c, `${MACHINE} is not in the loaded corpus`);

  // Pan by dragging empty canvas until the node is mid-screen.
  const canvas = (await page.locator('svg').first().boundingBox())!;
  const vp = page.viewportSize()!;
  const sx = canvas.x + 30, sy = canvas.y + canvas.height - 30;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (vp.width / 2 - c!.x), sy + (vp.height / 2 - c!.y), { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  // The layout can still be drifting, so a hover that misses is re-aimed.
  const tip = page.locator('.mgv-tooltip');
  for (let attempt = 0; attempt < 4 && !(await tip.isVisible()); attempt++) {
    c = await nodeCenter(page);
    await page.mouse.move(5, 5);
    await page.mouse.move(c!.x, c!.y, { steps: 5 });
    await tip.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
  }
  await expect(tip).toBeVisible();
  await expect(tip.locator(ARCS).first()).toBeAttached({ timeout: 10_000 });
  return tip;
}

async function measure(page: Page) {
  return page.locator('.mgv-tooltip').evaluate((tip, arcs) => {
    const cs = (e: Element) => getComputedStyle(e);
    return {
      panel: cs(tip).backgroundColor,
      arcs: Array.from(tip.querySelectorAll(arcs)).map(e => ({
        stroke: cs(e).stroke,
        alpha: Number(cs(e).strokeOpacity) * Number(cs(e).opacity || 1),
      })),
      heads: Array.from(tip.querySelectorAll('marker path')).map(e => cs(e).fill),
    };
  }, ARCS);
}

for (const { name, theme } of [
  { name: 'Light', theme: 'light' },
  { name: 'System, with the OS in light mode', theme: 'system' },
]) {
  test.describe(`CES tooltip arcs under ${name} (#253)`, () => {
    test.use({ colorScheme: 'light', viewport: { width: 1600, height: 1000 } });

    test('every arc and arrowhead holds 3:1 against the panel', async ({ page }) => {
      await page.addInitScript(t => { try { localStorage.setItem('re-viz-theme', t); } catch { /* */ } }, theme);
      await openFallDetectionTooltip(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

      const m = await measure(page);
      const panel = rgb(m.panel);
      expect(m.arcs.length, 'Fall Detection declares 13 transitions').toBe(13);
      for (const a of m.arcs) {
        expect(contrast(rgb(a.stroke), panel, a.alpha), `arc ${a.stroke} on ${m.panel}`)
          .toBeGreaterThanOrEqual(3);
      }
      for (const h of m.heads) {
        expect(contrast(rgb(h), panel), `arrowhead ${h} on ${m.panel}`).toBeGreaterThanOrEqual(3);
      }
    });
  });
}
