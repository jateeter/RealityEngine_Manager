/**
 * MachineSequenceTooltip — shared per-machine CES (Critical Event Sequence)
 * tooltip subsystem.
 *
 * Extracted verbatim from MachineGraphView so that the Machine Interconnection
 * graph can present the exact same interactive sequence graph on hover/click.
 * Contains: the embedded force-directed sequence graph (TooltipSeqGraph), the
 * per-node Event-Vector overlay (NodeEventTip), the live input/output vector
 * strips (drawVectorStrip), and the pin-able panel chrome (SequenceTooltip).
 */

import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import './MachineGraphView.css';

// ---------------------------------------------------------------------------
// Sequence tooltip — types, layout helpers, and sub-components
// ---------------------------------------------------------------------------

interface TooltipVectorElement {
  value: number;
  comparatorType: string;
  threshold?: number;
}

interface TooltipSeqNode {
  id: string;
  label: string;
  isInitial: boolean;
  hasOutput: boolean;
  elements: TooltipVectorElement[];
}

interface TooltipSeq {
  sequenceId: string;
  name: string;
  nodes: TooltipSeqNode[];
  edges: Array<{ source: string; target: string }>;
}

interface TooltipMachineData {
  id: string;
  name: string;
  description: string;
  sequences: TooltipSeq[];
}

interface TooltipState {
  machineId: string;
  name: string;
  x: number;
  y: number;
  pinned: boolean;
  data: TooltipMachineData | null;
}

// ── TooltipSeqGraph ───────────────────────────────────────────────────────────
// Force-directed sequence graph embedded in the machine tooltip.
// Visual language matches CriticalEventGraphView (same colors, drag/zoom/hover).
//
// Animation: when the engine steps and one of THIS machine's CES vectors
// activates, the corresponding node pulses cyan and any edge whose target
// just activated flashes — giving an operator a moving picture of CES
// transitions instead of a static topology snapshot.

const TT_NODE_R     = 11;
const TT_C_INITIAL  = '#3b82f6';
const TT_C_TERMINAL = '#111827';
const TT_C_DEFAULT  = '#64748b';
const TT_C_FIRED    = '#f59e0b';
const TT_EDGE_CLR   = '#e2e8f0';
const TT_C_ACTIVE   = '#06b6d4';  // pulse color for activated vectors
const TT_C_MATCHED  = '#fbbf24';  // ring for matched-but-not-fired vectors

// Live per-step state for the hovered machine — drives node pulses,
// edge flashes, and the input/output vector strips at the top and
// bottom of the tooltip SVG.  Every field is optional so the tooltip
// renders cleanly before the first WebSocket step arrives.
interface TooltipLiveResult {
  stepNumber?:   number;
  inputVector?:  number[];
  outputVector?: number[] | null;
  inputRegion?:  { offset: number; length: number };
  outputRegion?: { offset: number; length: number } | null;
  activatedIds:  Set<string>;
  matchedIds:    Set<string>;
  hasOutput:     boolean;
}

const EMPTY_LIVE: TooltipLiveResult = {
  activatedIds: new Set(),
  matchedIds:   new Set(),
  hasOutput:    false,
};

interface TTNode extends d3.SimulationNodeDatum {
  id:        string;
  label:     string;
  isInitial: boolean;
  hasOutput: boolean;
  elements:  TooltipVectorElement[];
  cx:        number;
  cy:        number;
}
interface TTLink extends d3.SimulationLinkDatum<TTNode> {
  source: string | TTNode;
  target: string | TTNode;
}

const ttFill    = (n: TTNode) => n.hasOutput ? TT_C_TERMINAL : n.isInitial ? TT_C_INITIAL : TT_C_DEFAULT;
const ttStroke  = (n: TTNode) => n.hasOutput ? TT_C_FIRED    : n.isInitial ? '#2563eb'    : '#475569';
const ttStrokeW = (n: TTNode) => n.hasOutput ? 3 : 2;

// Strip geometry — reserved at the top and bottom of the tooltip SVG
// for live input/output vector display.  The graph zoom only affects
// the middle area so the strips stay legible at all zoom levels.
const TT_STRIP_TOP_H = 30;
const TT_STRIP_BOT_H = 30;

interface NodeTipState {
  node: TTNode;
  x: number;
  y: number;
  isActive: boolean;
}

