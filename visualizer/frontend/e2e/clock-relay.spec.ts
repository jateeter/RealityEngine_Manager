import { test, expect, type APIResponse, type Page } from '@playwright/test';

/**
 * The Manager relays the Lamport clock and the Visualizer shows it
 * (RealityEngine_Manager#293, RealityEngine_CI#600 SURFACE_SPEC "The instance clock").
 *
 * - A request through the Manager's PE proxy keeps its `RE-Clock`: the active
 *   PE receives it (its lamport jumps past an injection) and the PE's own
 *   `RE-Clock` comes back unchanged. A malformed header is the PE's 400, with
 *   the PE's clock.
 * - The Visualizer reflects the jump: after the injection, one push commits a
 *   PE step, and the engine switcher's clock line shows the PE's committed
 *   lamport past the injected value.
 *
 * Resolves the active engine through the Manager (GET /api/engines); skips with
 * the reason when the engine predates #600.
 */

const HEADER = /^instance=([0-9a-f-]{36}); lamport=(\d+)$/;
const JUMP = 1_000_000;
const PROBE_INSTANCE = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';

function stamped(r: APIResponse): { instance: string; lamport: number } {
  const value = r.headers()['re-clock'];
  expect(value, 'the reply carries the PE\'s RE-Clock').toBeTruthy();
  const m = HEADER.exec(value!);
  expect(m, `RE-Clock "${value}"`).not.toBeNull();
  return { instance: m![1], lamport: Number(m![2]) };
}

async function activePe(page: Page): Promise<{ id: string; peInstance: string }> {
  const engines = await (await page.request.get('/api/engines')).json() as { activeId?: string };
  const id = engines.activeId ?? '';
  const clocks = await (await page.request.get(`/api/engine/${encodeURIComponent(id)}/clock`)).json() as
    { pe?: { instance?: string } | null };
  test.skip(!clocks.pe?.instance, `the active engine ${id || '<none>'} reports no PE clock (predates RealityEngine_CI#600)`);
  return { id, peInstance: clocks.pe!.instance! };
}

/** GET a PE route through the Manager, presenting a clock: never answered from cache. */
function viaManager(page: Page, lamport: number | string) {
  const value = typeof lamport === 'number' ? `instance=${PROBE_INSTANCE}; lamport=${lamport}` : lamport;
  return page.request.get('/api/pe/triggers/status', { headers: { 'RE-Clock': value } });
}

test.describe('Lamport clock through the Manager (#293)', () => {
  test('a request through the PE proxy keeps its RE-Clock both ways', async ({ page }) => {
    const { peInstance } = await activePe(page);

    const first = await viaManager(page, 1);
    expect(first.status()).toBe(200);
    const before = stamped(first);
    expect(before.instance, 'the relayed clock is the active PE\'s').toBe(peInstance);

    const injected = before.lamport + JUMP;
    const jumped = await viaManager(page, injected);
    expect(jumped.status()).toBe(200);
    expect(stamped(jumped).lamport, 'the PE received the relayed header: past the injection')
      .toBeGreaterThan(injected);

    const refused = await viaManager(page, 'instance=not-a-uuid; lamport=1');
    expect(refused.status(), 'a malformed header is the PE\'s 400').toBe(400);
    expect(stamped(refused).lamport, 'the 400 carries the PE\'s clock, still past the injection')
      .toBeGreaterThan(injected);
  });

  test('the engine switcher reflects an injected clock jump', async ({ page }) => {
    const { id } = await activePe(page);
    const injected = stamped(await viaManager(page, 1)).lamport + JUMP;
    expect(stamped(await viaManager(page, injected)).lamport).toBeGreaterThan(injected);
    // One push commits a PE step at a lamport past the injection; the clock
    // routes report the committed step.
    expect((await page.request.post('/api/pe/push', { data: { compact: true } })).ok()).toBe(true);

    await page.goto('/');
    await page.getByTitle('Switch active engine instance').click();
    const line = page.getByTestId(`engine-clock-${id}`);
    await expect.poll(async () => {
      const m = /PE L (\d+)/.exec((await line.textContent()) ?? '');
      return m ? Number(m[1]) : 0;
    }, { message: `the ${id} clock line shows the PE's committed lamport past ${injected}`, timeout: 15_000 })
      .toBeGreaterThan(injected);
  });
});
