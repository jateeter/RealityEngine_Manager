/**
 * corpus-load-interns-sequences.spec.ts — a machine or domain load interns the
 * loaded machines' test sequences as sources on the PE paired with every RE
 * the load reached (RealityEngine_Manager#304).
 *
 * Before #304 the PE interned a machine's inputSequences only at its own boot,
 * so a machine loaded afterwards never appeared in the PE view, and the
 * opt-in "bootstrap" reached only the active PE.
 *
 * The spec leaves the universe as booted: it picks a corpus machine every
 * engine already holds, removes that machine's interned test source from each
 * PE, and loads the machine again through POST /api/corpus/load. The RE skips
 * it (already resident), and the load must put the source back on each PE.
 * Engines come from the Manager's view of the instance registry.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const VIZ_URL = process.env.VIZ_FRONTEND_URL ?? 'http://localhost:5173';

interface Instance { id: string; runtime?: string }
interface Machine { id: string; name: string; metadata?: { inputSequences?: unknown[] } }
interface Source { id: string; type: string; machineId?: string }

const on = (id: string) => ({ headers: { 'X-RE-Instance': id } });

async function machinesOf(request: APIRequestContext, inst: string): Promise<Machine[]> {
  const r = await request.get(`${VIZ_URL}/api/machines`, on(inst));
  expect(r.ok(), `GET /api/machines on ${inst}: ${r.status()}`).toBeTruthy();
  return (await r.json()).machines ?? [];
}

async function testSourcesFor(request: APIRequestContext, inst: string, machineId: string): Promise<Source[]> {
  const r = await request.get(`${VIZ_URL}/api/pe/sources`, on(inst));
  expect(r.ok(), `GET /api/pe/sources on ${inst}: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  const sources: Source[] = body.sources ?? body;
  return sources.filter(s => s.type === 'test' && s.machineId === machineId);
}

test('a corpus load interns the loaded machine\'s test sequences on every engine\'s PE', async ({ request }) => {
  test.setTimeout(120_000);

  const engines = await request.get(`${VIZ_URL}/api/engines`);
  test.skip(!engines.ok(), 'not-configured: the Manager has no instance registry');
  const instances: Instance[] = (await engines.json()).instances ?? [];
  test.skip(instances.length === 0, 'not-configured: the instance registry lists no engine');

  const tree = await request.get(`${VIZ_URL}/api/corpus/tree`);
  test.skip(!tree.ok(), 'corpus tree endpoint unavailable');
  const corpusNames = new Set<string>();
  const walk = (n: any) => { for (const m of n.machines ?? []) corpusNames.add(m.name); (n.children ?? []).forEach(walk); };
  ((await tree.json()).tree ?? []).forEach(walk);

  // A corpus machine with test sequences that every engine holds.
  const perEngine = new Map<string, Machine[]>();
  for (const i of instances) perEngine.set(i.id, await machinesOf(request, i.id));
  const candidate = perEngine.get(instances[0].id)!.find(m =>
    corpusNames.has(m.name) &&
    (m.metadata?.inputSequences?.length ?? 0) > 0 &&
    instances.every(i => perEngine.get(i.id)!.some(x => x.name === m.name)));
  test.skip(!candidate, 'no corpus machine with inputSequences is resident on every engine');
  const name = candidate!.name;
  const idOn = (inst: string) => perEngine.get(inst)!.find(m => m.name === name)!.id;

  // Remove its interned source from every PE.
  for (const i of instances) {
    for (const s of await testSourcesFor(request, i.id, idOn(i.id))) {
      const d = await request.delete(`${VIZ_URL}/api/pe/sources/${s.id}`, on(i.id));
      expect(d.ok(), `DELETE source ${s.id} on ${i.id}: ${d.status()}`).toBeTruthy();
    }
    expect(await testSourcesFor(request, i.id, idOn(i.id))).toHaveLength(0);
  }

  // Load it again, on every engine, with the default (interning on).
  const load = await request.post(`${VIZ_URL}/api/corpus/load`, {
    data: { machineIds: [name], allEngines: true },
  });
  expect(load.ok(), `POST /api/corpus/load: ${load.status()}`).toBeTruthy();
  const result = await load.json();
  expect(result.failed).toBe(0);
  expect(result.engines).toHaveLength(instances.length);
  for (const e of result.engines) {
    expect(e.peBootstrap?.error, `${e.engine}: PE interning failed`).toBeUndefined();
    expect(e.peBootstrap?.created ?? 0, `${e.engine}: PE interned nothing`).toBeGreaterThanOrEqual(1);
  }

  // Every PE holds the machine's test source again, under its own engine's id.
  for (const i of instances) {
    expect(await testSourcesFor(request, i.id, idOn(i.id)),
      `${i.id}: no test source for ${name} (${idOn(i.id)})`).toHaveLength(1);
  }
});
