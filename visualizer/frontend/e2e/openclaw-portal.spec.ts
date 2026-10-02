import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';
const REGISTRY_URL = process.env.RE_REGISTRY_URL ?? 'http://127.0.0.1:5999/re-registry.json';
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789';
// localOpenClawStack, a sibling of RealityEngine_Manager. Playwright runs from
// visualizer/frontend, so the workspace root is three levels up.
const OPENCLAW_DIR = process.env.OPENCLAW_DIR
  ?? path.resolve(process.cwd(), '..', '..', '..', 'localOpenClawStack');

/**
 * Everything here is derived from what the deployed engine loaded, never from
 * a particular corpus. This spec used to require a Health Services portal with
 * twenty mechanical buses and to filter on "Health Services", so it could pass
 * only against the full corpus and failed on every narrower one — the
 * regression corpus loads a single dispatcher domain. A universe may be started
 * on any corpus; what must hold on all of them is that each domain the engine
 * loaded dispatchers for has a portal, and that OpenClaw has the agents for the
 * machines the engine loaded.
 */

interface PortalData {
  id: string;
  domainId: string;
  domainLabel: string;
  dispatcherCount: number;
  busCount: number;
}

async function openGraph(page: Page): Promise<void> {
  await page.goto(VIZ_URL);
  await page.getByRole('button', { name: /Interconnect/i }).click();
  // `.machine-graph-svg` is MachineGraphView's svg, which the Interconnect
  // button renders (#153); `.graph-svg` belongs to the sibling component.
  await page.waitForSelector('svg.machine-graph-svg', { timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const svg = document.querySelector('svg.machine-graph-svg');
      const style = svg?.getAttribute('style') ?? '';
      return !!svg && (style.includes('opacity: 1') || !style.includes('opacity: 0'));
    },
    { timeout: 20_000 },
  );
}

async function portals(page: Page): Promise<PortalData[]> {
  return page.locator('g.node.openclaw-portal').evaluateAll(els => els.map(el => {
    const d = (el as unknown as { __data__?: any }).__data__ ?? {};
    const m = d.metadata ?? {};
    return {
      id: String(d.id ?? ''),
      domainId: String(m.domainId ?? d.domain ?? ''),
      domainLabel: String(m.domainLabel ?? ''),
      dispatcherCount: Number(m.dispatcherCount ?? 0),
      busCount: Array.isArray(m.buses) ? m.buses.length : 0,
    };
  }));
}

/** Domains the graph holds agent-dispatcher machines for — the portal rule. */
async function dispatcherDomains(page: Page): Promise<string[]> {
  const domains = await page.locator('g.node').evaluateAll(els => els
    .map(el => (el as unknown as { __data__?: any }).__data__ ?? {})
    .filter(d => d.role === 'agent-dispatcher')
    .map(d => String(d.domain ?? 'general')));
  return [...new Set(domains)].sort();
}

async function engineMachineNames(request: APIRequestContext): Promise<string[]> {
  const reg = await request.get(REGISTRY_URL);
  expect(reg.ok(), `instance registry unreachable at ${REGISTRY_URL}`).toBeTruthy();
  const instances = ((await reg.json()) as { instances?: Array<{ re_url?: string }> }).instances ?? [];
  expect(instances.length, 'the instance registry lists no engine').toBeGreaterThan(0);
  const res = await request.get(`${instances[0].re_url}/api/machines`);
  expect(res.ok(), `GET ${instances[0].re_url}/api/machines`).toBeTruthy();
  const body = await res.json() as any;
  const list: Array<{ name?: string }> = Array.isArray(body) ? body : (body.machines ?? []);
  return list.map(m => String(m.name ?? '')).filter(Boolean);
}

