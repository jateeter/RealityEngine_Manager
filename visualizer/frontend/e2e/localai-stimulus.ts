import { expect, type APIRequestContext } from '@playwright/test';

/**
 * localAIStack's part in a cross-engine comparison (RealityEngine_CI#518), the
 * same as RealityEngine_CI's tree-to-pe-manager-equivalence spec does it.
 *
 * - One retrieval per engine under test, addressed to that engine alone
 *   (`X-RE-Instance`), so every engine is given the same retrieval stimulus.
 * - Sources localAIStack removed on its own schedule, recorded durably by it
 *   (`/observations/removals`, kept for K-line support), are set aside where
 *   some engines still hold them and others no longer do.
 */
const REGISTRY_URL = process.env.RE_REGISTRY_URL ?? 'http://127.0.0.1:5999/re-registry.json';

export async function localAIUrl(request: APIRequestContext): Promise<string | null> {
  try {
    const res = await request.get(REGISTRY_URL);
    if (!res.ok()) return null;
    const url = (await res.json())?.services?.localai_api?.url;
    return typeof url === 'string' && url ? url : null;
  } catch {
    return null;
  }
}

/** One retrieval addressed to `engineId`; false where no localAIStack runs. */
export async function retrieveOnce(request: APIRequestContext, engineId: string): Promise<boolean> {
  const url = await localAIUrl(request);
  if (!url) return false;
  const res = await request.post(`${url}/rag/retrieve`, {
    data: { question: 'How does the Reality Engine perceive a source?' },
    headers: { 'Content-Type': 'application/json', 'X-RE-Instance': engineId },
  });
  expect(res.ok(), `retrieval addressed to ${engineId} failed: ${res.status()}`).toBeTruthy();
  return true;
}

/** Source names localAIStack recorded as removed that are not on every engine now. */
export async function removedOnSchedule(
  request: APIRequestContext,
  presentOn: ReadonlyArray<ReadonlySet<string>>,
): Promise<Set<string>> {
  const url = await localAIUrl(request);
  if (!url) return new Set();
  const res = await request.get(`${url}/observations/removals?limit=1000`);
  if (!res.ok()) return new Set();
  const recorded: string[] = ((await res.json()).removals ?? [])
    .filter((r: any) => r.kind === 'source' && typeof r.observed?.name === 'string')
    .map((r: any) => r.observed.name as string);
  return new Set(recorded.filter(name => !presentOn.every(set => set.has(name))));
}
