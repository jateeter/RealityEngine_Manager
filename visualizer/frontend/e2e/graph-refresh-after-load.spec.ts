/**
 * graph-refresh-after-load.spec.ts — the directed graph shows a machine as
 * soon as it is loaded, with no page reload (RealityEngine_Manager#307).
 *
 * Before #307 the graph fetched /api/machine-graph on mount and on an engine
 * switch only, so a machine loaded through the Load Machines modal appeared in
 * the tree but never in the graph until the page was reloaded.
 *
 * The spec loads one corpus machine that NO engine holds, through the modal,
 * into every engine, with the graph on screen. It then removes that machine
 * from every engine, and the test source its load interned on every PE
 * (#304), so the shared universe is left as booted: a machine left behind
 * changes what every later spec compares (see load-machines-modal.spec.ts).
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

interface Instance { id: string }
interface TreeNode { machines?: Array<{ name: string; relFile: string }>; children?: TreeNode[] }

const on = (id: string) => ({ headers: { 'X-RE-Instance': id } });

let loadedName: string | null = null;
let instances: Instance[] = [];

async function machineIdOn(request: APIRequestContext, inst: string, name: string): Promise<string | null> {
  const r = await request.get(`${VIZ_URL}/api/machines`, on(inst));
  if (!r.ok()) return null;
  const machines: Array<{ id: string; name: string }> = (await r.json()).machines ?? [];
  return machines.find(m => m.name === name)?.id ?? null;
}

async function graphNodeIds(page: Page): Promise<string[]> {
  return page.locator('svg.machine-graph-svg g.node').evaluateAll(els =>
    els.map(e => (e as unknown as { __data__?: { id?: string } }).__data__?.id ?? '').filter(Boolean));
}

test.afterEach(async ({ request }) => {
  if (!loadedName) return;
  for (const i of instances) {
    const id = await machineIdOn(request, i.id, loadedName);
    if (!id) continue;
    const s = await request.get(`${VIZ_URL}/api/pe/sources`, on(i.id));
    if (s.ok()) {
      const body = await s.json();
      for (const src of (body.sources ?? body) as Array<{ id: string; type: string; machineId?: string }>) {
        if (src.type === 'test' && src.machineId === id) {
          await request.delete(`${VIZ_URL}/api/pe/sources/${src.id}`, on(i.id)).catch(() => {});
        }
      }
    }
    await request.delete(`${VIZ_URL}/api/machines/${id}`, on(i.id)).catch(() => {});
  }
  loadedName = null;
});

test('a machine loaded through the modal appears in the graph without a reload', async ({ page, request }) => {
  test.setTimeout(180_000);

  const engines = await request.get(`${VIZ_URL}/api/engines`);
  test.skip(!engines.ok(), 'not-configured: the Manager has no instance registry');
  instances = (await engines.json()).instances ?? [];
  test.skip(instances.length === 0, 'not-configured: the instance registry lists no engine');

  // A corpus machine no engine holds.
  const tree = await (await request.get(`${VIZ_URL}/api/corpus/tree`)).json() as { tree?: TreeNode[] };
  const corpus: string[] = [];
  const walk = (n: TreeNode) => { for (const m of n.machines ?? []) corpus.push(m.name); (n.children ?? []).forEach(walk); };
  (tree.tree ?? []).forEach(walk);
  const held = new Set<string>();
  for (const i of instances) {
    const r = await request.get(`${VIZ_URL}/api/machines`, on(i.id));
    for (const m of ((await r.json()).machines ?? []) as Array<{ name: string }>) held.add(m.name);
  }
  const name = corpus.find(n => !held.has(n));
  test.skip(!name, 'every corpus machine is already loaded on some engine');

  // The graph on screen, before the load.
  await page.goto(VIZ_URL);
  await page.locator('svg.machine-graph-svg g.node').first().waitFor({ timeout: 30_000 });
  const before = await graphNodeIds(page);

  // Load it through the modal, into every engine.
  await page.getByRole('button', { name: /Setup tools/i }).click();
  await page.getByRole('menuitem', { name: /Load Machines/i }).click();
  await page.waitForSelector('.lmm-modal', { timeout: 10_000 });
  await page.locator('.lmm-filter').fill(name!);
  const row = page.locator('.lmm-machine').filter({
    has: page.locator('.lmm-machine-name', { hasText: name! }),
  }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('input[type="checkbox"]').check();
  if (await page.getByText(/^All \d+ engines$/).count() > 0) {
    await page.locator('.lmm-bootstrap input[type="checkbox"]').last().check();
  }
  loadedName = name!;
  await page.locator('.lmm-load-btn').click();
  await expect(page.locator('.lmm-summary')).toContainText(/Loaded 1/, { timeout: 120_000 });

  // The active engine's id for it, and the graph showing it — no reload.
  const active = (await (await request.get(`${VIZ_URL}/api/engines`)).json()).activeId as string;
  const id = await machineIdOn(request, active, name!);
  expect(id, `${name} is not on the active engine ${active} after the load`).toBeTruthy();
  await expect.poll(async () => (await graphNodeIds(page)).includes(id!), {
    message: `graph never showed ${name} (${id}) after the load`,
    timeout: 30_000,
  }).toBe(true);

  // Nothing that was on screen went missing.
  const after = new Set(await graphNodeIds(page));
  expect(before.filter(n => !after.has(n))).toEqual([]);
});
