import type { VisMachine, VisMachineSequence } from '../../hooks/useMachineSimulation';
import { classifyMachine, domainColor, DOMAINS, DOMAIN_ORDER, type DomainId } from '../machineDomains';
import { vizTheme } from '../../styles/vizTheme';

// ---------------------------------------------------------------------------
// Inner-graph drawing constants (used in expanded card and live view)
// ---------------------------------------------------------------------------
const INNER_W    = 220;   // inner graph coordinate width
const BAND_H     = 60;    // height of each sequence band
const DIVIDER_H  = 8;     // gap between bands
const NODE_R     = 5;     // inner-graph node radius
const ARROW_SIZE = 5;
const HIT_EXTRA  = 5;
const PAD        = 10;    // padding inside expanded card

// Expanded-card header / footer heights
const EXP_W      = 280;
const EXP_HEADER = 28;
const EXP_FOOTER = 22;

// ---------------------------------------------------------------------------
// Overview bubble constants
// ---------------------------------------------------------------------------
const BUBBLE_R      = 26;        // machine node circle radius
const BUBBLE_LABEL  = 18;        // label area below bubble
const BUBBLE_CELL_W = BUBBLE_R * 2 + 28;
const BUBBLE_CELL_H = BUBBLE_R * 2 + BUBBLE_LABEL + 24;

// ---------------------------------------------------------------------------
// Domain panel constants
// ---------------------------------------------------------------------------
const CANVAS_PAD     = 20;
const PANEL_GAP      = 20;
const PANEL_INNER    = 16;   // inner padding of panel
const PANEL_HDR      = 38;   // domain header bar height
const PANEL_MIN_W    = 140;

// ---------------------------------------------------------------------------
// Expansion animation
// ---------------------------------------------------------------------------
const EXP_SPEED = 0.11;   // progress per frame at ~60 fps ≈ 150 ms total

// ---------------------------------------------------------------------------
// Live-view header bar height (drawn in screen-space above the graph)
// ---------------------------------------------------------------------------
const LIVE_HDR = 48;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
const COLOR_INITIAL        = '#3b82f6';
const COLOR_INITIAL_MATCH  = vizTheme.accent.current;
const COLOR_TERMINAL       = '#f59e0b';
const COLOR_ACTIVE         = '#06b6d4';
const COLOR_DEFAULT        = vizTheme.text.secondary;
const COLOR_HOVER          = vizTheme.outline.hover;
const COLOR_NODE_BG        = '#111827';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InnerNode {
  id: string; label: string; seqIdx: number;
  ix: number; iy: number;
  isInitial: boolean; hasOutput: boolean;
  justFired: boolean; isActive: boolean; wasJustInitialMatched: boolean;
  elements: { value: number; comparatorType: string; threshold?: number }[];
}

interface InnerEdge { source: InnerNode; target: InnerNode; bend: number; }

interface SeqBand { yStart: number; yEnd: number; name: string; }

interface InnerGraphCache {
  nodes: InnerNode[]; edges: InnerEdge[];
  neighbors: Map<string, Set<string>>;
  seqBands: SeqBand[]; totalHeight: number;
}

interface MachineNode {
  id: string; name: string; machine: VisMachine;
  domain: DomainId; domainColor: string;
  innerGraph: InnerGraphCache;
  cardH: number;
}

interface OuterEdge { sourceId: string; targetId: string; overlapLength: number; }

interface PanelDef {
  domain: DomainId; label: string; color: string; fill: string;
  x: number; y: number; w: number; h: number;
  nodeCols: number; nodeCount: number;
}

