/**
 * Run `onSwitch` when the operator switches the active engine (#250).
 *
 * `EngineSwitcher` announces a switch with a `re:engine-switched` window event
 * and does not reload the page, so anything a view keyed by machine id or
 * collected from the previous engine's steps outlives the switch unless the view
 * drops it: the export cache, an open or pinned CES tooltip, the last step. The
 * localAI machines carry a different id on each engine, so a cached or pinned id
 * from one engine is "Machine not found" on the next.
 *
 * Returns the id of the engine last switched to (null until the first switch),
 * so a step handler can drop a frame the previous engine sent while the switch
 * was in flight. The backend tags every step with the `engineId` it came from.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export const ENGINE_SWITCHED_EVENT = 're:engine-switched';

export function useOnEngineSwitch(onSwitch: (engineId: string | null) => void): RefObject<string | null> {
  const activeEngineRef = useRef<string | null>(null);
  const onSwitchRef = useRef(onSwitch);
  useEffect(() => { onSwitchRef.current = onSwitch; }, [onSwitch]);

  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id ?? null;
      activeEngineRef.current = id;
      onSwitchRef.current(id);
    };
    window.addEventListener(ENGINE_SWITCHED_EVENT, handler);
    return () => window.removeEventListener(ENGINE_SWITCHED_EVENT, handler);
  }, []);

  return activeEngineRef;
}

/** True when a step frame came from an engine other than the one switched to. */
export function isStaleStep(frame: { engineId?: string | null }, activeEngineId: string | null): boolean {
  return !!frame.engineId && !!activeEngineId && frame.engineId !== activeEngineId;
}

export default useOnEngineSwitch;