const TooltipSeqGraph: React.FC<{ sequences: TooltipSeq[]; live: TooltipLiveResult }> = ({ sequences, live }) => {
  const svgRef       = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef       = useRef<d3.Simulation<TTNode, TTLink> | null>(null);
  // Persisted selections so the live-update effect can recolour and
  // pulse nodes/edges without forcing a full simulation rebuild.
  const nodeSelRef   = useRef<d3.Selection<SVGCircleElement, TTNode, SVGGElement, unknown> | null>(null);
  const linkSelRef   = useRef<d3.Selection<SVGLineElement, TTLink, SVGGElement, unknown> | null>(null);

  // Per-node hover tooltip (Event Vector + active/inactive). Read by the d3
  // hover handlers via liveRef so they don't have to be re-bound on every step.
  const [nodeTip, setNodeTip] = useState<NodeTipState | null>(null);
  const liveRef = useRef<TooltipLiveResult>(live);
  useEffect(() => { liveRef.current = live; }, [live]);

  // ── Build / rebuild the graph (only when the sequence topology changes) ──
  useEffect(() => {
    simRef.current?.stop();
    if (!svgRef.current || !containerRef.current || !sequences.length) return;

    const W  = containerRef.current.clientWidth  || 380;
    const H  = containerRef.current.clientHeight || 300;
    const GH = Math.max(140, H - TT_STRIP_TOP_H - TT_STRIP_BOT_H);

    // Build graph data
    const nodeMap = new Map<string, TTNode>();
    const links: TTLink[] = [];

    sequences.forEach((seq, si) => {
      const angle = sequences.length > 1
        ? (si / sequences.length) * 2 * Math.PI - Math.PI / 2
        : 0;
      const r  = Math.min(W, GH) * 0.28;
      const cx = sequences.length > 1 ? W  / 2 + r * Math.cos(angle) : W  / 2;
      const cy = sequences.length > 1 ? GH / 2 + r * Math.sin(angle) : GH / 2;

      for (const n of seq.nodes) {
        if (!nodeMap.has(n.id)) {
          nodeMap.set(n.id, {
            id: n.id, label: n.label,
            isInitial: n.isInitial, hasOutput: n.hasOutput,
            elements: n.elements ?? [],
            cx, cy,
          });
        }
      }
      for (const e of seq.edges) links.push({ source: e.source, target: e.target });
    });

    const nodes = Array.from(nodeMap.values());

    // Pre-position nodes near their cluster center so the initial layout is clean
    nodes.forEach(n => {
      n.x = n.cx + (Math.random() - 0.5) * 40;
      n.y = n.cy + (Math.random() - 0.5) * 40;
    });

    // SVG setup
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', W).attr('height', H);

    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'tt-arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', TT_NODE_R + 10)
      .attr('refY', 0)
      .attr('markerWidth', 7)
      .attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', TT_EDGE_CLR);
    defs.append('marker')
      .attr('id', 'tt-arrowhead-active')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', TT_NODE_R + 10)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', TT_C_ACTIVE);

    // Strip groups — outside the zoomable graph group so they stay fixed.
    // Painted by drawVectorStrip() in the live-update effect below.
    svg.append('g')
      .attr('class', 'tt-strip-input')
      .attr('transform', 'translate(0,0)');
    svg.append('g')
      .attr('class', 'tt-strip-output')
      .attr('transform', `translate(0,${H - TT_STRIP_BOT_H})`);

    // Zoomable graph group, offset down past the top strip.
    const baseTransform = `translate(0,${TT_STRIP_TOP_H})`;
    const g = svg.append('g').attr('class', 'tt-graph').attr('transform', baseTransform);

    // Zoom / pan — strip clicks shouldn't pan the graph.
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .filter(event => {
        const t = event.target as Element | null;
        if (t?.closest?.('.tt-strip-input') || t?.closest?.('.tt-strip-output')) return false;
        return true;
      })
      .on('zoom', event => g.attr('transform', `${baseTransform} ${event.transform.toString()}`));
    svg.call(zoom);

    // Edges
    const link = g.append('g')
      .selectAll<SVGLineElement, TTLink>('line')
      .data(links)
      .join('line')
      .attr('stroke', TT_EDGE_CLR)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.45)
      .attr('marker-end', 'url(#tt-arrowhead)');
    linkSelRef.current = link;

    // Nodes
    const node = g.append('g')
      .selectAll<SVGCircleElement, TTNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', TT_NODE_R)
      .attr('fill',         d => ttFill(d))
      .attr('stroke',       d => ttStroke(d))
      .attr('stroke-width', d => ttStrokeW(d))
      .style('cursor', 'grab');
    nodeSelRef.current = node;

    // Labels
    const label = g.append('g')
      .selectAll<SVGTextElement, TTNode>('text')
      .data(nodes)
      .join('text')
      .text(d => d.label)
      .attr('font-size', 9)
      .attr('fill', '#94a3b8')
      .attr('dx', TT_NODE_R + 3)
      .attr('dy', 3)
      .style('pointer-events', 'none');

    // Drag — pin on drop
    const drag = d3.drag<SVGCircleElement, TTNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag',  (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end',   (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = d.x; d.fy = d.y;
      });
    node.call(drag as any);

    // Double-click to unpin
    node.on('dblclick', function(_, d) {
      d.fx = null; d.fy = null;
      sim.alpha(0.3).restart();
    });

    // Hover: dim non-connected nodes / edges, highlight connected, and
    // surface the per-node Event Vector + active/inactive tooltip.
    node
      .on('mouseover', function(event: MouseEvent, d) {
        d3.select(this).attr('r', TT_NODE_R + 3);
        node.style('opacity', (n: TTNode) => n.id === d.id ? 1 : 0.25);
        link.style('opacity', (l: TTLink) => {
          const src = typeof l.source === 'object' ? (l.source as TTNode).id : l.source as string;
          const tgt = typeof l.target === 'object' ? (l.target as TTNode).id : l.target as string;
          return src === d.id || tgt === d.id ? 1 : 0.06;
        });
        label.style('opacity', (n: TTNode) => n.id === d.id ? 1 : 0.15);

        const rect = containerRef.current?.getBoundingClientRect();
        const x = rect ? event.clientX - rect.left : 0;
        const y = rect ? event.clientY - rect.top  : 0;
        const liveNow = liveRef.current;
        const isActive = liveNow.activatedIds.has(d.id) || liveNow.matchedIds.has(d.id);
        setNodeTip({ node: d, x, y, isActive });
      })
      .on('mousemove', function(event: MouseEvent, d) {
        const rect = containerRef.current?.getBoundingClientRect();
        const x = rect ? event.clientX - rect.left : 0;
        const y = rect ? event.clientY - rect.top  : 0;
        const liveNow = liveRef.current;
        const isActive = liveNow.activatedIds.has(d.id) || liveNow.matchedIds.has(d.id);
        setNodeTip({ node: d, x, y, isActive });
      })
      .on('mouseout', function() {
        d3.select(this).attr('r', TT_NODE_R);
        node.style('opacity', 1);
        link.style('opacity', 0.45);
        label.style('opacity', 1);
        setNodeTip(null);
      });

    // Force simulation
    const sim = d3.forceSimulation<TTNode>(nodes)
      .force('link',      d3.forceLink<TTNode, TTLink>(links).id(d => d.id).distance(60).strength(1))
      .force('charge',    d3.forceManyBody<TTNode>().strength(-160))
      .force('collision', d3.forceCollide<TTNode>().radius(TT_NODE_R + 7))
      .force('x',         d3.forceX<TTNode>(d => d.cx).strength(0.35))
      .force('y',         d3.forceY<TTNode>(d => d.cy).strength(0.35));

    simRef.current = sim;

    sim.on('tick', () => {
      link
        .attr('x1', d => (d.source as TTNode).x ?? 0)
        .attr('y1', d => (d.source as TTNode).y ?? 0)
        .attr('x2', d => (d.target as TTNode).x ?? 0)
        .attr('y2', d => (d.target as TTNode).y ?? 0);
      node.attr('cx', d => d.x ?? 0).attr('cy', d => d.y ?? 0);
      label.attr('x', d => d.x ?? 0).attr('y', d => d.y ?? 0);
    });

    return () => { sim.stop(); };
  }, [sequences]);

  // ── Live update: animate transitions + repaint vector strips ────────────
  // Runs whenever `live` changes (every WebSocket step).  Does not touch
  // simulation forces or node positions — purely a visual overlay.
  useEffect(() => {
    if (!svgRef.current) return;
    const svg     = d3.select(svgRef.current);
    const nodeSel = nodeSelRef.current;
    const linkSel = linkSelRef.current;

    if (nodeSel) {
      nodeSel.each(function(d: TTNode) {
        const sel = d3.select(this);
        const isActivated = live.activatedIds.has(d.id);
        const isMatched   = live.matchedIds.has(d.id);
        // Cancel any in-flight transition to keep state deterministic.
        sel.interrupt();

        if (isActivated) {
          sel.attr('stroke', TT_C_ACTIVE).attr('stroke-width', 4);
          // Single pulse: radius grows then settles back.
          sel.attr('r', TT_NODE_R)
            .transition().duration(220).attr('r', TT_NODE_R + 5)
            .transition().duration(320).attr('r', TT_NODE_R);
        } else if (isMatched) {
          sel.attr('stroke', TT_C_MATCHED).attr('stroke-width', 3).attr('r', TT_NODE_R);
        } else {
          sel.attr('stroke', ttStroke(d)).attr('stroke-width', ttStrokeW(d)).attr('r', TT_NODE_R);
        }
      });
    }

    if (linkSel) {
      linkSel.each(function(d: TTLink) {
        const sel = d3.select(this);
        const tgtId = typeof d.target === 'object' ? (d.target as TTNode).id : d.target as string;
        // An edge "transitions" when its target vector activates this step —
        // that's the CES advancing from source → target.
        const isTransition = live.activatedIds.has(tgtId);
        sel.interrupt();

        if (isTransition) {
          sel.attr('stroke', TT_C_ACTIVE).attr('stroke-opacity', 0.95)
             .attr('marker-end', 'url(#tt-arrowhead-active)');
          sel.attr('stroke-width', 3)
            .transition().duration(220).attr('stroke-width', 5)
            .transition().duration(380).attr('stroke-width', 2.5);
        } else {
          sel.attr('stroke', TT_EDGE_CLR).attr('stroke-width', 1.5)
             .attr('stroke-opacity', 0.45).attr('marker-end', 'url(#tt-arrowhead)');
        }
      });
    }

    // Repaint input/output strips with the current step's vectors.
    drawVectorStrip(
      svg.select<SVGGElement>('g.tt-strip-input').node(),
      'IN', live.inputRegion, live.inputVector ?? [], live.activatedIds.size > 0,
    );
    drawVectorStrip(
      svg.select<SVGGElement>('g.tt-strip-output').node(),
      'OUT', live.outputRegion ?? null, (live.outputVector ?? []) as number[], live.hasOutput,
    );

    // Refresh the per-node hover tooltip's active flag if the cursor is
    // still parked on a node when a new engine step lands.
    setNodeTip(prev => {
      if (!prev) return prev;
      const nowActive = live.activatedIds.has(prev.node.id) || live.matchedIds.has(prev.node.id);
      return nowActive === prev.isActive ? prev : { ...prev, isActive: nowActive };
    });
  }, [live]);

  useEffect(() => () => { simRef.current?.stop(); }, []);

  if (!sequences.length) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', fontSize: 10, color: 'var(--re-text-2)', fontStyle: 'italic',
      }}>
        no sequences
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <svg ref={svgRef} style={{ width: '100%', height: '100%', cursor: 'grab' }} />
      {nodeTip && <NodeEventTip tip={nodeTip} containerRef={containerRef} />}
    </div>
  );
};