interface BubblePos { cx: number; cy: number; }
interface Viewport   { tx: number; ty: number; scale: number; }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hashToUnit(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

function statusColor(status: VisMachine['status']): string {
  switch (status) {
    case 'active':     return '#22c55e';
    case 'processing': return '#a855f7';
    default:           return '#334155';
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, tx: number, ty: number, color: string,
): void {
  const adx = tx - cx, ady = ty - cy;
  const alen = Math.hypot(adx, ady) || 1;
  const ax = adx / alen, ay = ady / alen;
  const ex = tx - ax * NODE_R, ey = ty - ay * NODE_R;
  const px = -ay, py = ax;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ax * ARROW_SIZE + px * ARROW_SIZE * 0.4, ey - ay * ARROW_SIZE + py * ARROW_SIZE * 0.4);
  ctx.lineTo(ex - ax * ARROW_SIZE - px * ARROW_SIZE * 0.4, ey - ay * ARROW_SIZE - py * ARROW_SIZE * 0.4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function nodeColor(node: InnerNode, isHovered: boolean): string {
  if (isHovered)                    return COLOR_HOVER;
  if (node.justFired)               return COLOR_TERMINAL;
  if (node.isActive)                return COLOR_ACTIVE;
  if (node.wasJustInitialMatched)   return COLOR_INITIAL_MATCH;
  if (node.isInitial)               return COLOR_INITIAL;
  if (node.hasOutput)               return COLOR_NODE_BG;
  return COLOR_DEFAULT;
}

function bfsRanks(
  vectorIds: string[],
  edges: { source: string; target: string }[],
  initialIds: Set<string>,
): Map<string, number> {
  const ranks = new Map<string, number>();
  const adj   = new Map<string, string[]>();
  for (const id of vectorIds) adj.set(id, []);
  for (const e of edges) { if (e.source !== e.target) adj.get(e.source)?.push(e.target); }
  const starts = vectorIds.filter(id => initialIds.has(id));
  if (starts.length === 0 && vectorIds.length > 0) starts.push(vectorIds[0]);
  const queue: { id: string; rank: number }[] = starts.map(id => ({ id, rank: 0 }));
  while (queue.length > 0) {
    const { id, rank } = queue.shift()!;
    if (ranks.has(id)) continue;
    ranks.set(id, rank);
    for (const nid of (adj.get(id) ?? [])) { if (!ranks.has(nid)) queue.push({ id: nid, rank: rank + 1 }); }
  }
  const maxRank = ranks.size > 0 ? Math.max(...ranks.values()) : 0;
  let extra = maxRank + 1;
  for (const id of vectorIds) { if (!ranks.has(id)) ranks.set(id, extra++); }
  return ranks;
}

// ---------------------------------------------------------------------------
// TobiasRenderer
// ---------------------------------------------------------------------------

export interface TobiasRendererOptions {
  canvas: HTMLCanvasElement;
  onSelectMachine: (id: string | null) => void;
  storageKey?: string;
}

export class TobiasRenderer {
  private readonly _canvas: HTMLCanvasElement;
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _dpr: number;
  private readonly _onSelectMachine: (id: string | null) => void;
  private readonly _storageKey: string;

  private _nodes: MachineNode[] = [];
  private _outerEdges: OuterEdge[] = [];

  private _cssW = 800;
  private _cssH = 600;

  // Shared viewport (pan / zoom) — used in both overview and live-view modes
  private _viewport: Viewport = { tx: 0, ty: 0, scale: 1 };
  private _savedViewport: Viewport | null = null;  // restored on live-view exit

  // Domain panels and bubble positions
  private _panels: PanelDef[] = [];
  private _gridPos    = new Map<string, BubblePos>();   // computed grid center
  private _pinnedPos  = new Map<string, BubblePos>();   // user-dragged overrides

  // Expansion state: single-click opens the inner-graph overlay
  private _expandedId: string | null = null;
  private _expandT    = 0;     // 0 = collapsed, 1 = fully open
  private _expandDir  = 0;     // +1 opening, -1 closing, 0 stable

  // Live-view mode: double-click on a bubble for full-canvas sequence view
  private _liveViewId: string | null = null;

  // Hover / selection
  private _hoveredCardId: string | null = null;      // reused by _drawInnerGraph
  private _hoveredInnerNodeId: string | null = null;
  private _selectedId: string | null = null;

  // Drag / interaction
  private _isPanning       = false;
  private _isDraggingBubble = false;
  private _dragNode: MachineNode | null = null;
  private _dragStartWorldX = 0;
  private _dragStartWorldY = 0;
  private _dragNodeStartCX = 0;
  private _dragNodeStartCY = 0;
  private _mouseDownX = 0;
  private _mouseDownY = 0;
  private _hasDragged = false;
  private _lastClickTime = 0;
  private _lastClickId: string | null = null;

  private _rafId = 0;

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  constructor(opts: TobiasRendererOptions) {
    this._canvas = opts.canvas;
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) throw new Error('TobiasRenderer: no 2D context');
    this._ctx         = ctx;
    this._dpr         = window.devicePixelRatio || 1;
    this._onSelectMachine = opts.onSelectMachine;
    this._storageKey  = opts.storageKey ?? 'tobias-layout';
    this._pinnedPos   = this._loadLayout();
    this._bindEvents();
    this._rafId = requestAnimationFrame(this._loop);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  resize(cssW: number, cssH: number): void {
    if (cssW <= 0 || cssH <= 0) return;
    this._canvas.width  = Math.round(cssW * this._dpr);
    this._canvas.height = Math.round(cssH * this._dpr);
    this._cssW = cssW;
    this._cssH = cssH;
    if (this._nodes.length > 0) this._computeLayout();
  }

  setData(machines: VisMachine[]): void {
    const existingById = new Map(this._nodes.map(n => [n.id, n]));

    const oldKey = this._nodes.map(n => n.id).sort().join('|');
    const newKey = machines.map(m => m.id).sort().join('|');
    const idsChanged = oldKey !== newKey;

    const seqsChanged = !idsChanged && machines.some(m => {
      const ex = existingById.get(m.id);
      if (!ex) return true;
      return ex.machine.sequences.map(s => s.sequenceId).sort().join('|')
          !== m.sequences.map(s => s.sequenceId).sort().join('|');
    });

    if (!idsChanged && !seqsChanged) {
      const byId = new Map(machines.map(m => [m.id, m]));
      for (const node of this._nodes) {
        const upd = byId.get(node.id);
        if (upd) {
          node.machine    = upd;
          node.innerGraph = this._refreshNodeStates(node.innerGraph, upd);
          const d = classifyMachine(upd).domain;
          node.domain     = d;
          node.domainColor = domainColor(d);
        }
      }
      return;
    }

    this._nodes = machines.map((m): MachineNode => {
      const ex   = existingById.get(m.id);
      const dom  = classifyMachine(m).domain;
      const exSeq = ex?.machine.sequences.map(s => s.sequenceId).join('|') ?? '';
      const newSeq = m.sequences.map(s => s.sequenceId).join('|');
      const innerGraph = (!ex || exSeq !== newSeq)
        ? this._buildInnerGraph(m)
        : this._refreshNodeStates(ex.innerGraph, m);
      return {
        id: m.id, name: m.name, machine: m,
        domain: dom, domainColor: domainColor(dom),
        innerGraph,
        cardH: EXP_HEADER + EXP_FOOTER + innerGraph.totalHeight + PAD * 2,
      };
    });

    this._outerEdges = [];
    for (const src of machines) {
      if (!src.outputRegion) continue;
      for (const tgt of machines) {
        if (src.id === tgt.id || !tgt.inputRegion) continue;
        const os = Math.max(src.outputRegion.offset, tgt.inputRegion.offset);
        const oe = Math.min(
          src.outputRegion.offset + src.outputRegion.length,
          tgt.inputRegion.offset + tgt.inputRegion.length,
        );
        if (oe > os) this._outerEdges.push({ sourceId: src.id, targetId: tgt.id, overlapLength: oe - os });
      }
    }

    this._computeLayout();
  }

  setSelectedId(id: string | null): void { this._selectedId = id; }

  clearLayout(): void {
    this._pinnedPos.clear();
    try { localStorage.removeItem(this._storageKey); } catch { /**/ }
    this._computeLayout();
  }

  destroy(): void {
    cancelAnimationFrame(this._rafId);
    this._unbindEvents();
  }

  // ---------------------------------------------------------------------------
  // Layout: N domain panels, each containing a bubble grid for its machines
  // ---------------------------------------------------------------------------

  private _computeLayout(): void {
    if (this._nodes.length === 0) {
      this._panels = [];
      this._gridPos.clear();
      return;
    }

    const cssW = this._cssW;

    // Determine which domains are actually present, preserving DOMAIN_ORDER
    const present = new Set(this._nodes.map(n => n.domain));
    const ordered = [
      ...DOMAIN_ORDER.filter(d => present.has(d)),
      ...[...present].filter(d => !DOMAIN_ORDER.includes(d as DomainId)),
    ] as DomainId[];

    const N        = ordered.length;
    const panelCols = N <= 1 ? 1 : N <= 2 ? 2 : Math.min(3, Math.ceil(Math.sqrt(N)));
    const panelRows = Math.ceil(N / panelCols);
    const availW   = cssW - 2 * CANVAS_PAD - (panelCols - 1) * PANEL_GAP;
    const panelW   = Math.max(PANEL_MIN_W, availW / panelCols);
    const innerW   = panelW - 2 * PANEL_INNER;
    const nodeCols = Math.max(1, Math.floor(innerW / BUBBLE_CELL_W));

    this._panels = [];
    this._gridPos.clear();

    let domIdx = 0;
    let rowY   = CANVAS_PAD;

    for (let row = 0; row < panelRows; row++) {
      const rowDomains = ordered.slice(domIdx, domIdx + panelCols);
      domIdx += rowDomains.length;

      // Uniform row height = tallest panel needed
      let rowH = 0;
      for (const dom of rowDomains) {
        const cnt  = this._nodes.filter(n => n.domain === dom).length;
        const nRow = Math.ceil(cnt / nodeCols);
        const ph   = PANEL_HDR + nRow * BUBBLE_CELL_H + 2 * PANEL_INNER;
        if (ph > rowH) rowH = ph;
      }

      for (let col = 0; col < rowDomains.length; col++) {
        const dom     = rowDomains[col];
        const def     = DOMAINS[dom] ?? { label: dom, color: '#94a3b8', fill: 'rgba(148,163,184,0.18)' };
        const px      = CANVAS_PAD + col * (panelW + PANEL_GAP);
        const py      = rowY;
        const domNodes = this._nodes.filter(n => n.domain === dom);

        this._panels.push({
          domain: dom, label: (def as typeof def & { label?: string }).label ?? dom,
          color: def.color, fill: def.fill,
          x: px, y: py, w: panelW, h: rowH,
          nodeCols, nodeCount: domNodes.length,
        });

        domNodes.forEach((node, idx) => {
          const gc = idx % nodeCols;
          const gr = Math.floor(idx / nodeCols);
          this._gridPos.set(node.id, {
            cx: px + PANEL_INNER + gc * BUBBLE_CELL_W + BUBBLE_CELL_W / 2,
            cy: py + PANEL_HDR  + PANEL_INNER + gr * BUBBLE_CELL_H + BUBBLE_R + 4,
          });
        });
      }

      rowY += rowH + PANEL_GAP;
    }
  }

  private _getBubblePos(id: string): BubblePos {
    const pinned = this._pinnedPos.get(id);
    // Guard against stale localStorage entries written by older renderers that
    // used { fx, fy } keys instead of { cx, cy }.
    if (pinned && typeof pinned.cx === 'number' && typeof pinned.cy === 'number') return pinned;
    return this._gridPos.get(id) ?? { cx: 100, cy: 100 };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private _loadLayout(): Map<string, BubblePos> {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return new Map();
      return new Map(Object.entries(JSON.parse(raw) as Record<string, BubblePos>));
    } catch { return new Map(); }
  }

  private _saveLayout(): void {
    const obj: Record<string, BubblePos> = {};
    for (const [id, pos] of this._pinnedPos) obj[id] = pos;
    try { localStorage.setItem(this._storageKey, JSON.stringify(obj)); } catch { /**/ }
  }

  // ---------------------------------------------------------------------------
  // Inner-graph construction
  // ---------------------------------------------------------------------------

  private _buildInnerGraph(machine: VisMachine): InnerGraphCache {
    const allNodes: InnerNode[] = [];
    const allEdges: InnerEdge[] = [];
    const neighbors = new Map<string, Set<string>>();
    const seqBands: SeqBand[] = [];
    let yOffset = 0;
    const seqCount = machine.sequences.length;

    machine.sequences.forEach((seq, seqIdx) => {
      const band = this._layoutSequenceBand(seq, seqIdx, yOffset, machine.justFired);
      seqBands.push({ yStart: yOffset, yEnd: yOffset + BAND_H, name: seq.name });
      for (const n of band.nodes) { allNodes.push(n); neighbors.set(n.id, new Set()); }
      for (const e of band.edges) {
        allEdges.push(e);
        if (e.source.id !== e.target.id) {
          neighbors.get(e.source.id)?.add(e.target.id);
          neighbors.get(e.target.id)?.add(e.source.id);
        }
      }
      yOffset += BAND_H + (seqIdx < seqCount - 1 ? DIVIDER_H : 0);
    });

    const totalHeight = seqCount > 0
      ? seqCount * BAND_H + (seqCount - 1) * DIVIDER_H
      : BAND_H;

    return { nodes: allNodes, edges: allEdges, neighbors, seqBands, totalHeight };
  }

  private _layoutSequenceBand(
    seq: VisMachineSequence, seqIdx: number, yBase: number, machineFired: boolean,
  ): { nodes: InnerNode[]; edges: InnerEdge[] } {
    const { vectors, edges: seqEdges } = seq;
    if (vectors.length === 0) return { nodes: [], edges: [] };

    const initialIds = new Set(vectors.filter(v => v.isInitial).map(v => v.id));
    const ranks      = bfsRanks(vectors.map(v => v.id), seqEdges, initialIds);
    const maxRank    = Math.max(0, ...ranks.values());
    const byRank     = new Map<number, string[]>();
    for (const v of vectors) {
      const r = ranks.get(v.id) ?? 0;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r)!.push(v.id);
    }

    const xStep   = INNER_W / (maxRank + 1);
    const posById = new Map<string, { ix: number; iy: number }>();
    for (const [rank, ids] of byRank) {
      const x = (rank + 0.5) * xStep;
      ids.forEach((id, i) => {
        posById.set(id, {
          ix: Math.max(NODE_R + 2, Math.min(INNER_W - NODE_R - 2, x)),
          iy: Math.max(yBase + NODE_R + 2, Math.min(yBase + BAND_H - NODE_R - 2,
            yBase + ((i + 1) / (ids.length + 1)) * BAND_H)),
        });
      });
    }

    const innerById = new Map<string, InnerNode>();
    const nodes: InnerNode[] = vectors.map(v => {
      const pos  = posById.get(v.id) ?? { ix: INNER_W / 2, iy: yBase + BAND_H / 2 };
      const node: InnerNode = {
        id: v.id, label: v.label, seqIdx,
        ix: pos.ix, iy: pos.iy,
        isInitial: v.isInitial, hasOutput: v.hasOutput,
        justFired:             v.wasJustMatched        ?? (machineFired && v.hasOutput),
        isActive:              v.isActive              ?? false,
        wasJustInitialMatched: v.wasJustInitialMatched ?? false,
        elements: v.elements,
      };
      innerById.set(v.id, node);
      return node;
    });

    const edges: InnerEdge[] = [];
    const added = new Set<string>();
    for (const e of seqEdges) {
      const s = innerById.get(e.source), t = innerById.get(e.target);
      if (!s || !t) continue;
      const key = `${e.source}→${e.target}`;
      if (added.has(key)) continue;
      added.add(key);
      edges.push({ source: s, target: t, bend: (hashToUnit(key) - 0.5) * 34 });
    }
    for (const v of vectors) {
      if (v.isInitial) {
        const key = `${v.id}→${v.id}`;
        if (!added.has(key)) { const n = innerById.get(v.id)!; edges.push({ source: n, target: n, bend: 0 }); }
      }
    }
    return { nodes, edges };
  }

  private _refreshNodeStates(cache: InnerGraphCache, machine: VisMachine): InnerGraphCache {
    const stateMap = new Map<string, { isActive: boolean; wasJustMatched: boolean; wasJustInitialMatched: boolean }>();
    for (const seq of machine.sequences)
      for (const v of seq.vectors)
        stateMap.set(v.id, {
          isActive: v.isActive ?? false,
          wasJustMatched: v.wasJustMatched ?? false,
          wasJustInitialMatched: v.wasJustInitialMatched ?? false,
        });
    const hasPerNode = stateMap.size > 0;
    return {
      ...cache,
      nodes: cache.nodes.map(n => {
        const s = stateMap.get(n.id);
        return {
          ...n,
          justFired:             hasPerNode ? (s?.wasJustMatched ?? false) : (machine.justFired && n.hasOutput),
          isActive:              s?.isActive              ?? false,
          wasJustInitialMatched: s?.wasJustInitialMatched ?? false,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // rAF loop
  // ---------------------------------------------------------------------------

  private _loop = (_ts: number): void => {
    // Advance expansion animation
    if (this._expandDir !== 0) {
      this._expandT = Math.max(0, Math.min(1, this._expandT + this._expandDir * EXP_SPEED));
      if (this._expandT <= 0 || this._expandT >= 1) this._expandDir = 0;
    }
    this._draw();
    this._rafId = requestAnimationFrame(this._loop);
  };

  // ---------------------------------------------------------------------------
  // Drawing — top level
  // ---------------------------------------------------------------------------

  private _draw(): void {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.save();
    ctx.scale(this._dpr, this._dpr);

    // World-space pass (viewport transform applied inside)
    ctx.save();
    const { tx, ty, scale } = this._viewport;
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    if (this._liveViewId) {
      this._drawLiveViewWorld();
    } else {
      this._drawOverviewWorld();
    }

    ctx.restore(); // end world space

    // Screen-space overlays (no viewport transform)
    if (this._liveViewId) {
      this._drawLiveViewHUD();
    } else if (this._expandedId && this._expandT > 0) {
      this._drawExpandedOverlay();
    }

    ctx.restore(); // end dpr scale
  }

  // ---------------------------------------------------------------------------
  // Overview: panels + bubbles + edges
  // ---------------------------------------------------------------------------

  private _drawOverviewWorld(): void {
    // Domain hull bubbles — drawn behind edges and nodes
    for (const panel of this._panels) this._drawDomainHull(panel);

    // Outer edges between machines
    for (const edge of this._outerEdges) {
      const sp = this._getBubblePos(edge.sourceId);
      const tp = this._getBubblePos(edge.targetId);
      const mx = (sp.cx + tp.cx) / 2, my = (sp.cy + tp.cy) / 2;
      const dx = tp.cx - sp.cx, dy = tp.cy - sp.cy;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const ctx = this._ctx;
      ctx.beginPath();
      ctx.moveTo(sp.cx, sp.cy);
      ctx.quadraticCurveTo(mx + nx * 30, my + ny * 30, tp.cx, tp.cy);
      ctx.strokeStyle = '#64c8ff';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth   = Math.max(1, Math.min(3, edge.overlapLength / 4));
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawArrowHead(this._ctx, mx + nx * 30, my + ny * 30, tp.cx, tp.cy, 'rgba(100,200,255,0.7)');
    }

    // Bubbles — dim all when one is expanded
    const dimmed = this._expandedId !== null && this._expandT > 0.15;
    for (const node of this._nodes) {
      const alpha = (dimmed && node.id !== this._expandedId) ? 0.28 : 1.0;
      this._drawBubble(node, alpha);
    }
  }

  /**
   * Draw a smooth hull bubble around all nodes in a domain.
   * Positions are derived from current node centers so pinned nodes are
   * included naturally.  Falls back to a fixed-size rounded rect when the
   * domain has no positioned nodes yet.
   */
  private _drawDomainHull(panel: PanelDef): void {
    const ctx       = this._ctx;
    const HULL_PAD  = 36;
    const LABEL_H   = 28;

    const domNodes  = this._nodes.filter(n => n.domain === panel.domain);
    if (domNodes.length === 0) return;

    // Bounding box over all node centers (grid or pinned positions)
    const positions = domNodes.map(n => this._getBubblePos(n.id));
    const minX = Math.min(...positions.map(p => p.cx)) - BUBBLE_R - HULL_PAD;
    const maxX = Math.max(...positions.map(p => p.cx)) + BUBBLE_R + HULL_PAD;
    const minY = Math.min(...positions.map(p => p.cy)) - BUBBLE_R - HULL_PAD - LABEL_H;
    const maxY = Math.max(...positions.map(p => p.cy)) + BUBBLE_R + HULL_PAD;
    const w = maxX - minX, h = maxY - minY;

    ctx.save();

    // Soft fill
    roundRectPath(ctx, minX, minY, w, h, 22);
    ctx.fillStyle = panel.fill;
    ctx.fill();

    // Dashed domain-color border
    ctx.strokeStyle = panel.color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Domain label in top-left corner of hull
    ctx.fillStyle    = panel.color;
    ctx.font         = 'bold 11px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';
    ctx.fillText(panel.label.toUpperCase(), minX + 14, minY + 10, w - 28);

    // Machine count badge (right side)
    ctx.textAlign   = 'right';
    ctx.globalAlpha = 0.7;
    ctx.fillText(`${panel.nodeCount}`, maxX - 14, minY + 10);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  private _drawBubble(node: MachineNode, alpha: number): void {
    const ctx  = this._ctx;
    const pos  = this._getBubblePos(node.id);
    const isHovered  = this._hoveredCardId === node.id;
    const isSelected = this._selectedId === node.id;
    const fired      = node.machine.justFired;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Outer glow
    if (fired)           { ctx.shadowBlur = 22; ctx.shadowColor = '#f59e0b'; }
    else if (isSelected) { ctx.shadowBlur = 18; ctx.shadowColor = '#c864ff'; }
    else if (isHovered)  { ctx.shadowBlur = 12; ctx.shadowColor = '#facc15'; }
    else                 { ctx.shadowBlur = 6;  ctx.shadowColor = node.domainColor; }

    // Circle body — use a visible mid-dark fill so the ring contrast reads clearly
    ctx.beginPath();
    ctx.arc(pos.cx, pos.cy, BUBBLE_R, 0, Math.PI * 2);
    ctx.fillStyle = fired      ? '#2a1a00'
                  : isSelected ? '#260d40'
                  : '#1e2535';           // visible dark-blue, not near-black
    ctx.fill();
    ctx.shadowBlur = 0;

    // Domain-color ring — thick and bright so it reads at any panel alpha
    ctx.strokeStyle = isHovered  ? '#facc15'
                    : isSelected ? '#c864ff'
                    : fired      ? '#f59e0b'
                    : node.domainColor;
    ctx.lineWidth   = isSelected || isHovered ? 3.5 : 2.5;
    ctx.stroke();

    // Status dot (center)
    const dotR = 7;
    ctx.beginPath();
    ctx.arc(pos.cx, pos.cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = statusColor(node.machine.status);
    ctx.fill();

    // Machine name label below bubble
    const short = node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name;
    ctx.fillStyle    = isHovered ? '#facc15' : vizTheme.text.primary;
    ctx.font         = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'center';
    ctx.fillText(short, pos.cx, pos.cy + BUBBLE_R + 5, BUBBLE_CELL_W - 4);

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Expanded overlay — drawn in CSS-pixel (screen) space
  // ---------------------------------------------------------------------------

  private _drawExpandedOverlay(): void {
    const node = this._nodes.find(n => n.id === this._expandedId);
    if (!node) return;

    const t      = this._expandT;
    const vp     = this._viewport;
    const pos    = this._getBubblePos(node.id);

    // Bubble center in screen space
    const bsx = pos.cx * vp.scale + vp.tx;
    const bsy = pos.cy * vp.scale + vp.ty;

    // Final expanded card dimensions (screen pixels)
    const cardW = EXP_W;
    const cardH = Math.min(node.cardH, this._cssH - 48);

    // Clamp card center to keep it fully on-screen
    const cx = Math.max(cardW / 2 + 12, Math.min(this._cssW - cardW / 2 - 12, bsx));
    const cy = Math.max(cardH / 2 + 12, Math.min(this._cssH - cardH / 2 - 12, bsy));

    const ctx = this._ctx;
    ctx.save();

    // Dimming scrim
    if (t > 0.2) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.55, (t - 0.2) / 0.8 * 0.55)})`;
      ctx.fillRect(0, 0, this._cssW, this._cssH);
    }

    // Scale-from-center zoom effect
    const s = 0.08 + t * 0.92;  // 0.08 → 1.0
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);

    const x = cx - cardW / 2;
    const y = cy - cardH / 2;

    // Card background + border
    roundRectPath(ctx, x, y, cardW, cardH, 10);
    ctx.fillStyle = '#0e1219';
    ctx.fill();
    ctx.strokeStyle = node.domainColor;
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Domain color stripe
    roundRectPath(ctx, x, y, cardW, cardH, 10);
    ctx.save(); ctx.clip();
    ctx.fillStyle = node.domainColor;
    ctx.fillRect(x, y, 3, cardH);
    ctx.restore();

    // Header
    ctx.fillStyle = '#161c28';
    ctx.fillRect(x, y, cardW, EXP_HEADER);
    ctx.beginPath(); ctx.moveTo(x, y + EXP_HEADER); ctx.lineTo(x + cardW, y + EXP_HEADER);
    ctx.strokeStyle = node.domainColor + '44'; ctx.lineWidth = 0.5; ctx.stroke();

    // Machine name
    ctx.fillStyle    = vizTheme.text.primary;
    ctx.font         = 'bold 10px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    ctx.fillText(node.name, x + 8, y + EXP_HEADER / 2, cardW - 80);

    // Hints
    ctx.fillStyle = vizTheme.text.muted;
    ctx.font      = '8px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('dbl-click: live', x + cardW - 6, y + EXP_HEADER / 2);

    // Inner graph (fades in after the card shape appears)
    if (t > 0.5) {
      ctx.globalAlpha = (t - 0.5) / 0.5;

      const innerH = node.innerGraph.totalHeight;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + PAD, y + EXP_HEADER + PAD, INNER_W, Math.min(innerH, cardH - EXP_HEADER - EXP_FOOTER - PAD * 2));
      ctx.clip();
      ctx.translate(x + PAD, y + EXP_HEADER + PAD);
      this._drawInnerGraph(node.innerGraph, node.id);
      ctx.restore();

      // Footer
      const fy = y + cardH - EXP_FOOTER;
      ctx.fillStyle = '#0d1017';
      ctx.fillRect(x, fy, cardW, EXP_FOOTER);
      ctx.beginPath(); ctx.moveTo(x, fy); ctx.lineTo(x + cardW, fy);
      ctx.strokeStyle = vizTheme.outline.idle; ctx.lineWidth = 0.5; ctx.stroke();
      this._drawFooterAt(node, x, y, cardW, cardH);

      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  private _drawFooterAt(node: MachineNode, cx: number, cy: number, cardW: number, cardH: number): void {
    const ctx   = this._ctx;
    const midY  = cy + cardH - EXP_FOOTER / 2;
    const activeNodes = node.innerGraph.nodes.filter(n => n.isActive && !n.justFired);
    const firedNodes  = node.innerGraph.nodes.filter(n => n.justFired);
    ctx.font = '7px monospace'; ctx.textBaseline = 'middle';

    if (activeNodes.length > 0) {
      ctx.textAlign = 'left'; ctx.fillStyle = COLOR_ACTIVE; ctx.globalAlpha = 0.85;
      ctx.fillText('▸ ' + activeNodes.slice(0, 3).map(n => n.label.slice(0, 9)).join(' '), cx + 4, midY, cardW / 2 - 6);
      ctx.globalAlpha = 1;
    }
    if (firedNodes.length > 0) {
      ctx.textAlign = 'right'; ctx.fillStyle = COLOR_TERMINAL; ctx.globalAlpha = 0.9;
      ctx.fillText(firedNodes.slice(0, 3).map(n => n.label.slice(0, 9)).join(' ') + ' ↯', cx + cardW - 4, midY, cardW / 2 - 6);
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Live view — world-space graph + screen-space HUD
  // ---------------------------------------------------------------------------

  private _drawLiveViewWorld(): void {
    const node = this._nodes.find(n => n.id === this._liveViewId);
    if (!node) return;

    const ctx = this._ctx;

    // Dark full-world background
    ctx.fillStyle = '#090c10';
    ctx.fillRect(-99999, -99999, 199999, 199999);

    // Draw inner graph; positions are in inner-graph coord space (0…INNER_W × 0…totalH)
    ctx.save();
    this._drawInnerGraph(node.innerGraph, node.id);
    ctx.restore();
  }

  private _drawLiveViewHUD(): void {
    const node = this._nodes.find(n => n.id === this._liveViewId);
    if (!node) return;
    const ctx = this._ctx;

    // Header bar
    ctx.fillStyle = '#11161f';
    ctx.fillRect(0, 0, this._cssW, LIVE_HDR);
    ctx.strokeStyle = node.domainColor;
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.moveTo(0, LIVE_HDR); ctx.lineTo(this._cssW, LIVE_HDR); ctx.stroke();

    // Back button
    ctx.fillStyle = '#1e293b';
    roundRectPath(ctx, 12, 12, 72, 24, 5);
    ctx.fill();
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle    = vizTheme.text.primary;
    ctx.font         = 'bold 10px monospace';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText('← back', 22, 24);

    // Domain stripe + name
    ctx.fillStyle = node.domainColor;
    ctx.fillRect(96, 16, 3, 16);
    ctx.fillStyle    = vizTheme.text.primary;
    ctx.font         = 'bold 12px monospace';
    ctx.textAlign    = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(node.name, 107, 24, this._cssW - 120);

    // Live indicator
    const fired = node.machine.justFired;
    ctx.fillStyle = fired ? '#f59e0b' : '#22c55e';
    ctx.beginPath(); ctx.arc(this._cssW - 20, 24, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = vizTheme.text.muted; ctx.font = '8px monospace'; ctx.textAlign = 'right';
    ctx.fillText(fired ? 'FIRED' : 'LIVE', this._cssW - 30, 24);
  }

  // ---------------------------------------------------------------------------
  // Inner-graph drawing (shared between expanded card and live view)
  // ---------------------------------------------------------------------------

  private _drawInnerGraph(cache: InnerGraphCache, cardId: string): void {
    const ctx = this._ctx;

    if (cache.nodes.length === 0) {
      ctx.fillStyle = vizTheme.text.muted; ctx.font = '9px monospace';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText('no sequences', INNER_W / 2, cache.totalHeight / 2);
      return;
    }

    const isCardHovered   = this._hoveredCardId === cardId;
    const activeInnerNode = isCardHovered ? this._hoveredInnerNodeId : null;

    // Sequence band dividers
    for (let i = 0; i < cache.seqBands.length; i++) {
      const band = cache.seqBands[i];
      ctx.fillStyle = vizTheme.text.muted; ctx.font = '7px monospace';
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}`, 1, band.yStart + 1);
      if (i > 0) {
        const divY = band.yStart - DIVIDER_H / 2;
        ctx.beginPath(); ctx.moveTo(0, divY); ctx.lineTo(INNER_W, divY);
        ctx.strokeStyle = '#1a2233'; ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // Edges
    for (const edge of cache.edges) {
      const { source: s, target: t, bend } = edge;
      const isHL  = activeInnerNode ? (s.id === activeInnerNode || t.id === activeInnerNode) : false;
      const isDim = activeInnerNode ? !isHL : false;
      ctx.globalAlpha = isDim ? 0.18 : 1;
      ctx.strokeStyle = isHL ? COLOR_HOVER : vizTheme.edge.idle;
      ctx.lineWidth   = isHL ? 1.8 : 1.2;

      if (s.id === t.id) {
        this._drawSelfLoop(ctx, s);
      } else {
        const mx = (s.ix + t.ix) / 2, my = (s.iy + t.iy) / 2;
        const dx = t.ix - s.ix, dy = t.iy - s.iy;
        const len = Math.hypot(dx, dy) || 1;
        const cpx = mx + (-dy / len) * bend, cpy = my + (dx / len) * bend;
        ctx.beginPath(); ctx.moveTo(s.ix, s.iy); ctx.quadraticCurveTo(cpx, cpy, t.ix, t.iy); ctx.stroke();
        drawArrowHead(ctx, cpx, cpy, t.ix, t.iy, isHL ? COLOR_HOVER : vizTheme.edge.idle);
      }
      ctx.globalAlpha = 1;
    }

    // Nodes
    for (const node of cache.nodes) {
      const isHov  = node.id === activeInnerNode;
      const isNeig = activeInnerNode ? (cache.neighbors.get(activeInnerNode)?.has(node.id) ?? false) : false;
      const isDim  = activeInnerNode ? (!isHov && !isNeig) : false;
      ctx.globalAlpha = isDim ? 0.18 : 1;
      const fill = nodeColor(node, isHov);

      if (node.justFired)               { ctx.shadowBlur = 12; ctx.shadowColor = COLOR_TERMINAL; }
      else if (node.wasJustInitialMatched) { ctx.shadowBlur = 14; ctx.shadowColor = COLOR_INITIAL_MATCH; }
      else if (node.isActive)           { ctx.shadowBlur = 8;  ctx.shadowColor = COLOR_ACTIVE; }

      ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.shadowBlur = 0;

      if (node.hasOutput) {
        ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR_TERMINAL; ctx.lineWidth = node.justFired ? 1.5 : 1;
        ctx.globalAlpha = isDim ? 0.18 : (node.justFired ? 0.9 : 0.7); ctx.stroke();
      }
      if (node.isActive && !node.justFired && !node.hasOutput) {
        ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R + 2, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR_ACTIVE; ctx.lineWidth = 1.2;
        ctx.globalAlpha = isDim ? 0.18 : 0.8; ctx.stroke();
      }
      if (node.wasJustInitialMatched && !isHov) {
        ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR_INITIAL_MATCH; ctx.lineWidth = 1.8;
        ctx.globalAlpha = isDim ? 0.18 : 0.92; ctx.stroke();
        ctx.globalAlpha = isDim ? 0.10 : 0.30;
        ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R + 5.5, 0, Math.PI * 2);
        ctx.lineWidth = 2.5; ctx.stroke();
      }
      if (node.isInitial && !isHov && !node.wasJustInitialMatched) {
        ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R - 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = vizTheme.accent.current; ctx.lineWidth = 0.7;
        ctx.globalAlpha = isDim ? 0.18 : 0.45; ctx.stroke();
      }

      ctx.globalAlpha = isDim ? 0.18 : 1;
      ctx.beginPath(); ctx.arc(node.ix, node.iy, NODE_R, 0, Math.PI * 2);
      ctx.strokeStyle = vizTheme.bg.cardIdle; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.globalAlpha = 1;

      if (isHov && node.label) {
        ctx.fillStyle = vizTheme.text.primary; ctx.font = '7px monospace';
        ctx.textBaseline = 'top'; ctx.textAlign = 'center';
        ctx.fillText(node.label, node.ix, node.iy + NODE_R + 2, 60);
      }
      if (!activeInnerNode && (node.isInitial || node.hasOutput)) {
        ctx.fillStyle = node.isInitial ? vizTheme.accent.current : COLOR_TERMINAL;
        ctx.font = '6px monospace'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
        ctx.globalAlpha = 0.7;
        ctx.fillText(node.label.slice(0, 8), node.ix, node.iy - NODE_R - 1, 50);
        ctx.globalAlpha = 1;
      }
    }
  }

  private _drawSelfLoop(ctx: CanvasRenderingContext2D, node: InnerNode): void {
    const r = 8, ox = node.ix, oy = node.iy;
    ctx.beginPath();
    ctx.arc(ox + r, oy - r, r, Math.PI * 0.9, Math.PI * 2.1, false);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, oy - NODE_R);
    ctx.lineTo(ox - 3, oy - NODE_R - 4);
    ctx.lineTo(ox + 3, oy - NODE_R - 4);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Coordinate / hit-testing helpers
  // ---------------------------------------------------------------------------

  private _toWorld(cssX: number, cssY: number): { x: number; y: number } {
    return {
      x: (cssX - this._viewport.tx) / this._viewport.scale,
      y: (cssY - this._viewport.ty) / this._viewport.scale,
    };
  }

  private _hitTestBubble(wx: number, wy: number): MachineNode | null {
    for (const node of this._nodes) {
      const pos = this._getBubblePos(node.id);
      if (Math.hypot(wx - pos.cx, wy - pos.cy) <= BUBBLE_R + HIT_EXTRA) return node;
    }
    return null;
  }

  /** Hit test whether a CSS-pixel point is inside the currently expanded overlay card. */
  private _hitTestExpandedCard(cssX: number, cssY: number): boolean {
    if (!this._expandedId || this._expandT < 0.5) return false;
    const node = this._nodes.find(n => n.id === this._expandedId);
    if (!node) return false;
    const vp    = this._viewport;
    const pos   = this._getBubblePos(node.id);
    const bsx   = pos.cx * vp.scale + vp.tx;
    const bsy   = pos.cy * vp.scale + vp.ty;
    const cardW = EXP_W;
    const cardH = Math.min(node.cardH, this._cssH - 48);
    const cx    = Math.max(cardW / 2 + 12, Math.min(this._cssW - cardW / 2 - 12, bsx));
    const cy    = Math.max(cardH / 2 + 12, Math.min(this._cssH - cardH / 2 - 12, bsy));
    return cssX >= cx - cardW / 2 && cssX <= cx + cardW / 2
        && cssY >= cy - cardH / 2 && cssY <= cy + cardH / 2;
  }

  private _updateHover(wx: number, wy: number): void {
    const node = this._hitTestBubble(wx, wy);
    if (!node) { this._hoveredCardId = null; this._hoveredInnerNodeId = null; return; }
    this._hoveredCardId = node.id;

    // Inner-node hover for the expanded card is handled in _updateExpandedHover (has CSS coords)
    if (this._expandedId !== node.id) {
      this._hoveredInnerNodeId = null;
    }
  }

  /** Update inner-node hover for the expanded card (CSS-pixel mouse coords). */
  private _updateExpandedHover(cssX: number, cssY: number): void {
    if (!this._expandedId || this._expandT < 0.8) return;
    const node = this._nodes.find(n => n.id === this._expandedId);
    if (!node) return;
    const vp    = this._viewport;
    const pos   = this._getBubblePos(node.id);
    const bsx   = pos.cx * vp.scale + vp.tx;
    const bsy   = pos.cy * vp.scale + vp.ty;
    const cardW = EXP_W;
    const cardH = Math.min(node.cardH, this._cssH - 48);
    const cardCX = Math.max(cardW / 2 + 12, Math.min(this._cssW - cardW / 2 - 12, bsx));
    const cardCY = Math.max(cardH / 2 + 12, Math.min(this._cssH - cardH / 2 - 12, bsy));
    // Inner-graph origin in screen coords
    const igOriginX = cardCX - cardW / 2 + PAD;
    const igOriginY = cardCY - cardH / 2 + EXP_HEADER + PAD;
    const localX = cssX - igOriginX;
    const localY = cssY - igOriginY;
    let hitId: string | null = null;
    for (const n of node.innerGraph.nodes) {
      if (Math.hypot(localX - n.ix, localY - n.iy) <= NODE_R + HIT_EXTRA) { hitId = n.id; break; }
    }
    this._hoveredInnerNodeId = hitId;
  }

  // ---------------------------------------------------------------------------
  // Live view: enter / exit
  // ---------------------------------------------------------------------------

  private _enterLiveView(node: MachineNode): void {
    this._savedViewport = { ...this._viewport };
    this._liveViewId    = node.id;
    this._expandedId    = null;
    this._expandT       = 0;
    this._expandDir     = 0;
    // Frame the inner graph to fill the canvas below the HUD bar
    const g    = node.innerGraph;
    const avW  = this._cssW - 2 * PAD;
    const avH  = this._cssH - LIVE_HDR - 2 * PAD;
    const s    = Math.min(avW / Math.max(1, INNER_W), avH / Math.max(1, g.totalHeight), 5);
    this._viewport = {
      tx: (this._cssW - INNER_W * s) / 2,
      ty: LIVE_HDR + (avH - g.totalHeight * s) / 2 + PAD,
      scale: s,
    };
    this._hoveredCardId = node.id;  // keep inner-node hover active in live view
  }

  private _exitLiveView(): void {
    this._liveViewId = null;
    if (this._savedViewport) { this._viewport = this._savedViewport; this._savedViewport = null; }
    this._hoveredCardId = null;
    this._hoveredInnerNodeId = null;
  }

  // ---------------------------------------------------------------------------
  // Event binding
  // ---------------------------------------------------------------------------

  private _bindEvents(): void {
    this._canvas.addEventListener('wheel',      this._onWheel,     { passive: false });
    this._canvas.addEventListener('mousedown',  this._onMouseDown);
    this._canvas.addEventListener('mousemove',  this._onMouseMove);
    this._canvas.addEventListener('mouseup',    this._onMouseUp);
    this._canvas.addEventListener('mouseleave', this._onMouseLeave);
  }

  private _unbindEvents(): void {
    this._canvas.removeEventListener('wheel',      this._onWheel);
    this._canvas.removeEventListener('mousedown',  this._onMouseDown);
    this._canvas.removeEventListener('mousemove',  this._onMouseMove);
    this._canvas.removeEventListener('mouseup',    this._onMouseUp);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor   = Math.pow(0.95, e.deltaY / 40);
    const newScale = Math.max(0.1, Math.min(8, this._viewport.scale * factor));
    const worldX   = (e.offsetX - this._viewport.tx) / this._viewport.scale;
    const worldY   = (e.offsetY - this._viewport.ty) / this._viewport.scale;
    this._viewport.scale = newScale;
    this._viewport.tx    = e.offsetX - worldX * newScale;
    this._viewport.ty    = e.offsetY - worldY * newScale;
  };

  private _onMouseDown = (e: MouseEvent): void => {
    this._mouseDownX = e.offsetX;
    this._mouseDownY = e.offsetY;
    this._hasDragged = false;

    // Live view: only check for back-button click
    if (this._liveViewId) {
      if (e.offsetX >= 12 && e.offsetX <= 84 && e.offsetY >= 12 && e.offsetY <= 36) {
        this._exitLiveView();
      } else {
        this._isPanning = true;
      }
      return;
    }

    const wp   = this._toWorld(e.offsetX, e.offsetY);
    const node = this._hitTestBubble(wp.x, wp.y);

    if (node) {
      this._isDraggingBubble = true;
      this._dragNode         = node;
      const pos = this._getBubblePos(node.id);
      this._dragNodeStartCX = pos.cx;
      this._dragNodeStartCY = pos.cy;
      this._dragStartWorldX = wp.x;
      this._dragStartWorldY = wp.y;
      this._canvas.style.cursor = 'grabbing';
    } else if (this._expandedId && this._expandT > 0.5) {
      // Click outside expanded card → collapse
      if (!this._hitTestExpandedCard(e.offsetX, e.offsetY)) {
        this._expandDir = -1;
      }
      // Otherwise click is inside the overlay — handled on mouseUp as a collapse toggle
    } else {
      this._isPanning = true;
      this._canvas.style.cursor = 'grab';
    }
  };

  private _onMouseMove = (e: MouseEvent): void => {
    const dist = Math.hypot(e.offsetX - this._mouseDownX, e.offsetY - this._mouseDownY);
    if (dist > 3) this._hasDragged = true;

    if (this._isDraggingBubble && this._dragNode) {
      const wp = this._toWorld(e.offsetX, e.offsetY);
      const dx = wp.x - this._dragStartWorldX;
      const dy = wp.y - this._dragStartWorldY;
      this._pinnedPos.set(this._dragNode.id, {
        cx: this._dragNodeStartCX + dx,
        cy: this._dragNodeStartCY + dy,
      });
    } else if (this._isPanning) {
      this._viewport.tx += e.movementX || 0;
      this._viewport.ty += e.movementY || 0;
    } else {
      const wp = this._toWorld(e.offsetX, e.offsetY);
      this._updateHover(wp.x, wp.y);
      this._updateExpandedHover(e.offsetX, e.offsetY);
      const hovered = this._hitTestBubble(wp.x, wp.y);
      this._canvas.style.cursor = hovered ? 'pointer' : 'default';
    }
  };

  private _onMouseUp = (_e: MouseEvent): void => {
    if (this._isDraggingBubble && this._dragNode) {
      if (this._hasDragged) {
        this._saveLayout();
      } else {
        // Plain click on bubble
        const now = Date.now();
        const isDouble = now - this._lastClickTime < 300 && this._lastClickId === this._dragNode.id;

        if (isDouble) {
          // Double-click → live sequence view
          this._enterLiveView(this._dragNode);
        } else if (this._expandedId === this._dragNode.id) {
          // Click on already-expanded bubble → collapse
          this._expandDir = -1;
        } else {
          // Click on different bubble → expand
          this._expandedId = this._dragNode.id;
          this._expandT    = 0;
          this._expandDir  = 1;
          this._selectedId = this._dragNode.id;
          this._onSelectMachine(this._dragNode.id);
        }

        this._lastClickTime = now;
        this._lastClickId   = this._dragNode.id;
      }
    } else if (this._isPanning && !this._hasDragged) {
      // Click on background → collapse expanded card / deselect
      if (this._expandedId) {
        this._expandDir = -1;
      }
      this._selectedId = null;
      this._onSelectMachine(null);
    }

    this._isDraggingBubble = false;
    this._dragNode         = null;
    this._isPanning        = false;
    this._canvas.style.cursor = 'default';
  };

  private _onMouseLeave = (): void => {
    if (this._isDraggingBubble && this._dragNode && this._hasDragged) this._saveLayout();
    this._isDraggingBubble   = false;
    this._dragNode           = null;
    this._isPanning          = false;
    this._hoveredCardId      = null;
    this._hoveredInnerNodeId = null;
    this._canvas.style.cursor = 'default';
  };
}
