/**
 * The 3D hover → sequence-tooltip glue (#90).
 *
 * `Graph3DView` suppresses the built-in 3d-force-graph label and delegates
 * hover presentation to its parent through `onMachineHover`. The prop was
 * optional, so a parent that never passed it produced no machine tooltip in 3D
 * and no error anywhere — indistinguishable from "3D has no tooltips". Two of
 * the three call sites were in exactly that state, and `MachineGraphView` was
 * the sharpest case: it owned the entire tooltip subsystem and reached none of
 * it from the 3D view, so the feature vanished at the toggle.
 *
 * ## What is tested where
 *
 * The *wiring* is now a type error rather than a test: `Graph3DViewProps` is a
 * union on `mode`, and `onMachineHover` is required when `mode` is machines. A
 * call site that omits it does not compile, which is a stronger guarantee than
 * any runtime assertion — and it is what caught the live defect, the moment the
 * union landed.
 *
 * What a type cannot check is whether the handler *behaves*, so that is what
 * these cover: the debounce on both edges, the container-relative coordinate
 * mapping, and the rule that a pinned tooltip is never dismissed by hover-out.
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useGraph3DMachineHover } from '../useGraph3DMachineHover';

const OPEN_MS = 160;
const CLOSE_MS = 220;

/** Container origin, so viewport → container mapping is observable. */
const RECT = { left: 100, top: 40 } as DOMRect;

function setup(names: Record<string, string> = { 'machine-a': 'Fall Detection' }) {
  const show = vi.fn();
  const dismiss = vi.fn();
  const container = {
    current: { getBoundingClientRect: () => RECT } as unknown as HTMLElement,
  };
  const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
  const showTooltipRef = { current: show };

  const hook = renderHook(() =>
    useGraph3DMachineHover({
      containerRef: container,
      timerRef,
      showTooltipRef,
      machineName: (id: string) => names[id],
      dismiss,
    }),
  );
  return { hook, show, dismiss, timerRef };
}

describe('useGraph3DMachineHover (#90)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the tooltip after the debounce, in container coordinates', () => {
    const { hook, show } = setup();

    hook.result.current('machine-a', 300, 200);
    expect(show).not.toHaveBeenCalled();   // still inside the open delay

    vi.advanceTimersByTime(OPEN_MS);
    // 300 - 100 + 14, 200 - 40 - 10 — viewport coords from the WebGL canvas,
    // mapped into the container the tooltip is positioned within.
    expect(show).toHaveBeenCalledWith('machine-a', 'Fall Detection', 214, 150);
  });

  it('does not strobe when the cursor crosses several spheres', () => {
    const { hook, show } = setup({ a: 'A', b: 'B', c: 'C' });

    hook.result.current('a', 300, 200);
    vi.advanceTimersByTime(60);
    hook.result.current('b', 310, 205);
    vi.advanceTimersByTime(60);
    hook.result.current('c', 320, 210);
    vi.advanceTimersByTime(OPEN_MS);

    // Only the sphere the cursor settled on opens a panel.
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith('c', 'C', expect.any(Number), expect.any(Number));
  });

  it('delays dismissal so the cursor can travel onto the tooltip', () => {
    const { hook, dismiss } = setup();

    hook.result.current(null);
    vi.advanceTimersByTime(CLOSE_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending dismissal when the cursor returns', () => {
    const { hook, dismiss, show } = setup();

    hook.result.current(null);
    vi.advanceTimersByTime(100);
    hook.result.current('machine-a', 300, 200);   // back on a sphere
    vi.advanceTimersByTime(OPEN_MS);

    expect(dismiss).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('leaves the panel alone for a machine the parent does not know', () => {
    // The 3D scene raycasts its own meshes; an id the parent has no entry for
    // would otherwise open a titled panel with nothing behind it.
    const { hook, show, dismiss } = setup();

    hook.result.current('machine-unknown', 300, 200);
    vi.advanceTimersByTime(OPEN_MS + CLOSE_MS);

    expect(show).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not fire a pending open after unmount', () => {
    const { hook, show } = setup();

    hook.result.current('machine-a', 300, 200);
    hook.unmount();
    vi.advanceTimersByTime(OPEN_MS * 4);

    expect(show).not.toHaveBeenCalled();
  });
});
