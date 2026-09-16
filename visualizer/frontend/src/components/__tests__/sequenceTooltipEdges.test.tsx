/**
 * CES tooltip transitions must stay visible (#89).
 *
 * Reported as "connections between Reality Events are not depicted". The data
 * contract, the edge-building code in both tooltip hosts, and the d3 join were
 * all verified intact — edges are built, joined to `<line>` elements, and
 * positioned by the tick handler. The defect was downstream of all of that, in
 * the hover handler:
 *
 *     .on('mouseout', () => { link.style('opacity', 0.45); })
 *
 * `style.opacity` is a *separate* channel from the `stroke-opacity` already on
 * the line, and the two multiply. Resetting the style channel to the base value
 * squared it — 0.45 x 0.45 = 0.2025 effective, a 1.80:1 contrast ratio against
 * the tooltip panel, below the 3:1 WCAG floor for a graphical object. It was
 * permanent for the life of the tooltip, so hovering any event node once — the
 * exact thing an operator does when inspecting a sequence — made every
 * transition fade to near-invisible and stay there.
 *
 * The sibling this component's header says it matches,
 * `CriticalEventGraphView.tsx:699`, resets to 1. The tooltip copied the pattern
 * and substituted the base opacity.
 *
 * ## Why the test asserts contrast, not an opacity number
 *
 * A test pinning `stroke-opacity === 0.45` would have passed throughout: that
 * attribute was never wrong. The property that was violated is whether the line
 * is *visible on the panel it is drawn on*, so that is what is measured, through
 * whatever combination of channels produces it. A future change is free to move
 * opacity between channels and free to retune the base; it is not free to leave
 * a transition invisible after a hover.
 */

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { TooltipSeqGraph, EMPTY_LIVE } from '../MachineSequenceTooltip';
import type { TooltipSeq } from '../MachineSequenceTooltip';

/** The tooltip panel ground: `rgba(15,23,42,0.96)` over a dark app shell. */
const PANEL: [number, number, number] = [15, 23, 42];

function node(id: string, isInitial = false, hasOutput = false) {
  return { id, label: id, isInitial, hasOutput, elements: [] };
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastOnPanel(hex: string, alpha: number): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const fg: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Composite the semi-transparent stroke over the panel, then compare.
  const over = fg.map((c, i) => alpha * c + (1 - alpha) * PANEL[i]) as [number, number, number];
  const [a, b] = [luminance(over), luminance(PANEL)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

/** Effective opacity of a line: the two channels multiply. */
function effectiveOpacity(l: Element): number {
  const style = parseFloat((l as HTMLElement).style.opacity || '1');
  const attr = parseFloat(l.getAttribute('stroke-opacity') || '1');
  return style * attr;
}

function transitions(container: HTMLElement): Element[] {
  // The two strip separators are also <line>; transitions carry the edge color.
  return Array.from(container.querySelectorAll('line'))
    .filter(l => l.getAttribute('stroke') === '#e2e8f0');
}

/** d3-force settles asynchronously; let the ticks run. */
const settle = () => new Promise(r => setTimeout(r, 600));

const CONNECTED: TooltipSeq[] = [{
  sequenceId: 'fall-confirmed',
  name: 'fall confirmed',
  nodes: [node('a', true), node('b'), node('c', false, true)],
  edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
}];

describe('CES tooltip transitions (#89)', () => {
  it('draws one line per declared transition, with both endpoints placed', async () => {
    const { container } = render(<TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />);
    await settle();

    const lines = transitions(container);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      // A line the tick handler never reached sits at 0,0 → 0,0 and is invisible
      // while still counting as "rendered".
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => parseFloat(l.getAttribute(a) ?? 'NaN'));
      expect(Number.isFinite(x1 + y1 + x2 + y2)).toBe(true);
      expect(Math.hypot(x2 - x1, y2 - y1)).toBeGreaterThan(1);
    }
  });

  it('keeps transitions visible after a hover cycle', async () => {
    const { container } = render(<TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />);
    await settle();

    const before = transitions(container).map(effectiveOpacity);
    expect(Math.min(...before)).toBeGreaterThan(0);

    const target = container.querySelector('circle');
    expect(target).not.toBeNull();
    target!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

    const after = transitions(container).map(effectiveOpacity);
    // The regression: after was `before * before` — 0.2025 where 0.45 was drawn.
    expect(after).toEqual(before);
  });

  it('draws transitions above the 3:1 non-text contrast floor, before and after hover', async () => {
    const { container } = render(<TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />);
    await settle();

    const worst = () => Math.min(...transitions(container)
      .map(l => contrastOnPanel(l.getAttribute('stroke') ?? '#ffffff', effectiveOpacity(l))));

    expect(worst()).toBeGreaterThanOrEqual(3);

    const target = container.querySelector('circle')!;
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

    // 1.80:1 before the fix.
    expect(worst()).toBeGreaterThanOrEqual(3);
  });

  it('keeps the base paint across a live engine step', async () => {
    // The second copy of the base opacity, and the one the first version of this
    // test could not see. The live-update effect repaints every non-transitioning
    // edge on each WebSocket step, and it carried its own literal `0.45` rather
    // than the constant — so in a running universe the edges reverted to the old
    // value within one step of the tooltip opening, whichever value the join had
    // drawn. It surfaced only when this was checked against a live 3-engine
    // universe; with no step traffic, the branch never runs.
    const { container, rerender } = render(
      <TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />);
    await settle();
    const base = transitions(container).map(effectiveOpacity);

    // A step in which 'c' activates: a→b does not transition, b→c does.
    rerender(
      <TooltipSeqGraph
        sequences={CONNECTED}
        live={{ ...EMPTY_LIVE, stepNumber: 7, activatedIds: new Set(['c']), matchedIds: new Set() }}
      />,
    );
    await settle();

    const quiet = transitions(container).map(effectiveOpacity);
    expect(Math.min(...quiet)).toBeGreaterThanOrEqual(Math.min(...base));
    expect(Math.min(...quiet.map((_, i) =>
      contrastOnPanel('#e2e8f0', quiet[i])))).toBeGreaterThanOrEqual(3);
  });

  it('names an empty edge set as single-event rather than rendering nothing', async () => {
    // 83% of sequences in the corpus hold exactly one event, so an empty graph
    // is usually correct — and was indistinguishable from a failed render.
    const { container } = render(
      <TooltipSeqGraph
        sequences={[
          { sequenceId: 's1', name: 's1', nodes: [node('a', true)], edges: [] },
          { sequenceId: 's2', name: 's2', nodes: [node('b', true)], edges: [] },
        ]}
        live={EMPTY_LIVE}
      />,
    );
    await settle();

    expect(transitions(container)).toHaveLength(0);
    const note = container.querySelector('.tt-no-transitions');
    expect(note?.textContent).toMatch(/no transitions — 2 single-event sequences/);
  });

  it('distinguishes a multi-event sequence that declares no transitions', async () => {
    // Not the same finding. `localai/agent_activity_classifier` carries a
    // 2-event sequence with zero `nextEventIds` — a statement about that
    // machine's data, not about the shape of the corpus.
    const { container } = render(
      <TooltipSeqGraph
        sequences={[{ sequenceId: 'agact-struggling', name: 'struggling', nodes: [node('a', true), node('b')], edges: [] }]}
        live={EMPTY_LIVE}
      />,
    );
    await settle();

    const note = container.querySelector('.tt-no-transitions');
    expect(note?.textContent).toMatch(/no transitions declared — 1 multi-event sequence/);
  });
});