// ── NodeEventTip ─────────────────────────────────────────────────────────────
// Per-node hover overlay rendered inside the machine CES tooltip.
// Shows the event vector (elements with comparator + threshold) and an
// active/inactive badge driven by the live step state.

const NodeEventTip: React.FC<{
  tip: NodeTipState;
  containerRef: React.RefObject<HTMLDivElement>;
}> = ({ tip, containerRef }) => {
  const { node, x, y, isActive } = tip;
  const cw = containerRef.current?.clientWidth ?? 380;
  const ch = containerRef.current?.clientHeight ?? 300;
  const TIP_W = 220;
  const TIP_MAX_H = 200;
  // Flip to the other side of the cursor near the container edges so the
  // tooltip never clips outside the host machine tooltip.
  const left = x + TIP_W + 12 > cw ? Math.max(4, x - TIP_W - 12) : x + 12;
  const top  = y + TIP_MAX_H + 12 > ch ? Math.max(4, y - TIP_MAX_H - 8) : y + 8;
  return (
    <div
      style={{
        position: 'absolute', left, top, width: TIP_W, maxHeight: TIP_MAX_H,
        background: 'rgba(15, 23, 42, 0.96)',
        border: '1px solid #334155', borderRadius: 6,
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        padding: '8px 10px', pointerEvents: 'none',
        fontSize: 11, color: '#e2e8f0', zIndex: 5,
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, color: '#7dd3fc', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label}
        </span>
        <span
          style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
            padding: '2px 6px', borderRadius: 3,
            background: isActive ? '#06b6d4' : '#334155',
            color: isActive ? '#0b1220' : '#94a3b8',
          }}
        >
          {isActive ? 'ACTIVE' : 'INACTIVE'}
        </span>
      </div>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
        Event Vector ({node.elements.length})
      </div>
      <div style={{ overflowY: 'auto', background: 'rgba(2, 6, 23, 0.5)', borderRadius: 4, padding: 4 }}>
        {node.elements.length === 0 && (
          <div style={{ fontStyle: 'italic', color: '#475569', padding: '2px 4px' }}>no elements</div>
        )}
        {node.elements.map((el, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, fontFamily: 'monospace', fontSize: 10, lineHeight: '14px' }}>
            <span style={{ color: '#64748b', width: 22, textAlign: 'right' }}>[{i}]</span>
            <span style={{ color: '#22c55e', width: 50, fontWeight: 600 }}>{el.value.toFixed(3)}</span>
            <span style={{ color: '#94a3b8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {el.comparatorType}
              {el.threshold !== undefined ? ` (${el.threshold.toFixed(2)})` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// drawVectorStrip — paint a label + per-cell value visualization inside
// the supplied <g>.  Clears and re-draws on every call so the strip
// stays synchronised with the latest WebSocket step.  Cell brightness
// scales with |value| so non-zero activations are visible at a glance.
function drawVectorStrip(
  gNode: SVGGElement | null,
  kind: 'IN' | 'OUT',
  region: { offset: number; length: number } | null | undefined,
  values: number[],
  active: boolean,
): void {
  if (!gNode) return;
  const g = d3.select(gNode);
  g.selectAll('*').remove();
  const containerSvg = gNode.ownerSVGElement;
  if (!containerSvg) return;
  const W = containerSvg.clientWidth || 380;

  const LABEL_W  = 72;
  const CELL_W   = 16;
  const CELL_GAP = 2;
  const CELL_H   = 14;
  const STRIP_H  = kind === 'IN' ? TT_STRIP_TOP_H : TT_STRIP_BOT_H;
  const baseY    = (STRIP_H - CELL_H) / 2;
  const accent   = kind === 'IN' ? '#60a5fa' : '#f59e0b';

  // Backdrop strip — distinguishes the strip area from the graph above/below.
  g.append('rect')
    .attr('x', 0).attr('y', 0).attr('width', W).attr('height', STRIP_H)
    .attr('fill', kind === 'IN' ? 'rgba(59, 130, 246, 0.10)' : 'rgba(245, 158, 11, 0.10)');

  // Thin accent line separating the strip from the graph.
  g.append('line')
    .attr('x1', 0).attr('x2', W)
    .attr('y1', kind === 'IN' ? STRIP_H : 0)
    .attr('y2', kind === 'IN' ? STRIP_H : 0)
    .attr('stroke', accent).attr('stroke-opacity', 0.35).attr('stroke-width', 1);

  // Kind label + region annotation
  const labelText = region
    ? `${kind} [${region.offset}:${region.offset + region.length - 1}]`
    : `${kind}`;
  g.append('text')
    .attr('x', 6).attr('y', STRIP_H / 2 + 4)
    .attr('font-size', 9).attr('font-weight', 700)
    .attr('letter-spacing', 0.5)
    .attr('fill', kind === 'IN' ? accent : (active ? '#fbbf24' : '#94a3b8'))
    .text(labelText);

  // Capacity for cells in the remaining width
  const availW   = Math.max(0, W - LABEL_W - 8);
  const maxCells = Math.max(0, Math.floor(availW / (CELL_W + CELL_GAP)));
  const showCount = Math.min(values.length, maxCells);

  for (let i = 0; i < showCount; i++) {
    const v    = values[i] ?? 0;
    const norm = Math.max(0, Math.min(1, Math.abs(v)));
    const fill = kind === 'IN'
      ? `rgba(59, 130, 246, ${0.18 + norm * 0.72})`
      : `rgba(245, 158, 11, ${0.18 + norm * 0.72})`;
    const cx = LABEL_W + i * (CELL_W + CELL_GAP);
    g.append('rect')
      .attr('x', cx).attr('y', baseY)
      .attr('width', CELL_W).attr('height', CELL_H).attr('rx', 2)
      .attr('fill', fill)
      .attr('stroke', norm > 0.5 ? accent : 'rgba(148, 163, 184, 0.25)')
      .attr('stroke-width', norm > 0.5 ? 1 : 0.5);
    g.append('text')
      .attr('x', cx + CELL_W / 2).attr('y', baseY + CELL_H / 2 + 3)
      .attr('text-anchor', 'middle')
      .attr('font-size', 8).attr('font-weight', 600)
      .attr('fill', norm > 0.5 ? '#0b1220' : '#cbd5e1')
      .text(formatCellValue(v));
  }
  if (values.length > showCount) {
    const cx = LABEL_W + showCount * (CELL_W + CELL_GAP);
    g.append('text')
      .attr('x', cx + 2).attr('y', STRIP_H / 2 + 4)
      .attr('font-size', 9).attr('fill', '#94a3b8')
      .text(`+${values.length - showCount}`);
  }
  if (values.length === 0) {
    g.append('text')
      .attr('x', LABEL_W).attr('y', STRIP_H / 2 + 4)
      .attr('font-size', 9).attr('fill', '#475569')
      .attr('font-style', 'italic')
      .text(kind === 'IN' ? '(no input yet)' : (region ? '(no output yet)' : '(no output region)'));
  }
}

function formatCellValue(v: number): string {
  if (v === 0) return '0';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

// ── SequenceTooltip ───────────────────────────────────────────────────────────

const SequenceTooltip: React.FC<{
  tooltip: TooltipState;
  live: TooltipLiveResult;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onPin: () => void;
  onClose: () => void;
}> = ({ tooltip, live, onMouseEnter, onMouseLeave, onPin, onClose }) => {
  const { x, y, pinned, name, data } = tooltip;
  return (
    <div
      className={`mgv-tooltip${pinned ? ' mgv-tooltip-pinned' : ''}`}
      style={{ left: x, top: y }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="mgv-tooltip-header">
        <span className="mgv-tooltip-title">{name}</span>
        <div className="mgv-tooltip-btns">
          <button
            className={`mgv-tooltip-pin${pinned ? ' active' : ''}`}
            onClick={onPin}
            title={pinned ? 'Unpin' : 'Pin'}
          >⊕</button>
          <button className="mgv-tooltip-close" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {data ? (
        <>
          {data.description && (
            <div className="mgv-tooltip-desc">{data.description}</div>
          )}
          <div className="mgv-tooltip-seq-hdr">
            Event Sequences
            {live.stepNumber != null && (
              <span style={{ marginLeft: 8, color: '#94a3b8', fontWeight: 400 }}>
                · step {live.stepNumber}
                {live.activatedIds.size > 0 && (
                  <span style={{ marginLeft: 6, color: TT_C_ACTIVE, fontWeight: 700 }}>
                    {live.activatedIds.size} active
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="mgv-tooltip-body">
            <TooltipSeqGraph sequences={data.sequences} live={live} />
          </div>
          <div className="mgv-tooltip-foot">
            <span style={{ color: '#3b82f6' }}>◆ Initial</span>
            <span style={{ color: '#64748b' }}>● Intermediate</span>
            <span style={{ color: '#f59e0b' }}>○ Terminal</span>
            <span style={{ color: TT_C_ACTIVE }}>✦ Activated</span>
            <span style={{ color: TT_C_MATCHED }}>○ Matched</span>
          </div>
        </>
      ) : (
        <div className="mgv-tooltip-loading">Loading sequences…</div>
      )}
    </div>
  );
};

// ── Public surface ────────────────────────────────────────────────────────────
export { SequenceTooltip, TooltipSeqGraph, NodeEventTip, EMPTY_LIVE };
export type {
  TooltipState,
  TooltipMachineData,
  TooltipSeq,
  TooltipSeqNode,
  TooltipVectorElement,
  TooltipLiveResult,
};
