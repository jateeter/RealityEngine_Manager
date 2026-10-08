import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { FloatingTooltip } from '../FloatingTooltip';

// jsdom does no layout: give every element a measurable size so the placement
// runs on real numbers.
const PANEL_W = 400;
const PANEL_H = 300;
let restore: Array<() => void> = [];

beforeAll(() => {
  for (const [prop, value] of [['offsetWidth', PANEL_W], ['offsetHeight', PANEL_H]] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    restore.push(() => original && Object.defineProperty(HTMLElement.prototype, prop, original));
  }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
});

afterAll(() => { restore.forEach(fn => fn()); restore = []; });

describe('FloatingTooltip (#248)', () => {
  it('renders on <body>, outside a clipping container, as position: fixed', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <FloatingTooltip anchor={{ x: 100, y: 100 }} className="mgv-tooltip">panel</FloatingTooltip>
      </div>,
    );
    const panel = document.body.querySelector('.mgv-tooltip') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(container.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe('fixed');
  });

  it('places itself from its measured size, flipping left near the right edge', () => {
    render(<FloatingTooltip anchor={{ x: 1200, y: 100 }} className="t-flip">panel</FloatingTooltip>);
    const panel = document.body.querySelector('.t-flip') as HTMLElement;
    expect(panel.dataset.side).toBe('left');
    // Held by its right edge, 14px left of the pointer, so growing extends it
    // leftwards, away from the pointer.
    expect(panel.style.left).toBe('auto');
    expect(panel.style.right).toBe(`${1280 - (1200 - 14)}px`);
    expect(panel.style.top).toBe('90px');
  });

  it('holds a right-side panel by its left edge', () => {
    render(<FloatingTooltip anchor={{ x: 100, y: 100 }} className="t-right">panel</FloatingTooltip>);
    const right = document.body.querySelector('.t-right') as HTMLElement;
    expect(right.dataset.side).toBe('right');
    expect(right.style.left).toBe(`${100 + 14}px`);
    expect(right.style.right).toBe('auto');
  });

  it('re-places when the anchor moves', () => {
    const { rerender } = render(
      <FloatingTooltip anchor={{ x: 100, y: 100 }} className="t-move">panel</FloatingTooltip>,
    );
    const panel = document.body.querySelector('.t-move') as HTMLElement;
    expect(panel.dataset.side).toBe('right');
    rerender(<FloatingTooltip anchor={{ x: 1200, y: 790 }} className="t-move">panel</FloatingTooltip>);
    expect(panel.dataset.side).toBe('left');
    expect(panel.style.top).toBe(`${800 - 8 - PANEL_H}px`);
    expect(panel.style.left).toBe('auto');
  });
});
