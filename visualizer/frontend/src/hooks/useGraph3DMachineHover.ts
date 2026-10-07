/**
 * The hover → sequence-tooltip glue for `Graph3DView` in `mode="machines"` (#90).
 *
 * `Graph3DView` suppresses the 3d-force-graph built-in label and delegates
 * hover presentation to its parent through `onMachineHover`. That is a
 * reasonable split — the tooltip needs the parent's machine list, its
 * `/api/machines/:id/export` cache and its `<SequenceTooltip>` — but it made a
 * missing prop indistinguishable from "3D has no tooltips", and two of the
 * three call sites had in fact never wired it. Toggling to 3D simply lost the
 * feature, silently.
 *
 * Two changes close that. `Graph3DView`'s props now *require* the callback in
 * machines mode, so a new call site cannot omit it without a type error — an
 * opt-out has to be written down. And the callback body lives here rather than
 * being copied per call site, because it was already a three-way copy waiting
 * to drift.
 *
 * ## What the glue actually does
 *
 * - **Debounces on both edges.** A 160ms open delay keeps the tooltip from
 *   strobing as the cursor crosses spheres; a 220ms close delay lets the
 *   pointer travel from a sphere onto the tooltip panel without it vanishing
 *   underneath. The asymmetry is deliberate: leaving is the one that needs the
 *   longer grace.
 * - **Passes the pointer through in viewport coordinates.** `onMachineHover`
 *   forwards raw `clientX/clientY` from the WebGL canvas, and the tooltip is a
 *   viewport-placed `FloatingTooltip` (#248), so they go through unchanged.
 *   Keeping the panel clear of the cursor and on screen is the placement's job,
 *   the same for 2D and 3D. This used to subtract the container rect and add
 *   `+14 / -10`, which put the anchor in a different frame from the clamp.
 * - **Never dismisses a pinned tooltip.** A pinned panel is the operator's
 *   explicit request to keep it open; hover-out must not override that.
 */

import { useCallback, useEffect } from 'react';
import type { RefObject } from 'react';

/** Open delay, ms — long enough that crossing a sphere does not open a panel. */
const OPEN_MS = 160;
/** Close delay, ms — long enough to move the cursor onto the tooltip itself. */
const CLOSE_MS = 220;

/** Fallback anchor inside the container when the pointer is unknown. */
const FALLBACK_X = 20;
const FALLBACK_Y = 70;

export interface Graph3DMachineHoverOptions {
  /** The graph container; anchors the fallback when the pointer is unknown. */
  containerRef: RefObject<HTMLElement | null>;
  /** Shared debounce handle. Also cleared on unmount. */
  timerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  /**
   * Opens the tooltip. Held in a ref by every call site because the 3D view
   * captures the callback once and the opener closes over changing state.
   */
  showTooltipRef: RefObject<(id: string, name: string, x: number, y: number) => void>;
  /** Machine id → display name. Returning undefined suppresses the tooltip. */
  machineName: (machineId: string) => string | undefined;
  /** Dismiss, unless the operator pinned the panel. */
  dismiss: () => void;
}

export type Graph3DMachineHoverHandler = (
  machineId: string | null,
  clientX?: number,
  clientY?: number,
) => void;

export function useGraph3DMachineHover(
  opts: Graph3DMachineHoverOptions,
): Graph3DMachineHoverHandler {
  const { containerRef, timerRef, showTooltipRef, machineName, dismiss } = opts;

  // A pending timer outliving the component would fire into an unmounted tree.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [timerRef]);

  return useCallback((machineId, clientX, clientY) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!machineId) {
      timerRef.current = setTimeout(dismiss, CLOSE_MS);
      return;
    }

    const name = machineName(machineId);
    // An id the parent does not know about: leave whatever is showing alone
    // rather than opening a panel with no content behind it.
    if (name === undefined) return;

    let x = clientX;
    let y = clientY;
    if (x === undefined || y === undefined) {
      const rect = containerRef.current?.getBoundingClientRect();
      x = (rect?.left ?? 0) + FALLBACK_X;
      y = (rect?.top ?? 0) + FALLBACK_Y;
    }

    const anchorX = x;
    const anchorY = y;
    timerRef.current = setTimeout(() => {
      showTooltipRef.current(machineId, name, anchorX, anchorY);
    }, OPEN_MS);
  }, [containerRef, timerRef, showTooltipRef, machineName, dismiss]);
}

export default useGraph3DMachineHover;
