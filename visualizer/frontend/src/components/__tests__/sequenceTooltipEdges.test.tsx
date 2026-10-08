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
 *
 * ## Every theme's panel, not one (#253)
 *
 * These tests first measured against a single dark panel, `rgb(15,23,42)`, and
 * passed while every arc was invisible under the Light theme: the arc colour was
 * '#e2e8f0', which is Light's panel ground `--re-bg-3` exactly — 1.00:1. The
 * panel is `--re-bg-3` of whichever theme is applied, so contrast is measured
 * against each theme's, with the arc colour resolved through that theme's
 * variables the way the browser resolves them.
 */

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { TooltipSeqGraph, EMPTY_LIVE } from '../MachineSequenceTooltip';
import type { TooltipSeq } from '../MachineSequenceTooltip';
import { THEMES } from '../../styles/themes';

type RGB = [number, number, number];

/** Each theme's `--re-*` custom properties, read from the CSS it injects. */
const THEME_VARS = THEMES.map(t => ({
  id: t.id,
  vars: Object.fromEntries(Array.from(t.css.matchAll(/(--re-[\w-]+):\s*([^;]+);/g), m => [m[1], m[2].trim()])),
}));

/** Resolve `var(--x, fallback)` against a theme, as the browser would. */
function resolve(paint: string, vars: Record<string, string>): string {
  const m = paint.match(/^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!m) return paint;
  return vars[m[1]] ?? resolve(m[2] ?? '', vars);
}

function hexRGB(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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

function contrastOnPanel(hex: string, alpha: number, panelHex: string): number {
  const fg = hexRGB(hex);
  const panel = hexRGB(panelHex);
  // Composite the semi-transparent stroke over the panel, then compare.
  const over = fg.map((c, i) => alpha * c + (1 - alpha) * panel[i]) as RGB;
  const [a, b] = [luminance(over), luminance(panel)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

/** The paint a line or path carries: `style` wins over the attribute. */
function paintOf(el: Element, prop: 'stroke' | 'fill'): string {
  return (el as SVGElement).style.getPropertyValue(prop) || el.getAttribute(prop) || '';
}

/** The worst contrast of these lines on the panel of every theme. */
function worstAcrossThemes(lines: Element[], opacity = effectiveOpacity): { contrast: number; theme: string } {
  let worst = { contrast: Infinity, theme: '' };
  for (const { id, vars } of THEME_VARS) {
    for (const l of lines) {
      const c = contrastOnPanel(resolve(paintOf(l, 'stroke'), vars), opacity(l), vars['--re-bg-3']);
      if (c < worst.contrast) worst = { contrast: c, theme: id };
    }
  }
  return worst;
}

/** Effective opacity of a line: the two channels multiply. */
function effectiveOpacity(l: Element): number {
  const style = parseFloat((l as HTMLElement).style.opacity || '1');
  const attr = parseFloat(l.getAttribute('stroke-opacity') || '1');
  return style * attr;
}

function transitions(container: HTMLElement): Element[] {
  // The two strip separators are also <line>; transitions carry the class.
  return Array.from(container.querySelectorAll('line.tt-edge'));
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

    const worst = () => worstAcrossThemes(transitions(container)).contrast;

    expect(THEME_VARS.length).toBeGreaterThanOrEqual(6);
    // 1.00:1 under Light before #253.
    const w = worstAcrossThemes(transitions(container));
    expect(w.contrast, `worst theme: ${w.theme}`).toBeGreaterThanOrEqual(3);

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
    const quietLine = transitions(container).find(l => !paintOf(l, 'stroke').includes('cyan'))!;
    expect(worstAcrossThemes([quietLine]).contrast).toBeGreaterThanOrEqual(3);
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

  it('paints arcs, arrowheads and labels from the theme, at 3:1 or better on every panel (#253)', async () => {
    const { container } = render(<TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />);
    await settle();

    // Arcs and arrowheads: no colour is fixed, so a theme switch repaints them.
    for (const l of transitions(container)) expect(paintOf(l, 'stroke')).toMatch(/^var\(--re-/);
    const heads = Array.from(container.querySelectorAll('marker path'));
    expect(heads.length).toBe(2);
    for (const h of heads) expect(paintOf(h, 'fill')).toMatch(/^var\(--re-/);

    for (const { id, vars } of THEME_VARS) {
      const panel = vars['--re-bg-3'];
      for (const h of heads) {
        expect({ id, c: contrastOnPanel(resolve(paintOf(h, 'fill'), vars), 1, panel) >= 3 })
          .toEqual({ id, c: true });
      }
      // Event labels are text: 4.5:1.
      for (const t of Array.from(container.querySelectorAll('g.tt-graph text'))) {
        expect({ id, c: contrastOnPanel(resolve(paintOf(t, 'fill'), vars), 1, panel) >= 4.5 })
          .toEqual({ id, c: true });
      }
    }
  });

  it('gives each graph its own arrowhead markers, so two open panels do not share them', async () => {
    const { container } = render(
      <>
        <TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />
        <TooltipSeqGraph sequences={CONNECTED} live={EMPTY_LIVE} />
      </>,
    );
    await settle();

    const ids = Array.from(container.querySelectorAll('marker')).map(m => m.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    // Every arc points at a marker that exists, and at its own graph's.
    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      const own = new Set(Array.from(svg.querySelectorAll('marker')).map(m => `url(#${m.id})`));
      for (const l of Array.from(svg.querySelectorAll('line.tt-edge'))) {
        expect(own.has(l.getAttribute('marker-end') ?? '')).toBe(true);
      }
    }
  });
});
