/**
 * Where a hover tooltip goes, given the pointer and the tooltip's measured size
 * (#248).
 *
 * Every coordinate here is a viewport coordinate (`clientX/clientY`), and the
 * result is meant for a `position: fixed` element. The node tooltips used to mix
 * frames: the anchor was container-relative while the clamp measured against
 * the window, so a panel clipped by its graph container was never corrected,
 * and when the window did trigger a correction it was applied in the wrong
 * frame. One frame, one function.
 *
 * Preference order, each tried only if the panel fits there whole:
 *   1. right of the pointer, then left of it; top edge near the pointer and
 *      shifted vertically into view;
 *   2. below the pointer, then above it; centred on the pointer and shifted
 *      horizontally into view;
 *   3. nothing fits whole: the side with the most room, clamped to the margins.
 * Steps 1 and 2 never put the panel under the pointer, so moving from the node
 * onto the panel cannot dismiss it. Step 3 only happens when the panel is larger
 * than the space on every side, which the panel's own max-width/max-height
 * (bounded by the viewport) keeps rare.
 */

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

export type TooltipSide = 'right' | 'left' | 'below' | 'above' | 'clamped';

export interface TooltipPlacement {
  left: number;
  top: number;
  side: TooltipSide;
}

export interface PlacementOptions {
  /** Gap between the pointer and the panel, px. */
  offset?: number;
  /** Minimum distance from every viewport edge, px. */
  margin?: number;
  /** How far above the pointer the panel's top edge starts on a side placement. */
  lift?: number;
}

const DEFAULT_OFFSET = 14;
const DEFAULT_MARGIN = 8;
const DEFAULT_LIFT = 10;

/** `v` limited to [lo, hi]; `lo` wins when the range is empty. */
function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : Math.min(Math.max(v, lo), hi);
}

export function placeTooltip(
  anchor: Point,
  size: Size,
  viewport: Size,
  opts: PlacementOptions = {},
): TooltipPlacement {
  const offset = opts.offset ?? DEFAULT_OFFSET;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const lift = opts.lift ?? DEFAULT_LIFT;
  const { width: w, height: h } = size;
  const { width: vw, height: vh } = viewport;

  const minLeft = margin;
  const maxLeft = vw - margin - w;
  const minTop = margin;
  const maxTop = vh - margin - h;

  const rightLeft = anchor.x + offset;
  const leftLeft = anchor.x - offset - w;
  const fitsWide = h <= vh - 2 * margin;
  if (fitsWide && rightLeft <= maxLeft) {
    return { left: rightLeft, top: clamp(anchor.y - lift, minTop, maxTop), side: 'right' };
  }
  if (fitsWide && leftLeft >= minLeft) {
    return { left: leftLeft, top: clamp(anchor.y - lift, minTop, maxTop), side: 'left' };
  }

  const belowTop = anchor.y + offset;
  const aboveTop = anchor.y - offset - h;
  const fitsTall = w <= vw - 2 * margin;
  if (fitsTall && belowTop <= maxTop) {
    return { left: clamp(anchor.x - w / 2, minLeft, maxLeft), top: belowTop, side: 'below' };
  }
  if (fitsTall && aboveTop >= minTop) {
    return { left: clamp(anchor.x - w / 2, minLeft, maxLeft), top: aboveTop, side: 'above' };
  }

  const roomRight = vw - margin - rightLeft;
  const roomLeft = anchor.x - offset - margin;
  return {
    left: clamp(roomRight >= roomLeft ? rightLeft : leftLeft, minLeft, maxLeft),
    top: clamp(anchor.y - lift, minTop, maxTop),
    side: 'clamped',
  };
}