test.describe('OpenClaw Domain Portals', () => {
  test.beforeEach(async ({ page }) => { await openGraph(page); });

  test('a portal node exists for exactly the domains the engine loaded dispatchers for', async ({ page }) => {
    const expected = await dispatcherDomains(page);
    test.skip(expected.length === 0,
      'the loaded corpus has no agent-dispatcher machines, so no portal is expected');

    await expect(page.locator('g.node.openclaw-portal').first()).toBeVisible({ timeout: 20_000 });
    const found = await portals(page);
    for (const p of found) {
      expect(p.id, `portal node has an unexpected id: ${p.id}`).toMatch(/^__openclaw_portal_[a-z]+__$/);
      expect(p.dispatcherCount, `${p.id} carries no dispatchers`).toBeGreaterThan(0);
    }
    expect(found.map(p => p.domainId).sort(),
      `one portal per dispatcher domain; dispatcher domains ${JSON.stringify(expected)}`)
      .toEqual(expected);
  });

  test('portal node tooltip shows dispatchers and the ACP completion region', async ({ page }) => {
    const portalGroup = page.locator('g.node.openclaw-portal').first();
    test.skip(await portalGroup.count() === 0, 'the loaded corpus has no portal');

    await portalGroup.hover();
    const tooltip = page.locator('.portal-tooltip');
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    await expect(tooltip).toContainText('OpenClaw Portal');
    await expect(tooltip).toContainText('ACP Dispatchers');
    await expect(tooltip).toContainText('PS[4210');
  });

  test('portal tooltip lists mechanical buses exactly when its domain has them', async ({ page }) => {
    const found = await portals(page);
    test.skip(found.length === 0, 'the loaded corpus has no portal');

    // Both directions, on whichever portals this corpus produced: a domain with
    // interconnects lists them, and one without says nothing about buses.
    for (const p of found) {
      const group = page.locator('g.node.openclaw-portal').nth(found.indexOf(p));
      await group.hover();
      const tooltip = page.locator('.portal-tooltip');
      await expect(tooltip).toBeVisible({ timeout: 2000 });
      if (p.busCount > 0) {
        await expect(tooltip, `${p.domainLabel} has ${p.busCount} bus(es)`).toContainText('Mechanical Bus');
      } else {
        await expect(tooltip, `${p.domainLabel} has no buses`).not.toContainText('Mechanical Bus');
      }
      await page.mouse.move(0, 0);
    }
  });

  test('a portal node dims when its domain is filtered out', async ({ page }) => {
    const found = await portals(page);
    test.skip(found.length === 0, 'the loaded corpus has no portal');
    const target = found[0];

    await page.getByRole('button', { name: /LEGEND/i }).click();
    // The domain filter is a checkbox inside label.vis-legend-domain-row.
    const row = page.locator('.vis-legend-domain-row', { hasText: target.domainLabel }).first();
    await expect(row, `no legend row for ${target.domainLabel}`).toBeVisible({ timeout: 10_000 });
    await row.locator('input[type="checkbox"]').click();

    // Addressed by id rather than position: DOM order is the simulation's.
    const ids = (await portals(page)).map(p => p.id);
    const node = page.locator('g.node.openclaw-portal').nth(ids.indexOf(target.id));
    await expect.poll(
      async () => parseFloat(await node.evaluate(el => window.getComputedStyle(el).opacity || '1')),
      { timeout: 10_000 },
    ).toBeLessThan(0.5);
  });

  test('no stale global openclaw node outside domain hulls', async ({ page }) => {
    const textContent = await page.locator('svg text').allTextContents();
    expect(textContent.some(t => t === 'xACP Gateway')).toBe(false);
    const ids = await page.locator('g.node').evaluateAll(els =>
      els.map(el => String((el as unknown as { __data__?: { id?: string } }).__data__?.id ?? '')));
    expect(ids, 'the retired global gateway node is still in the graph').not.toContain('__openclaw__');
  });
});

test.describe('OpenClaw agents for the engine\'s machine corpus', () => {
  /**
   * The agents OpenClaw must have are the ones bound to the machines the engine
   * actually loaded — not the whole agent corpus, and not a fixed profile.
   * Other agents may be loaded too (`main`, or a wider profile); that is fine.
   * A loaded machine whose agent is missing is not.
   *
   * Machine → agent comes from the agent corpus index; machines with no entry
   * (arbitration fixtures, localAIStack's own machines) carry no agent by rule.
   * The loaded set is OpenClaw's live config, the same file start.sh counts.
   */
  test('every agent bound to a loaded machine is loaded in OpenClaw and the gateway answers', async ({ request }) => {
    const health = await request.get(`${OPENCLAW_GATEWAY_URL}/healthz`).catch(() => null);
    test.skip(!health || !health.ok(), `OpenClaw is not deployed (no gateway at ${OPENCLAW_GATEWAY_URL})`);

    const indexPath = path.join(OPENCLAW_DIR, 'machine-behaviors', 'agents', 'INDEX.json');
    const configPath = path.join(OPENCLAW_DIR, 'openclaw', 'openclaw.json');
    expect(fs.existsSync(indexPath), `agent corpus index not found at ${indexPath}`).toBeTruthy();
    expect(fs.existsSync(configPath), `OpenClaw live config not found at ${configPath}`).toBeTruthy();

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      agents: Array<{ machineName: string; agentId: string }>;
    };
    const agentFor = new Map(index.agents.map(a => [a.machineName, a.agentId]));
    const loaded = new Set(
      ((JSON.parse(fs.readFileSync(configPath, 'utf8')) as any).agents?.list ?? [])
        .map((a: { id?: string }) => String(a.id ?? '')),
    );

    const machines = await engineMachineNames(request);
    const required = machines.filter(n => agentFor.has(n)).map(n => ({ machine: n, agent: agentFor.get(n)! }));
    expect(required.length, `none of the engine's ${machines.length} machines has an agent in the index`)
      .toBeGreaterThan(0);

    const missing = required.filter(r => !loaded.has(r.agent));
    expect(missing,
      `${missing.length} of ${required.length} machine-corpus agents are not loaded in OpenClaw ` +
      `(${loaded.size} loaded): ${missing.map(m => `${m.agent} (${m.machine})`).join(', ')}`)
      .toEqual([]);
  });
});
