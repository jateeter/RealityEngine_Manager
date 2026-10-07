import { describe, it, expect } from 'vitest';
import { placeTooltip } from '../tooltipPlacement';
import type { Point, Size, TooltipPlacement } from '../tooltipPlacement';

// The node tooltips' contract (#248): wherever the pointer is, the panel lies
// wholly inside the viewport, at least MARGIN from every edge, and — whenever
// any side has room for it — not under the pointer.

const VIEWPORT: Size = { width: 1280, height: 800 };
const PANEL: Size = { width: 420, height: 440 };   // a typical sequence tooltip
const MARGIN = 8;
const OFFSET = 14;

function inside(p: TooltipPlacement, size: Size, vp: Size = VIEWPORT): boolean {
  return p.left >= MARGIN && p.top >= MARGIN
    && p.left + size.width <= vp.width - MARGIN
    && p.top + size.height <= vp.height - MARGIN;
}

function covers(p: TooltipPlacement, size: Size, pt: Point): boolean {
  return pt.x >= p.left && pt.x <= p.left + size.width
    && pt.y >= p.top && pt.y <= p.top + size.height;
}

describe('placeTooltip (#248)', () => {
  it('prefers the right of the pointer, top edge just above it', () => {
    const p = placeTooltip({ x: 200, y: 200 }, PANEL, VIEWPORT);
    expect(p).toEqual({ left: 200 + OFFSET, top: 190, side: 'right' });
  });

  it('flips to the left of the pointer near the right edge', () => {
    const p = placeTooltip({ x: 1200, y: 200 }, PANEL, VIEWPORT);
    expect(p.side).toBe('left');
    expect(p.left).toBe(1200 - OFFSET - PANEL.width);
  });

  it('shifts up near the bottom edge instead of running off it', () => {
    const p = placeTooltip({ x: 200, y: 780 }, PANEL, VIEWPORT);
    expect(p.side).toBe('right');
    expect(p.top).toBe(VIEWPORT.height - MARGIN - PANEL.height);
  });

  it('keeps the top margin near the top edge', () => {
    const p = placeTooltip({ x: 200, y: 2 }, PANEL, VIEWPORT);
    expect(p.top).toBe(MARGIN);
  });

  it('goes below or above the pointer when neither side has room', () => {
    const narrow: Size = { width: 600, height: 800 };
    const small: Size = { width: 340, height: 200 };
    const below = placeTooltip({ x: 300, y: 100 }, small, narrow);
    expect(below.side).toBe('below');
    expect(below.top).toBe(100 + OFFSET);
    const above = placeTooltip({ x: 300, y: 700 }, small, narrow);
    expect(above.side).toBe('above');
    expect(above.top).toBe(700 - OFFSET - small.height);
  });

  it('is wholly inside the viewport and off the pointer, for anchors across the whole viewport', () => {
    for (let x = 0; x <= VIEWPORT.width; x += 40) {
      for (let y = 0; y <= VIEWPORT.height; y += 40) {
        const pt = { x, y };
        const p = placeTooltip(pt, PANEL, VIEWPORT);
        expect(inside(p, PANEL), `anchor ${x},${y} → ${JSON.stringify(p)}`).toBe(true);
        expect(covers(p, PANEL, pt), `anchor ${x},${y} covered`).toBe(false);
      }
    }
  });

  it('stays inside a small window (1024×640) for anchors at every corner and edge', () => {
    const vp: Size = { width: 1024, height: 640 };
    // The CSS bounds the panel to the viewport minus 2×margin.
    const panel: Size = { width: 500, height: vp.height - 2 * MARGIN };
    for (const x of [0, 10, 512, 1014, 1024]) {
      for (const y of [0, 10, 320, 630, 640]) {
        expect(inside(placeTooltip({ x, y }, panel, vp), panel, vp)).toBe(true);
      }
    }
  });

  it('clamps to the margins when the panel is larger than every side', () => {
    const vp: Size = { width: 400, height: 300 };
    const big: Size = { width: 380, height: 280 };
    const p = placeTooltip({ x: 200, y: 150 }, big, vp);
    expect(p.side).toBe('clamped');
    expect(inside(p, big, vp)).toBe(true);
  });
});
