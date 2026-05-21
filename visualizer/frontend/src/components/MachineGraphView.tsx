/**
 * MachineGraphView - Visualization of machines as computational nodes
 *
 * Shows machines with their perceptual space input/output mappings
 * and visualizes the flow of data through the system.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useVisualizerStore } from '../store';
import { classifyMachine, DOMAINS, DOMAIN_ORDER, DomainId } from './machineDomains';
import { vizTheme } from '../styles/vizTheme';
import { Graph3DView } from './Graph3DView';
import { Graph3DToggle } from './Graph3DToggle';
import './MachineGraphView.css';
import './VisLegend.css';

interface MachineNode {
  id: string;
  name: string;
  description: string;
  inputMapping: { offset: number; length: number };
  outputMapping: { offset: number; length: number };
  metadata: Record<string, any>;
  // Domain classification — drives cluster hulls and per-node color accents.
  domain?: DomainId;
}

interface MachineEdge {
  source: string;
  target: string;
  sourceRegion: { offset: number; length: number };
  targetRegion: { offset: number; length: number };
  overlap: boolean;
}

interface MachineGraphData {
  nodes: MachineNode[];
  edges: MachineEdge[];
  perceptualSpaceDimension: number;
}

interface SimulationStep {
  stepNumber: number;
  timestamp: number;
  perceptualSpace: number[];
  machineResults: Record<string, {
    machineId: string;
    machineName: string;
    inputVector: number[];
    outputVector: number[] | null;
    inputRegion: { offset: number; length: number };
    outputRegion: { offset: number; length: number } | null;
    transitionResult?: {
      sequenceResults?: Record<string, {
        activatedVectors?: string[];
        matchedVectors?: string[];
      }>;
    };
  }>;
  activeRegions: Array<{
    offset: number;
    length: number;
    machineId: string;
    type: 'input' | 'output';
  }>;
}

// ── Machine color state ──────────────────────────────────────────────────────
// idle   → no meaningful transition this step
// active → sequence advanced (vectors activated) but no output yet
// fired  → final event matched, output vector produced
type MachineColorState = 'idle' | 'active' | 'fired';

function getMachineColorState(
  result: SimulationStep['machineResults'][string] | undefined,
): MachineColorState {
  if (!result) return 'idle';
  if (result.outputVector !== null && result.outputVector !== undefined) return 'fired';
  const seqResults = result.transitionResult?.sequenceResults;
  if (seqResults) {
    for (const sr of Object.values(seqResults)) {
      if ((sr.activatedVectors?.length ?? 0) > 0) return 'active';
    }
  }
  return 'idle';
}

const CARD_FIRED_FILL   = '#2d0808';
const CARD_FIRED_STROKE = '#ef4444';

// Off-white blue-grey — visible against the deep navy background.
const EDGE_IDLE_COLOR = '#8ab4cc';

// When node count exceeds this threshold, switch to compact circle layout.
const COMPACT_MODE_THRESHOLD = 100;
const COMPACT_R = 16;  // circle radius (px) in compact mode

// ---------------------------------------------------------------------------
// Sequence tooltip — extracted to a shared module so the Machine
// Interconnection graph reuses the identical interactive panel.
// ---------------------------------------------------------------------------

import {
  SequenceTooltip,
  EMPTY_LIVE,
} from './MachineSequenceTooltip';
import type {
  TooltipState,
  TooltipMachineData,
  TooltipSeqNode,
  TooltipVectorElement,
  TooltipLiveResult,
} from './MachineSequenceTooltip';

// ---------------------------------------------------------------------------
// Layout persistence
// ---------------------------------------------------------------------------

const LAYOUT_KEY = 'machine-graph-layout';

function loadLayout(): Record<string, { fx: number; fy: number }> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveLayout(nodes: d3.SimulationNodeDatum[]): void {
  const layout: Record<string, { fx: number; fy: number }> = {};
  for (const n of nodes as any[]) {
    if (n.fx != null && n.fy != null) {
      layout[n.id] = { fx: n.fx, fy: n.fy };
    }
  }
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MachineGraphView: React.FC = () => {
  const svgRef       = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // D3 objects that must persist across step updates
  const nodeSelRef      = useRef<d3.Selection<SVGGElement, MachineNode, SVGGElement, unknown> | null>(null);
  const linkSelRef      = useRef<d3.Selection<SVGPathElement, any, SVGGElement, unknown> | null>(null);
  const linkLabelSelRef = useRef<d3.Selection<SVGTextElement, any, SVGGElement, unknown> | null>(null);
  const stepTextRef     = useRef<d3.Selection<SVGTextElement, MachineNode, SVGGElement, unknown> | null>(null);
  const simRef          = useRef<d3.Simulation<MachineNode & d3.SimulationNodeDatum, undefined> | null>(null);
  const zoomTransformRef  = useRef<d3.ZoomTransform | null>(null);
  const compactModeRef    = useRef(false);

  const [tooltip,     setTooltip]     = useState<TooltipState | null>(null);
  const tooltipCacheRef = useRef<Map<string, TooltipMachineData>>(new Map());
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTooltipRef  = useRef<(id: string, name: string, x: number, y: number) => void>(() => {});

  const [graphData,   setGraphData]   = useState<MachineGraphData | null>(null);
  const [currentStep, setCurrentStep] = useState<SimulationStep | null>(null);
  const [error,       setError]       = useState<string | null>(null);
  const [dimensions,  setDimensions]  = useState({ width: 1200, height: 600 });
  const [legendOpen,  setLegendOpen]  = useState(false);
  const [is3D,        setIs3D]        = useState(false);
  // Incrementing this forces a full layout rebuild (Reset Layout)
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  // SVG is hidden until the simulation fully settles. On warm restarts
  // (saved zoom + saved positions) we reveal immediately.
  const [isReady, setIsReady] = useState(() => {
    const { graphZoomState } = useVisualizerStore.getState();
    return graphZoomState !== null && Object.keys(loadLayout()).length > 0;
  });

  const ws               = useVisualizerStore(state => state.ws);
  const loadMachine      = useVisualizerStore(state => state.loadMachine);
  const setGraphZoomState = useVisualizerStore(state => state.setGraphZoomState);
  const selectedDomains  = useVisualizerStore(state => state.selectedDomains);
  const selectedDomainsRef = useRef(selectedDomains);
  useEffect(() => { selectedDomainsRef.current = selectedDomains; }, [selectedDomains]);
  const toggleDomain     = useVisualizerStore(state => state.toggleDomain);
  const setAllDomains    = useVisualizerStore(state => state.setAllDomains);
  const loadMachineRef = useRef(loadMachine);
  useEffect(() => { loadMachineRef.current = loadMachine; }, [loadMachine]);

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const fetchGraphData = useCallback(async () => {
    try {
      const response = await fetch('/api/machine-graph');
      if (!response.ok) {
        setError(`Failed to load machine graph (HTTP ${response.status})`);
        return;
      }
      const result = await response.json();
      if (Array.isArray(result.nodes)) {
        setGraphData(result as MachineGraphData);
        setError(null);
      } else {
        setError(result.error || 'Failed to load machine graph');
      }
    } catch (err: any) {
      setError(`Error fetching graph data: ${err.message}`);
    }
  }, []);

  useEffect(() => { fetchGraphData(); }, [fetchGraphData]);

  // ── Container resize ───────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height: Math.max(height - 140, 400) });
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ── WebSocket step updates ─────────────────────────────────────────────────
  useEffect(() => {
    if (!ws) return;
    const handleMessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'perceptual-simulation-stepped') {
        setCurrentStep(data.step);
      } else if (data.type === 'perceptual-simulation-reset') {
        setCurrentStep(null);
      }
    };
    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws]);

  // ── Reset layout ───────────────────────────────────────────────────────────
  const handleResetLayout = useCallback(() => {
    try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ }
    zoomTransformRef.current = null;
    setGraphZoomState(null);
    setIsReady(false);
    setLayoutEpoch(e => e + 1);
  }, [setGraphZoomState]);

  // ── Tooltip data fetch ─────────────────────────────────────────────────────
  const showTooltip = useCallback((id: string, name: string, x: number, y: number) => {
    setTooltip(prev => {
      if (prev?.pinned) return prev;
      return { machineId: id, name, x, y, pinned: false, data: null };
    });

    const cached = tooltipCacheRef.current.get(id);
    if (cached) {
      setTooltip(prev => prev?.machineId === id ? { ...prev, data: cached } : prev);
      return;
    }

    fetch(`/api/machines/${id}/export`)
      .then(r => r.json())
      .then((json: any) => {
        const m = json.machine ?? json;
        const data: TooltipMachineData = {
          id,
          name:        m.name        ?? name,
          description: m.description ?? '',
          sequences: (m.sequences ?? []).map((seq: any) => {
            const nodes: TooltipSeqNode[] = (seq.vectors ?? []).map((v: any) => ({
              id:        v.id,
              label:     v.metadata?.name ?? v.id.slice(-6),
              isInitial: v.isInitial ?? false,
              hasOutput: Array.isArray(v.outputVectors) && v.outputVectors.length > 0,
              elements:  Array.isArray(v.elements) ? (v.elements as TooltipVectorElement[]) : [],
            }));
            const edges: Array<{ source: string; target: string }> = [];
            for (const v of (seq.vectors ?? [])) {
              for (const nid of (v.nextVectorIds ?? [])) edges.push({ source: v.id, target: nid });
            }
            return { sequenceId: seq.id, name: seq.name, nodes, edges };
          }),
        };
        tooltipCacheRef.current.set(id, data);
        setTooltip(prev => prev?.machineId === id ? { ...prev, data } : prev);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { showTooltipRef.current = showTooltip; }, [showTooltip]);

  // ── Shared domain-visibility filter ──────────────────────────────────────────
  // Called after layout rebuild AND whenever selectedDomains changes so that
  // nodes, edges (including cross-domain arcs), edge labels, hulls, and domain
  // anchor labels are all toggled consistently.
  const applyDomainFilter = useCallback(() => {
    if (!svgRef.current) return;
    const domains = selectedDomainsRef.current;
    const selected = new Set(domains);
    const allSelected = domains.length === DOMAIN_ORDER.length;

    if (nodeSelRef.current) {
      nodeSelRef.current
        .style('opacity', (d: MachineNode) =>
          allSelected || selected.has(d.domain ?? 'general') ? 1 : 0.04)
        .style('pointer-events', (d: MachineNode) =>
          allSelected || selected.has(d.domain ?? 'general') ? 'all' : 'none');
    }

    const isLinkVisible = (d: any): boolean => {
      if (allSelected) return true;
      const srcDom = (typeof d.source === 'object' ? d.source.domain : null) ?? 'general';
      const tgtDom = (typeof d.target === 'object' ? d.target.domain : null) ?? 'general';
      return selected.has(srcDom) && selected.has(tgtDom);
    };

    if (linkSelRef.current) {
      linkSelRef.current
        .style('display', (d: any) => isLinkVisible(d) ? null : 'none');
    }
    if (linkLabelSelRef.current) {
      linkLabelSelRef.current
        .style('display', (d: any) => isLinkVisible(d) ? null : 'none');
    }
    d3.select(svgRef.current)
      .selectAll<SVGPathElement, { domainId: DomainId }>('path.domain-hull')
      .style('opacity', d => allSelected || selected.has(d.domainId) ? 1 : 0);
    d3.select(svgRef.current)
      .selectAll<SVGTextElement, DomainId>('.domain-labels text')
      .style('opacity', (d: DomainId) => allSelected || selected.has(d) ? 1 : 0);
  }, []);

  // ── Layout effect — only runs on structural changes, NOT on each step ──────
  useEffect(() => {
    if (!svgRef.current || !graphData || graphData.nodes.length === 0) return;

    const svg    = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    nodeSelRef.current  = null;
    linkSelRef.current  = null;
    linkLabelSelRef.current = null;
    stepTextRef.current = null;
    simRef.current?.stop();
    simRef.current = null;

    const width  = dimensions.width;
    const height = dimensions.height;
    const margin = { top: 40, right: 40, bottom: 40, left: 40 };
    svg.attr('width', width).attr('height', height);

    const compact = graphData.nodes.length > COMPACT_MODE_THRESHOLD;
    compactModeRef.current = compact;

    // Arrowhead markers — compact mode uses smaller tips (circles are smaller than cards).
    const defs = svg.append('defs');
    ([
      { id: 'mgv-arrow',        fill: EDGE_IDLE_COLOR,      mw: compact ? 6 : 10 },
      { id: 'mgv-arrow-active', fill: vizTheme.edge.active, mw: compact ? 5 :  7 },
    ] as const).forEach(({ id, fill, mw }) => {
      defs.append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 10)
        .attr('refY', 0)
        .attr('markerWidth', mw)
        .attr('markerHeight', mw)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', fill);
    });

    // Outer group owned by zoom/pan; inner group owns margin translation
    const outerG = svg.append('g');
    const g      = outerG.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const innerWidth  = width  - margin.left - margin.right;
    const innerHeight = height - margin.top  - margin.bottom;

    // ── Pan / zoom ─────────────────────────────────────────────────────────
    // d3-drag doesn't stop mousedown propagation, so a pan would start in
    // parallel with a hull-drag unless we teach zoom to ignore events whose
    // target is a domain hull (or a node — existing drag handles those).
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.08, 4])
      .filter(event => {
        if (event.type === 'dblclick') return false;   // dblclick = navigate to machine
        const t = event.target as Element | null;
        if (t?.closest?.('.domain-hull')) return false;
        if (t?.closest?.('g.node')) return false;
        return true;
      })
      .on('zoom', (event) => {
        outerG.attr('transform', event.transform);
        zoomTransformRef.current = event.transform;
        const { k, x, y } = event.transform;
        useVisualizerStore.getState().setGraphZoomState({ k, x, y });
      });
    svg.call(zoom);
    // Restore zoom: prefer local ref (mid-session pan), then store (cross-mount).
    const storedZoom = useVisualizerStore.getState().graphZoomState;
    const restoreTransform = zoomTransformRef.current
      ?? (storedZoom ? d3.zoomIdentity.translate(storedZoom.x, storedZoom.y).scale(storedZoom.k) : null);
    if (restoreTransform) {
      svg.call(zoom.transform, restoreTransform);
      zoomTransformRef.current = restoreTransform;
    }

    // Restore saved positions before starting simulation
    const savedLayout = loadLayout();
    const spread = compact ? 60 : 160;
    const simNodes = graphData.nodes.map(n => {
      const saved = savedLayout[n.id];
      const domain = classifyMachine(n).domain;
      const anchor = DOMAINS[domain ?? 'general'].anchor;
      return Object.assign({}, n, {
        domain,
        x:  saved?.fx ?? (anchor.x * innerWidth  + (Math.random() - 0.5) * spread),
        y:  saved?.fy ?? (anchor.y * innerHeight + (Math.random() - 0.5) * spread),
        fx: saved?.fx ?? null,
        fy: saved?.fy ?? null,
      });
    }) as (MachineNode & d3.SimulationNodeDatum)[];

    const nodeById = new Map(simNodes.map(n => [n.id, n]));

    const simEdges = graphData.edges.map(e => ({
      ...e,
      source: nodeById.get(e.source) ?? e.source,
      target: nodeById.get(e.target) ?? e.target,
    }));

    // Domain anchors pull same-domain nodes toward a shared quadrant so the
    // hulls emerge as visible bubbles rather than tangled blobs in the center.
    const simulation = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink(simEdges).id((d: any) => d.id).distance(compact ? 80 : 200))
      .force('charge', d3.forceManyBody().strength(compact ? -180 : -500))
      .force('collision', d3.forceCollide().radius(compact ? COMPACT_R + 8 : 80))
      .force('domainX', d3.forceX<MachineNode & d3.SimulationNodeDatum>(
        d => DOMAINS[(d.domain ?? 'general')].anchor.x * innerWidth,
      ).strength(0.16))
      .force('domainY', d3.forceY<MachineNode & d3.SimulationNodeDatum>(
        d => DOMAINS[(d.domain ?? 'general')].anchor.y * innerHeight,
      ).strength(0.16))
      .alphaDecay(0.02);

    simRef.current = simulation as any;

    // ── Domain hull layer — sits behind edges and nodes ─────────────────────
    // Insert the hull layer BEFORE the edges/nodes are appended so that it
    // renders underneath without stealing pointer events from card hits.
    const hullLayer = g.insert('g', ':first-child').attr('class', 'domain-hulls');

    // Faint anchor labels so empty clusters are still identifiable.
    const labelLayer = g.insert('g', ':first-child').attr('class', 'domain-labels');
    labelLayer.selectAll('text')
      .data(DOMAIN_ORDER)
      .join('text')
      .attr('x', d => DOMAINS[d].anchor.x * innerWidth)
      .attr('y', d => DOMAINS[d].anchor.y * innerHeight - 110)
      .attr('text-anchor', 'middle')
      .attr('font-size', '18px')
      .attr('font-weight', 700)
      .attr('letter-spacing', '3px')
      .attr('fill', d => DOMAINS[d].color)
      .attr('opacity', 0.18)
      .attr('pointer-events', 'none')
      .text(d => DOMAINS[d].label.toUpperCase());

    // Expand each node into its bounding box corners so the hull wraps it.
    // Compact: circles (uniform radius). Full: 160×100 cards.
    const HULL_PAD  = compact ? 8 : 20;
    const nodeHW    = compact ? COMPACT_R + HULL_PAD : 80 + HULL_PAD;
    const nodeHH    = compact ? COMPACT_R + HULL_PAD : 50 + HULL_PAD;
    const cornerPoints = (n: MachineNode & d3.SimulationNodeDatum): [number, number][] => {
      const x = n.x ?? 0, y = n.y ?? 0;
      return [
        [x - nodeHW, y - nodeHH],
        [x + nodeHW, y - nodeHH],
        [x + nodeHW, y + nodeHH],
        [x - nodeHW, y + nodeHH],
      ];
    };

    // ── Domain hull drag — translate every machine in the domain together ───
    let hullDragStarts: Map<string, { x: number; y: number }> = new Map();
    let hullDragOrigin = { x: 0, y: 0 };
    const hullDrag = d3.drag<SVGPathElement, { domainId: DomainId; hull: [number, number][] | null }>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.05).restart();
        hullDragStarts = new Map();
        hullDragOrigin = { x: event.x, y: event.y };
        for (const n of simNodes) {
          if ((n.domain ?? 'general') === d.domainId) {
            hullDragStarts.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
            n.fx = n.x ?? 0;
            n.fy = n.y ?? 0;
          }
        }
        (event.sourceEvent as Event)?.stopPropagation?.();
      })
      .on('drag', (event, d) => {
        const dx = event.x - hullDragOrigin.x;
        const dy = event.y - hullDragOrigin.y;
        for (const n of simNodes) {
          if ((n.domain ?? 'general') === d.domainId) {
            const start = hullDragStarts.get(n.id);
            if (!start) continue;
            n.fx = start.x + dx;
            n.fy = start.y + dy;
          }
        }
      })
      .on('end', (event) => {
        if (!event.active) simulation.alphaTarget(0);
        saveLayout(simNodes);
      });

    const drawHulls = () => {
      const byDomain = new Map<DomainId, (MachineNode & d3.SimulationNodeDatum)[]>();
      for (const d of DOMAIN_ORDER) byDomain.set(d, []);
      for (const n of simNodes) byDomain.get((n.domain ?? 'general'))!.push(n);

      const hullData = DOMAIN_ORDER
        .map(domainId => {
          const group = byDomain.get(domainId)!;
          if (group.length === 0) return null;
          const pts: [number, number][] = [];
          for (const n of group) pts.push(...cornerPoints(n));
          const hull = pts.length >= 3 ? d3.polygonHull(pts) : pts;
          return { domainId, hull };
        })
        .filter((h): h is { domainId: DomainId; hull: [number, number][] | null } => h !== null);

      const sel = hullLayer.selectAll<SVGPathElement, typeof hullData[number]>('path.domain-hull')
        .data(hullData, (d: any) => d.domainId);

      sel.exit().remove();

      const enter = sel.enter().append('path')
        .attr('class', 'domain-hull')
        .attr('fill', d => DOMAINS[d.domainId].fill)
        .attr('stroke', d => DOMAINS[d.domainId].color)
        .attr('stroke-opacity', 0.75)
        .attr('stroke-width', 2.5)
        .attr('stroke-dasharray', '8,6')
        .attr('pointer-events', 'all')
        .style('cursor', 'grab')
        .on('mouseenter', (_event, d) => {
          useVisualizerStore.getState().setHoveredDomainId(d.domainId);
        })
        .on('mouseleave', () => {
          useVisualizerStore.getState().setHoveredDomainId(null);
        })
        .call(hullDrag as any);

      enter.merge(sel as any).attr('d', d => {
        if (!d.hull || d.hull.length === 0) return null;
        const line = d3.line<[number, number]>().curve(d3.curveCatmullRomClosed.alpha(0.6));
        return line(d.hull);
      });
    };

    // ── Edges ──────────────────────────────────────────────────────────────
    const link = g.append('g')
      .selectAll<SVGPathElement, typeof simEdges[0]>('path')
      .data(simEdges)
      .join('path')
      .attr('class', 'edge')
      .attr('fill', 'none')
      .attr('stroke', EDGE_IDLE_COLOR)
      .attr('stroke-width', 2.5)
      .attr('stroke-dasharray', '7,3')
      .attr('opacity', 0.8)
      .attr('marker-end', 'url(#mgv-arrow)');

    linkSelRef.current = link as any;

    const linkLabels = g.append('g')
      .selectAll<SVGTextElement, typeof simEdges[0]>('text')
      .data(compact ? [] : simEdges)
      .join('text')
      .attr('class', 'edge-label')
      .attr('font-size', '10px')
      .attr('fill', vizTheme.edge.label)
      .text((d: any) => {
        const sr = d.sourceRegion ?? (d.source as any).outputMapping;
        const tr = d.targetRegion ?? (d.target as any).inputMapping;
        return sr && tr
          ? `[${sr.offset}:${sr.offset + sr.length}] → [${tr.offset}:${tr.offset + tr.length}]`
          : '';
      });

    linkLabelSelRef.current = linkLabels as any;

    // ── Nodes ──────────────────────────────────────────────────────────────
    const node = g.append('g')
      .selectAll<SVGGElement, MachineNode & d3.SimulationNodeDatum>('g')
      .data(simNodes)
      .join('g')
      .attr('class', 'node');

    nodeSelRef.current = node as any;

    if (compact) {
      // ── Compact mode: bare circles, no card content ──────────────────────
      node.append('circle')
        .attr('r', COMPACT_R)
        .attr('fill', vizTheme.bg.cardIdle)
        .attr('stroke', (d: MachineNode) => DOMAINS[(d.domain ?? 'general')].color)
        .attr('stroke-width', 2);
      stepTextRef.current = null;
    } else {
      // ── Full mode: cards with name + mapping labels ───────────────────────
      node.append('rect')
        .attr('width', 160)
        .attr('height', 100)
        .attr('x', -80)
        .attr('y', -50)
        .attr('rx', 8)
        .attr('fill', vizTheme.bg.cardIdle)
        .attr('stroke', (d: MachineNode) => DOMAINS[(d.domain ?? 'general')].color)
        .attr('stroke-width', 2.5);

      node.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', -20)
        .attr('font-size', '14px')
        .attr('font-weight', 'bold')
        .attr('fill', vizTheme.text.primary)
        .text((d: MachineNode) => d.name);

      node.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 0)
        .attr('font-size', '11px')
        .attr('fill', vizTheme.accent.input)
        .text((d: MachineNode) => `In: [${d.inputMapping.offset}:${d.inputMapping.offset + d.inputMapping.length}]`);

      node.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 15)
        .attr('font-size', '11px')
        .attr('fill', vizTheme.accent.output)
        .text((d: MachineNode) => `Out: [${d.outputMapping.offset}:${d.outputMapping.offset + d.outputMapping.length}]`);

      const stepText = node.append<SVGTextElement>('text')
        .attr('text-anchor', 'middle')
        .attr('y', 35)
        .attr('font-size', '10px')
        .attr('fill', 'white');

      stepTextRef.current = stepText as any;
    }

    // ── Drag — pin on drop ────────────────────────────────────────────────
    let didDrag = false;

    const drag = d3.drag<SVGGElement, MachineNode & d3.SimulationNodeDatum>()
      .on('start', (event, d) => {
        didDrag = false;
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x ?? 0;
        d.fy = d.y ?? 0;
      })
      .on('drag', (event, d) => {
        didDrag = true;
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = d.x ?? d.fx;
        d.fy = d.y ?? d.fy;
        saveLayout(simNodes);
      });

    node.call(drag as any);

    // Double-click — navigate to that machine's interconnect view
    node.on('dblclick', (_event: any, d: any) => {
      loadMachineRef.current(d.id);
    });

    // ── Tooltip hover / click handlers ────────────────────────────────────
    node
      .on('mouseenter.tooltip', (event: MouseEvent, d: any) => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = setTimeout(() => {
          const rect = containerRef.current!.getBoundingClientRect();
          showTooltipRef.current(d.id, d.name, event.clientX - rect.left + 14, event.clientY - rect.top - 10);
        }, 180);
      })
      .on('mouseleave.tooltip', () => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = setTimeout(() => {
          setTooltip(prev => (prev?.pinned ? prev : null));
        }, 220);
      })
      .on('click.tooltip', (_event: any, d: any) => {
        if (didDrag) return;
        setTooltip(prev => {
          if (!prev || prev.machineId !== d.id) return prev;
          return prev.pinned ? null : { ...prev, pinned: true };
        });
      });

    svg.on('click.tooltip', (event: any) => {
      if (!(event.target as Element).closest?.('g.node')) {
        setTooltip(prev => (prev?.pinned ? prev : null));
      }
    });

    // ── Simulation tick ────────────────────────────────────────────────────
    // CARD_PAD offsets arrow endpoints to the node edge (card or circle).
    const CARD_PAD = compact ? COMPACT_R + 3 : 84;
    // Auto-fit: on first load (no saved zoom), zoom to show all nodes once
    // the simulation has settled enough that positions are stable.
    const shouldAutoFit = !zoomTransformRef.current;
    let autoFitDone = false;

    simulation.on('tick', () => {
      drawHulls();

      link.attr('d', (d: any) => {
        const sx = d.source.x ?? 0, sy = d.source.y ?? 0;
        const tx = d.target.x ?? 0, ty = d.target.y ?? 0;
        const dx = tx - sx, dy = ty - sy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const pad = Math.min(CARD_PAD, dist * 0.4);
        const ux = dx / dist, uy = dy / dist;
        return `M${sx + ux * pad},${sy + uy * pad}L${tx - ux * pad},${ty - uy * pad}`;
      });

      linkLabels
        .attr('x', (d: any) => (d.source.x + d.target.x) / 2)
        .attr('y', (d: any) => (d.source.y + d.target.y) / 2);

      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);

      if (!autoFitDone && shouldAutoFit && simulation.alpha() < 0.05) {
        autoFitDone = true;

        // Compute fit-to-bounds
        const xs = simNodes.map(n => n.x ?? 0);
        const ys = simNodes.map(n => n.y ?? 0);
        const halfW = compact ? COMPACT_R : 80;
        const halfH = compact ? COMPACT_R : 50;
        const fitPad = 48;
        const minX = Math.min(...xs) - halfW - fitPad;
        const maxX = Math.max(...xs) + halfW + fitPad;
        const minY = Math.min(...ys) - halfH - fitPad;
        const maxY = Math.max(...ys) + halfH + fitPad;
        const graphW = maxX - minX;
        const graphH = maxY - minY;
        const s = Math.min(
          width  / graphW,
          height / graphH,
          compact ? 1.0 : 0.85,
        );
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const fitTx = width  / 2 - s * (margin.left + cx);
        const fitTy = height / 2 - s * (margin.top  + cy);
        svg.call(zoom.transform, d3.zoomIdentity.translate(fitTx, fitTy).scale(s));

        // Pin all nodes at their settled positions so the layout is preserved
        // across view switches (nodes load from savedLayout as fx/fy next mount).
        for (const n of simNodes) { n.fx = n.x ?? null; n.fy = n.y ?? null; }
        saveLayout(simNodes);

        // Persist zoom to store — survives unmount/remount across view switches.
        useVisualizerStore.getState().setGraphZoomState({ k: s, x: fitTx, y: fitTy });

        // Reveal the graph.
        setIsReady(true);
      }
    });

    // Apply current domain visibility to the freshly created elements so arcs
    // for unchecked domains don't flash visible until the filter effect re-runs.
    applyDomainFilter();

    return () => { simulation.stop(); };
    // layoutEpoch is intentionally included so Reset Layout triggers a rebuild
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, dimensions, layoutEpoch]);

  // ── State update effect — updates node and edge appearance on each step ──────
  // Does NOT touch the simulation or positions.
  useEffect(() => {
    const node     = nodeSelRef.current;
    const link     = linkSelRef.current;
    const stepText = stepTextRef.current;
    if (!node) return;

    // ── Edge highlighting — fired-source edges glow cyan ───────────────────
    if (link) {
      const firedIds = new Set(
        currentStep
          ? Object.entries(currentStep.machineResults)
              .filter(([, r]) => r.outputVector !== null && r.outputVector !== undefined)
              .map(([id]) => id)
          : [],
      );
      link
        .classed('active', (d: any) => firedIds.has(
          typeof d.source === 'object' ? d.source.id : d.source,
        ))
        .attr('marker-end', (d: any) => {
          const srcId = typeof d.source === 'object' ? d.source.id : d.source;
          return firedIds.has(srcId) ? 'url(#mgv-arrow-active)' : 'url(#mgv-arrow)';
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeShape: d3.Selection<any, MachineNode, SVGGElement, unknown> = compactModeRef.current
      ? node.select<SVGCircleElement>('circle')
      : node.select<SVGRectElement>('rect');
    nodeShape
      .attr('fill', (d: MachineNode) => {
        const state = getMachineColorState(currentStep?.machineResults[d.id]);
        if (state === 'fired')  return CARD_FIRED_FILL;
        if (state === 'active') return vizTheme.bg.cardActive;
        return vizTheme.bg.cardIdle;
      })
      .attr('stroke', (d: MachineNode) => {
        const state = getMachineColorState(currentStep?.machineResults[d.id]);
        if (state === 'fired')  return CARD_FIRED_STROKE;
        if (state === 'active') return vizTheme.accent.input;
        return DOMAINS[(d.domain ?? 'general')].color;
      })
      .attr('stroke-width', (d: MachineNode) => {
        const state = getMachineColorState(currentStep?.machineResults[d.id]);
        if (state !== 'idle') return 3;
        return compactModeRef.current ? 2 : 2.5;
      });

    if (stepText) {
      stepText.text((d: MachineNode) => {
        const result = currentStep?.machineResults[d.id];
        if (result?.outputVector) {
          return `Output: [${result.outputVector.join(', ')}]`;
        }
        return '';
      });
    }
  }, [currentStep]);

  // ── Domain visibility filter ────────────────────────────────────────────────
  useEffect(() => {
    applyDomainFilter();
  }, [selectedDomains, applyDomainFilter]);

  // Compose live per-step result for the hovered machine.  Walks
  // sequenceResults across all of this machine's CES sequences and
  // unions the activated and matched vector IDs so the tooltip graph
  // can highlight every node that participated in this step.  MUST sit
  // above any early returns below — Rules of Hooks require hook count
  // and order to stay stable across renders.
  const tooltipLive: TooltipLiveResult = useMemo(() => {
    if (!tooltip || !currentStep) return EMPTY_LIVE;
    const r = currentStep.machineResults[tooltip.machineId];
    if (!r) return EMPTY_LIVE;
    const activated = new Set<string>();
    const matched   = new Set<string>();
    const seqResults = r.transitionResult?.sequenceResults;
    if (seqResults) {
      for (const sr of Object.values(seqResults)) {
        for (const id of sr.activatedVectors ?? []) activated.add(id);
        for (const id of sr.matchedVectors   ?? []) matched.add(id);
      }
    }
    return {
      stepNumber:   currentStep.stepNumber,
      inputVector:  r.inputVector,
      outputVector: r.outputVector,
      inputRegion:  r.inputRegion,
      outputRegion: r.outputRegion,
      activatedIds: activated,
      matchedIds:   matched,
      hasOutput:    !!r.outputVector,
    };
  }, [tooltip, currentStep]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="machine-graph-view error">
        <div className="error-message">{error}</div>
      </div>
    );
  }

  if (!graphData) {
    return (
      <div className="machine-graph-view loading">
        <div>Loading machine graph...</div>
      </div>
    );
  }

  const domainCounts = DOMAIN_ORDER.reduce((acc, d) => {
    acc[d] = graphData.nodes.filter(n => classifyMachine(n).domain === d).length;
    return acc;
  }, {} as Record<DomainId, number>);

  const isCompact = graphData.nodes.length > COMPACT_MODE_THRESHOLD;

  return (
    <div className="machine-graph-view" ref={containerRef}>
      <div className="machine-graph-svg-wrapper">

        <Graph3DToggle is3D={is3D} onToggle={() => setIs3D(v => !v)} />

        {is3D && (
          <Graph3DView mode="machines" />
        )}

        {/* ── Working overlay — shown while simulation settles ── */}
        {!is3D && !isReady && (
          <div className="mgv-working-overlay">
            <div className="mgv-working-inner">
              <div className="mgv-working-rings">
                <span /><span /><span />
              </div>
              <div className="mgv-working-label">Initializing Universe</div>
              <div className="mgv-working-sub">
                {graphData ? `${graphData.nodes.length} machines · simulation settling…` : 'Loading machine graph…'}
              </div>
            </div>
          </div>
        )}

        {/* Floating left-side legend */}
        <div className={`vis-legend-panel${legendOpen ? ' open' : ''}`}>
          <button
            className="vis-legend-tab"
            onClick={() => setLegendOpen(o => !o)}
            title={legendOpen ? 'Hide legend' : 'Show legend'}
          >
            LEGEND
          </button>
          <div className="vis-legend-content">
            <div className="vis-legend-items">
              <div className="vis-legend-item">
                <span className="vis-legend-dot" style={{ background: CARD_FIRED_FILL, border: `1.5px solid ${CARD_FIRED_STROKE}` }} />
                <span>Output fired</span>
              </div>
              <div className="vis-legend-item">
                <span className="vis-legend-dot" style={{ background: vizTheme.bg.cardActive, border: `1.5px solid ${vizTheme.accent.input}` }} />
                <span>Event active</span>
              </div>
              <div className="vis-legend-item">
                <span className="vis-legend-dot" style={{ background: vizTheme.bg.cardIdle, border: `1px solid ${vizTheme.outline.idle}` }} />
                <span>Idle</span>
              </div>
              <div className="vis-legend-divider" />
              <div className="vis-legend-item">
                <span className="vis-legend-dash" />
                <span>Data flow</span>
              </div>
              <div className="vis-legend-divider" />
              <div className="vis-legend-domain-header">
                <span style={{ fontSize: '10px', color: vizTheme.text.secondary, textTransform: 'uppercase', letterSpacing: 1 }}>Domains</span>
                <button
                  className="vis-legend-domain-toggle"
                  onClick={() => setAllDomains(selectedDomains.length < DOMAIN_ORDER.filter(d => domainCounts[d] > 0).length)}
                  title={selectedDomains.length < DOMAIN_ORDER.filter(d => domainCounts[d] > 0).length ? 'Show all' : 'Hide all'}
                >
                  {selectedDomains.length < DOMAIN_ORDER.filter(d => domainCounts[d] > 0).length ? 'All' : 'None'}
                </button>
              </div>
              {DOMAIN_ORDER.filter(d => domainCounts[d] > 0).map(d => (
                <label key={d} className="vis-legend-domain-row">
                  <input
                    type="checkbox"
                    className="vis-legend-domain-cb"
                    checked={selectedDomains.includes(d)}
                    onChange={() => toggleDomain(d)}
                  />
                  <span className="vis-legend-dot" style={{ background: DOMAINS[d].color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: '11px' }}>{DOMAINS[d].label}</span>
                  <span style={{ color: DOMAINS[d].color, fontWeight: 700, fontSize: '10px' }}>
                    {domainCounts[d]}
                  </span>
                </label>
              ))}
              <div className="vis-legend-divider" />
              <div className="vis-legend-item" style={{ color: vizTheme.text.secondary, fontSize: '10px' }}>
                Scroll to zoom · Drag to pan
              </div>
              <div className="vis-legend-item" style={{ color: vizTheme.text.secondary, fontSize: '10px' }}>
                Drag node to pin · Dbl-click to open
              </div>
              <div className="vis-legend-item" style={{ color: vizTheme.text.secondary, fontSize: '10px' }}>
                Hover for sequences · Click to pin tooltip
              </div>
              {isCompact && (
                <>
                  <div className="vis-legend-divider" />
                  <div className="vis-legend-item" style={{ color: vizTheme.accent.input, fontSize: '10px' }}>
                    ⬤ Compact ({graphData.nodes.length} nodes)
                  </div>
                </>
              )}
              <div className="vis-legend-divider" />
              <button
                className="vis-reset-layout-btn"
                onClick={handleResetLayout}
                title="Clear pinned positions and let force layout run freely"
              >
                ⊹ Reset Layout
              </button>
            </div>
          </div>
        </div>

        <svg ref={svgRef} className="machine-graph-svg" style={{ opacity: isReady && !is3D ? 1 : 0, transition: 'opacity 0.4s ease', display: is3D ? 'none' : undefined }}></svg>

        {!is3D && tooltip && (
          <SequenceTooltip
            tooltip={tooltip}
            live={tooltipLive}
            onMouseEnter={() => {
              if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
            }}
            onMouseLeave={() => {
              tooltipTimerRef.current = setTimeout(
                () => setTooltip(prev => (prev?.pinned ? prev : null)),
                220,
              );
            }}
            onPin={() => setTooltip(prev => prev ? { ...prev, pinned: !prev.pinned } : null)}
            onClose={() => setTooltip(null)}
          />
        )}
      </div>
    </div>
  );
};
