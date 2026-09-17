/**
 * engineBinding — which engine a single request is addressed to.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend keeps one process-global `activeEngineId`, and
 * `POST /api/engines/active` reassigns it. Every concurrent client therefore
 * shares one notion of "the" engine: a switch by one caller retargets requests
 * already in flight for another, and a response cache keyed only by path can
 * serve one engine's machines to a request meant for a different one.
 *
 * That is not hypothetical. Under parallel Playwright workers, specs that
 * switch the engine ran alongside specs reading /api/machines, and the suite's
 * pass count drifted 37 -> 32 -> 21 across three identical runs, presenting as
 * 17 "deterministic" failures and 8 that flipped. RealityEngine_Manager#156
 * pinned the suite to one worker to stop the bleeding and recorded that the
 * durable fix was per-request engine selection. This is that fix.
 *
 * `X-RE-Instance: <instance id>` names the engine a request is addressed to.
 * The binding is pinned for the whole request in an AsyncLocalStorage — Node's
 * analogue of the ContextVar localAIStack uses in `core/bridge_binding.py` for
 * the same reason. It is deliberately NOT a module variable: concurrent
 * requests addressed to different engines must not disturb each other, which
 * is the entire defect being fixed.
 *
 * A named instance that is not running resolves to NOTHING, never to a
 * substitute. Answering from whichever engine happens to be active is exactly
 * the cross-talk this prevents — the caller addressed a specific engine, and
 * silently substituting another makes the mismatch invisible at the call site
 * and downstream.
 *
 * This lives in its own module, apart from server.ts, because server.ts binds
 * ports on import and so cannot be unit tested — the same reason the rate
 * limiter was extracted, and the same reason the defect it carried went
 * unnoticed.
 */

import { AsyncLocalStorage } from 'async_hooks';

/** Lower-case: Node normalises incoming header names. */
export const RE_INSTANCE_HEADER = 'x-re-instance';

export interface EngineBinding {
  id: string;
  re_url: string;
  pe_url: string;
}

/** The subset of a registry instance this module needs. */
export interface BindableInstance {
  id: string;
  re_url: string;
  pe_url: string;
}

export type BindingResolution =
  | { kind: 'unbound' }
  | { kind: 'bound'; binding: EngineBinding }
  | { kind: 'invalid'; id: string }
  | { kind: 'unknown'; id: string; available: string[] };

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Decide what a request's instance header means, without performing any I/O.
 *
 * Pure so the four outcomes can be asserted directly: no header, a valid and
 * running instance, a malformed id, and an id that names nothing.
 */
export function resolveBinding(
  headerValue: string | string[] | undefined,
  instances: readonly BindableInstance[],
): BindingResolution {
  const id = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!id) return { kind: 'unbound' };
  if (!ID_RE.test(id)) return { kind: 'invalid', id };

  const inst = instances.find(i => i.id === id);
  if (!inst) return { kind: 'unknown', id, available: instances.map(i => i.id) };

  return {
    kind: 'bound',
    binding: { id: inst.id, re_url: inst.re_url, pe_url: inst.pe_url },
  };
}

const storage = new AsyncLocalStorage<EngineBinding>();

/** Run `fn` with this request pinned to `binding`. */
export function runBound(binding: EngineBinding, fn: () => void): void {
  storage.run(binding, fn);
}

/** The instance the current request is addressed to, or null when unbound. */
export function boundInstance(): EngineBinding | null {
  return storage.getStore() ?? null;
}

/**
 * Which instance a cache entry belongs to.
 *
 * Cache keys must be scoped by this: once requests can target different
 * engines, the path alone is not a sufficient key, and an unscoped hit is a
 * silent wrong answer that reads as an engine divergence.
 */
export function bindingScope(activeEngineId: string | null, fallback: string | undefined): string {
  const bound = boundInstance();
  if (bound) return bound.id;
  if (activeEngineId) return activeEngineId;
  return fallback ?? 'default';
}

/** `'cpp-1 machines:list'` — the stored form of a logical cache key. */
export function scopedKey(scope: string, key: string): string {
  return `${scope} ${key}`;
}

/** The logical key back out of a stored key, for prefix matching. */
export function unscope(storedKey: string): string {
  const sep = storedKey.indexOf(' ');
  return sep === -1 ? storedKey : storedKey.slice(sep + 1);
}
