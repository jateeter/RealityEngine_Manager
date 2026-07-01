/**
 * MachineGraphView - Visualization of machines as computational nodes
 *
 * Shows machines with their perceptual space input/output mappings
 * and visualizes the flow of data through the system.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useVisualizerStore } from '../store';
import {
  classifyMachine, DOMAINS, DOMAIN_ORDER, DomainId,
  getNodeRole, NodeRole, OPENCLAW_PS_REGION,
  portalNodeId, isPortalNode, PortalNodeMetadata,
  domainLabel as getDomainLabel,
} from './machineDomains';
import {
  composeFilters,
  ALL_FILTER_NODE_TYPES,
  semanticLaneKey,
  semanticLaneLabel,
} from './graphFilters';
import { GraphFilterPanel } from './GraphFilterPanel';
import { vizTheme } from '../styles/vizTheme';
import { useTheme } from '../contexts/ThemeContext';
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
  role?: NodeRole | 'openclaw-virtual';
}

interface MachineEdge {
  source: string;
  target: string;
  sourceRegion: { offset: number; length: number };
  targetRegion: { offset: number; length: number };
  overlap: boolean;
  isAcpEdge?: boolean;
  isBusEdge?: boolean;
  isCrossDomain?: boolean;
}

interface MachineGraphData {
  nodes: MachineNode[];
  edges: MachineEdge[];
  perceptualSpaceDimension: number;
  totalMachines?: number;
}

interface PortalTooltipState {
  domainId: DomainId;
  domainLabel: string;
  domainColor: string;
  x: number; y: number;
  dispatchers: Array<{ id: string; name: string }>;
  buses: Array<{ id: string; name: string; psIn: string; psOut: string }>;
  semanticLanes: Array<{ fromDomain: string; toDomain: string }>;
  acpPsRegion: string;
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

// Default (dark-theme) fallbacks — overridden at runtime via colorsRef
const CARD_FIRED_FILL_DEFAULT   = '#2d0808';
const CARD_FIRED_STROKE_DEFAULT = '#ef4444';
const EDGE_IDLE_COLOR_DEFAULT   = '#8ab4cc';
const BUS_STROKE_DEFAULT        = '#60b4f8';
const OPENCLAW_STROKE_DEFAULT   = '#ff6b35';
const OPENCLAW_FILL_DEFAULT     = 'rgba(255,107,53,0.12)';
const ACP_EDGE_COLOR_DEFAULT    = '#ff6b35';
const BUS_EDGE_COLOR_DEFAULT    = '#60b4f8';

function hexagonPoints(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 - 30) * Math.PI / 180;
    return `${r * Math.cos(a)},${r * Math.sin(a)}`;
  }).join(' ');
}

function diamondPoints(hw: number, hh: number): string {
  return `0,${-hh} ${hw},0 0,${hh} ${-hw},0`;
}

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
  const { tokens: themeTokens, themeId } = useTheme();

  // Theme-reactive color snapshot — updated before every layout rebuild
  interface GraphColors {
    cardFiredFill:   string; cardFiredStroke: string;
    edgeIdle:        string; busStroke:       string;
    openclawStroke:  string; openclawFill:    string;
    acpEdge:         string; busEdge:         string;
  }
  const colorsRef = useRef<GraphColors>({
    cardFiredFill:   CARD_FIRED_FILL_DEFAULT,
    cardFiredStroke: CARD_FIRED_STROKE_DEFAULT,
    edgeIdle:        EDGE_IDLE_COLOR_DEFAULT,
    busStroke:       BUS_STROKE_DEFAULT,
    openclawStroke:  OPENCLAW_STROKE_DEFAULT,
    openclawFill:    OPENCLAW_FILL_DEFAULT,
    acpEdge:         ACP_EDGE_COLOR_DEFAULT,
    busEdge:         BUS_EDGE_COLOR_DEFAULT,
  });

  const svgRef       = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // D3 objects that must persist across step updates
  const nodeSelRef      = useRef<d3.Selection<SVGGElement, MachineNode, SVGGElement, unknown> | null>(null);
  const linkSelRef      = useRef<d3.Selection<SVGPathElement, any, SVGGElement, unknown> | null>(null);
  const linkLabelSelRef = useRef<d3.Selection<SVGTextElement, any, SVGGElement, unknown> | null>(null);
  const stepTextRef     = useRef<d3.Selection<SVGTextElement, MachineNode, SVGGElement, unknown> | null>(null);
  const mqttBadgeSelRef = useRef<d3.Selection<SVGGElement, MachineNode, SVGGElement, unknown> | null>(null);
  const simRef          = useRef<d3.Simulation<MachineNode & d3.SimulationNodeDatum, undefined> | null>(null);
  const zoomTransformRef  = useRef<d3.ZoomTransform | null>(null);
  const compactModeRef    = useRef(false);

  const [tooltip,     setTooltip]     = useState<TooltipState | null>(null);
  const [portalTooltip, setPortalTooltip] = useState<PortalTooltipState | null>(null);
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

  // Graph filter state (toggle actions live in GraphFilterPanel; MachineGraphView
  // only needs the state for D3 visibility updates and MQTT badge sync)
  const graphFilters       = useVisualizerStore(state => state.graphFilters);
  const graphFiltersRef    = useRef(graphFilters);
  useEffect(() => { graphFiltersRef.current = graphFilters; }, [graphFilters]);
  const setMqttMachineIds  = useVisualizerStore(state => state.setMqttMachineIds);

  // All semantic lanes available in the current graph — populated after layout build
  const [availableSemanticLanes, setAvailableSemanticLanes] = useState<Array<{ key: string; label: string }>>([]);

  // Snapshot of all sim nodes/edges for filter recomputation without layout rebuild
  const simNodesRef = useRef<Array<{ id: string; role?: string; domain?: string; inputMapping?: { offset: number; length: number } }>>([]);
  const simEdgesRef = useRef<Array<{ source: any; target: any }>>([]);

  // ── MQTT machine IDs fetch ─────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/pe/mqtt/mappings')
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data) return;
        const mappings: any[] = Array.isArray(data) ? data : (data.mappings ?? []);
        const ids = new Set<string>(
          mappings
            .map((m: any) => m.machineId ?? m.machine_id ?? m.machine ?? null)
            .filter(Boolean),
        );
        if (ids.size > 0) setMqttMachineIds(ids);
      })
      .catch(() => {/* MQTT mappings optional */});
  // Re-fetch when engine switches
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = () => {
      fetch('/api/pe/mqtt/mappings')
        .then(r => r.ok ? r.json() : null)
        .then((data: any) => {
          if (!data) return;
          const mappings: any[] = Array.isArray(data) ? data : (data.mappings ?? []);
          const ids = new Set<string>(
            mappings
              .map((m: any) => m.machineId ?? m.machine_id ?? m.machine ?? null)
              .filter(Boolean),
          );
          if (ids.size > 0) setMqttMachineIds(ids);
        })
        .catch(() => {});
    };
    window.addEventListener('re:engine-switched', handler);
    return () => window.removeEventListener('re:engine-switched', handler);
  }, [setMqttMachineIds]);

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

  useEffect(() => {
    const handler = () => { fetchGraphData(); };
    window.addEventListener('re:engine-switched', handler);
    return () => window.removeEventListener('re:engine-switched', handler);
  }, [fetchGraphData]);

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
          allSelected || selected.has(d.domain ?? 'general')
            ? 1 : 0.04)
        .style('pointer-events', (d: MachineNode) =>
          allSelected || selected.has(d.domain ?? 'general')
            ? 'all' : 'none');
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

  // ── Graph filter application ────────────────────────────────────────────────
  // Called whenever graphFilters changes. Computes visible node/edge sets then
  // applies opacity via D3 selections without rebuilding the layout.
  const applyGraphFilter = useCallback(() => {
    if (!svgRef.current) return;
    const filters = graphFiltersRef.current;
    const nodes = simNodesRef.current as any[];
    const edges = simEdgesRef.current as any[];
    if (nodes.length === 0) return;

    const { visibleNodeIds, visibleEdgeIds } = composeFilters(nodes, edges, filters);
    const isFiltered = visibleNodeIds.size < nodes.length;

    const hiddenOpacity   = 0.04;
    const visibleOpacity  = 1;

    if (nodeSelRef.current) {
      nodeSelRef.current
        .style('opacity', (d: any) =>
          visibleNodeIds.has(d.id) ? visibleOpacity : hiddenOpacity)
        .style('pointer-events', (d: any) =>
          visibleNodeIds.has(d.id) ? 'all' : 'none');
    }

    if (linkSelRef.current) {
      linkSelRef.current.style('display', (_d: any, i: number) =>
        !isFiltered || visibleEdgeIds.has(i) ? null : 'none',
      );
    }
    if (linkLabelSelRef.current) {
      linkLabelSelRef.current.style('display', (_d: any, i: number) =>
        !isFiltered || visibleEdgeIds.has(i) ? null : 'none',
      );
    }

    // Hull and label visibility: show domain if ≥1 visible node in it
    const visibleDomains = new Set(
      nodes.filter(n => visibleNodeIds.has(n.id)).map(n => n.domain ?? 'general'),
    );
    if (!isFiltered) {
      // Revert to domain-checkbox control when no graph filters active
      applyDomainFilter();
      return;
    }
    d3.select(svgRef.current)
      .selectAll<SVGPathElement, { domainId: DomainId }>('path.domain-hull')
      .style('opacity', d => visibleDomains.has(d.domainId) ? 1 : 0);
    d3.select(svgRef.current)
      .selectAll<SVGTextElement, DomainId>('.domain-labels text')
      .style('opacity', (d: DomainId) => visibleDomains.has(d) ? 1 : 0);
  }, [applyDomainFilter]);

  // ── Layout effect — only runs on structural changes, NOT on each step ──────
  useEffect(() => {
    // Sync theme-reactive colors into the closure-accessible ref before any D3 work
    colorsRef.current = {
      cardFiredFill:   themeTokens.card.firedFill,
      cardFiredStroke: themeTokens.card.firedStroke,
      edgeIdle:        themeTokens.edge.idle,
      busStroke:       themeTokens.bus.interconnectStroke,
      openclawStroke:  themeTokens.openclaw.edge,
      openclawFill:    themeTokens.openclaw.fill,
      acpEdge:         themeTokens.openclaw.edge,
      busEdge:         themeTokens.bus.interconnectStroke,
    };

    if (!svgRef.current || !graphData || graphData.nodes.length === 0) return;

    const svg    = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    nodeSelRef.current      = null;
    linkSelRef.current      = null;
    linkLabelSelRef.current = null;
    stepTextRef.current     = null;
    mqttBadgeSelRef.current = null;
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
      { id: 'mgv-arrow',        fill: colorsRef.current.edgeIdle,     mw: compact ? 6 : 10 },
      { id: 'mgv-arrow-active', fill: themeTokens.edge.active,       mw: compact ? 5 :  7 },
      { id: 'mgv-arrow-acp',    fill: colorsRef.current.acpEdge,     mw: compact ? 5 :  7 },
      { id: 'mgv-arrow-bus',    fill: colorsRef.current.busEdge,     mw: compact ? 5 :  7 },
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
        role: getNodeRole(n),
        x:  saved?.fx ?? (anchor.x * innerWidth  + (Math.random() - 0.5) * spread),
        y:  saved?.fy ?? (anchor.y * innerHeight + (Math.random() - 0.5) * spread),
        fx: saved?.fx ?? null,
        fy: saved?.fy ?? null,
      });
    }) as (MachineNode & d3.SimulationNodeDatum)[];

    const nodeById = new Map(simNodes.map(n => [n.id, n]));

    type SimEdge = Omit<MachineEdge, 'source' | 'target'> & {
      source: any; target: any; isBusEdge?: boolean; isCrossDomain?: boolean;
    };

    // Classify edges as bus or cross-domain
    const simEdges: SimEdge[] = graphData.edges.map(e => {
      const src = nodeById.get(e.source) ?? e.source;
      const tgt = nodeById.get(e.target) ?? e.target;
      const srcDomain = (typeof src === 'object' ? src.domain : null) ?? 'general';
      const tgtDomain = (typeof tgt === 'object' ? tgt.domain : null) ?? 'general';
      const srcRole   = (typeof src === 'object' ? src.role   : null) ?? 'standard';
      const tgtRole   = (typeof tgt === 'object' ? tgt.role   : null) ?? 'standard';
      return {
        ...e,
        source:        src,
        target:        tgt,
        isBusEdge:     srcRole === 'interconnect' || tgtRole === 'interconnect',
        isCrossDomain: srcDomain !== tgtDomain,
      };
    });

    // Snapshot nodes/edges for filter recomputation
    simNodesRef.current = simNodes;
    simEdgesRef.current = simEdges;

    // ── Per-domain OpenClaw portal nodes ─────────────────────────────────────
    // One virtual portal per domain that has agent-dispatchers. Sits inside the
    // domain hull and carries metadata for the portal tooltip panel.
    const dispatchersByDomain = new Map<DomainId, typeof simNodes>();
    for (const n of simNodes) {
      if (n.role !== 'agent-dispatcher') continue;
      const dom = (n.domain ?? 'general') as DomainId;
      if (!dispatchersByDomain.has(dom)) dispatchersByDomain.set(dom, []);
      dispatchersByDomain.get(dom)!.push(n);
    }

    for (const [domain, dispatchers] of dispatchersByDomain) {
      const portalId = portalNodeId(domain);
      const domDef   = DOMAINS[domain];

      // Mechanical buses: interconnect machines in the same domain
      const buses = simNodes.filter(n =>
        n.role === 'interconnect' && (n.domain ?? 'general') === domain,
      );

      // Semantic lanes: unique cross-domain pairs involving this domain
      const lanePairsSeen = new Set<string>();
      const semanticLanes: Array<{ fromDomain: string; toDomain: string }> = [];
      for (const e of simEdges) {
        if (!e.isCrossDomain) continue;
        const srcD = (typeof e.source === 'object' ? (e.source as any).domain : null) ?? 'general';
        const tgtD = (typeof e.target === 'object' ? (e.target as any).domain : null) ?? 'general';
        if (srcD !== domain && tgtD !== domain) continue;
        const key = [srcD, tgtD].sort().join('|');
        if (lanePairsSeen.has(key)) continue;
        lanePairsSeen.add(key);
        semanticLanes.push({ fromDomain: srcD, toDomain: tgtD });
      }

      const portalMeta: PortalNodeMetadata = {
        isPortal: true,
        domainId: domain,
        domainLabel: domDef.label,
        domainColor: domDef.color,
        dispatchers: dispatchers.map(d => ({ id: d.id, name: d.name })),
        buses: buses.map(b => ({
          id: b.id, name: b.name,
          psIn:  `[${b.inputMapping.offset}:${b.inputMapping.offset + b.inputMapping.length - 1}]`,
          psOut: `[${b.outputMapping.offset}:${b.outputMapping.offset + b.outputMapping.length - 1}]`,
        })),
        semanticLanes,
        acpPsRegion: `PS[${OPENCLAW_PS_REGION.offset}:${OPENCLAW_PS_REGION.offset + OPENCLAW_PS_REGION.length - 1}]`,
        dispatcherCount: dispatchers.length,
      };

      // Initial position: domain anchor, slightly pulled toward canvas center
      const ax = domDef.anchor.x * innerWidth;
      const ay = domDef.anchor.y * innerHeight;

      const portalNode = Object.assign(
        {} as MachineNode & d3.SimulationNodeDatum,
        {
          id:            portalId,
          name:          `OpenClaw Portal · ${domDef.label}`,
          description:   `Domain ACP portal — ${dispatchers.length} dispatcher(s), ${buses.length} bus(es)`,
          inputMapping:  OPENCLAW_PS_REGION,
          outputMapping: OPENCLAW_PS_REGION,
          metadata:      portalMeta,
          domain:        domain,
          role:          'openclaw-virtual' as const,
          x: ax, y: ay, fx: null, fy: null,
        },
      );
      simNodes.push(portalNode);
      nodeById.set(portalId, portalNode);

      for (const d of dispatchers) {
        simEdges.push({
          source:        d as any,
          target:        portalNode as any,
          sourceRegion:  d.outputMapping,
          targetRegion:  OPENCLAW_PS_REGION,
          overlap:       false,
          isAcpEdge:     true,
          isBusEdge:     false,
          isCrossDomain: false,
        } as SimEdge);
      }
    }

    // Update snapshots to include portal nodes/edges
    simNodesRef.current = simNodes;
    simEdgesRef.current = simEdges;

    // Collect all unique semantic lanes across all portal nodes
    const lanesSeen = new Set<string>();
    const allLanes: Array<{ key: string; label: string }> = [];
    for (const n of simNodes) {
      if (!isPortalNode(n.id)) continue;
      const meta = n.metadata as PortalNodeMetadata;
      if (!meta?.semanticLanes) continue;
      for (const lane of meta.semanticLanes) {
        const key = semanticLaneKey(lane.fromDomain, lane.toDomain);
        if (lanesSeen.has(key)) continue;
        lanesSeen.add(key);
        allLanes.push({
          key,
          label: semanticLaneLabel(key, d => getDomainLabel(d as DomainId)),
        });
      }
    }
    allLanes.sort((a, b) => a.label.localeCompare(b.label));
    setAvailableSemanticLanes(allLanes);

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

    // ── Semantic bus lanes — cross-domain coordination arcs ────────────────
    // Drawn behind hulls so domain regions still read clearly.
    // Compute domain pairs that have at least one cross-domain edge.
    const semanticLaneLayer = g.insert('g', ':first-child').attr('class', 'semantic-lanes');
    {
      const domainPairsSeen = new Set<string>();
      for (const e of simEdges) {
        if (!e.isCrossDomain) continue;
        const src = typeof e.source === 'object' ? e.source : nodeById.get(e.source as string);
        const tgt = typeof e.target === 'object' ? e.target : nodeById.get(e.target as string);
        if (!src || !tgt) continue;
        const srcD = (src as any).domain ?? 'general';
        const tgtD = (tgt as any).domain ?? 'general';
        if (srcD === tgtD) continue;
        const pairKey = [srcD, tgtD].sort().join('|');
        if (domainPairsSeen.has(pairKey)) continue;
        domainPairsSeen.add(pairKey);
        const ax = DOMAINS[srcD as DomainId].anchor.x * innerWidth;
        const ay = DOMAINS[srcD as DomainId].anchor.y * innerHeight;
        const bx = DOMAINS[tgtD as DomainId].anchor.x * innerWidth;
        const by = DOMAINS[tgtD as DomainId].anchor.y * innerHeight;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2 - 80;
        semanticLaneLayer.append('path')
          .attr('d', `M${ax},${ay} Q${mx},${my} ${bx},${by}`)
          .attr('fill', 'none')
          .attr('stroke', DOMAINS[srcD as DomainId].color)
          .attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '10,6')
          .attr('opacity', 0.14)
          .attr('pointer-events', 'none');
      }
    }

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
      for (const n of simNodes) {
        if (isPortalNode(n.id)) continue;
        byDomain.get((n.domain ?? 'general'))!.push(n);
      }

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
      .attr('class', (d: any) =>
        `edge${d.isAcpEdge ? ' acp-edge' : ''}${d.isBusEdge ? ' bus-edge' : ''}`)
      .attr('fill', 'none')
      .attr('stroke', (d: any) =>
        d.isAcpEdge ? colorsRef.current.acpEdge : d.isBusEdge ? colorsRef.current.busEdge : colorsRef.current.edgeIdle)
      .attr('stroke-width', (d: any) =>
        d.isAcpEdge ? 1.8 : d.isBusEdge ? 3 : 2.5)
      .attr('stroke-dasharray', (d: any) =>
        d.isAcpEdge ? '6,4' : '7,3')
      .attr('opacity', (d: any) =>
        d.isAcpEdge ? 0.75 : d.isBusEdge ? 0.65 : 0.8)
      .attr('marker-end', (d: any) =>
        d.isAcpEdge ? 'url(#mgv-arrow-acp)' : d.isBusEdge ? 'url(#mgv-arrow-bus)' : 'url(#mgv-arrow)');

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
      // ── Compact mode: role-differentiated shapes ─────────────────────────

      // Portal nodes: hexagon with domain color + orange ring + count badge
      node.filter((d: any) => isPortalNode(d.id))
        .append('polygon')
        .attr('points', hexagonPoints(22))
        .attr('fill', (d: any) => {
          const meta = d.metadata as PortalNodeMetadata;
          return `${meta.domainColor}22`;
        })
        .attr('stroke', colorsRef.current.openclawStroke)
        .attr('stroke-width', 2.5)
        .attr('stroke-dasharray', '5,3');

      node.filter((d: any) => isPortalNode(d.id))
        .append('polygon')
        .attr('points', hexagonPoints(16))
        .attr('fill', 'none')
        .attr('stroke', (d: any) => (d.metadata as PortalNodeMetadata).domainColor)
        .attr('stroke-width', 1.5);

      node.filter((d: any) => isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', -28)
        .attr('font-size', '8px')
        .attr('font-weight', 700)
        .attr('fill', colorsRef.current.openclawStroke)
        .attr('pointer-events', 'none')
        .text((d: any) => (d.metadata as PortalNodeMetadata).domainLabel.split(' ')[0]);

      node.filter((d: any) => isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', -18)
        .attr('font-size', '7px')
        .attr('fill', colorsRef.current.openclawStroke)
        .attr('opacity', 0.75)
        .attr('pointer-events', 'none')
        .text((d: any) => `⬡ ×${(d.metadata as PortalNodeMetadata).dispatcherCount}`);

      // Interconnect (mechanical bus): diamond shape with double ring
      node.filter((d: any) => d.role === 'interconnect')
        .append('polygon')
        .attr('points', diamondPoints(COMPACT_R + 4, COMPACT_R + 4))
        .attr('fill', 'rgba(96,180,248,0.10)')
        .attr('stroke', colorsRef.current.busStroke)
        .attr('stroke-width', 2);

      node.filter((d: any) => d.role === 'interconnect')
        .append('polygon')
        .attr('points', diamondPoints(COMPACT_R - 2, COMPACT_R - 2))
        .attr('fill', 'none')
        .attr('stroke', colorsRef.current.busStroke)
        .attr('stroke-width', 1)
        .attr('opacity', 0.45);

      node.filter((d: any) => d.role === 'interconnect')
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', COMPACT_R + 14)
        .attr('font-size', '7px')
        .attr('fill', colorsRef.current.busStroke)
        .attr('pointer-events', 'none')
        .text('BUS');

      // Agent-dispatcher: standard circle with ACP outer ring
      node.filter((d: any) => d.role === 'agent-dispatcher')
        .append('circle')
        .attr('r', COMPACT_R + 3)
        .attr('fill', 'none')
        .attr('stroke', colorsRef.current.openclawStroke)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4,2')
        .attr('opacity', 0.8);

      // Agent-dispatcher ACP badge
      node.filter((d: any) => d.role === 'agent-dispatcher')
        .append('polygon')
        .attr('points', hexagonPoints(5))
        .attr('transform', `translate(${COMPACT_R - 1},${-COMPACT_R + 1})`)
        .attr('fill', colorsRef.current.openclawStroke)
        .attr('opacity', 0.9);

      // Standard nodes — skip portals
      node.filter((d: any) => d.role === 'standard' && !isPortalNode(d.id))
        .append('circle')
        .attr('r', COMPACT_R)
        .attr('fill', vizTheme.bg.cardIdle)
        .attr('stroke', (d: MachineNode) => DOMAINS[(d.domain ?? 'general')].color)
        .attr('stroke-width', 2);

      // Agent-dispatcher inner circle
      node.filter((d: any) => d.role === 'agent-dispatcher' && !isPortalNode(d.id))
        .append('circle')
        .attr('r', COMPACT_R)
        .attr('fill', 'rgba(255,107,53,0.08)')
        .attr('stroke', (d: MachineNode) => DOMAINS[(d.domain ?? 'general')].color)
        .attr('stroke-width', 2);

      stepTextRef.current     = null;
      mqttBadgeSelRef.current = null;
    } else {
      // ── Full mode: cards with name + mapping labels ───────────────────────

      // Portal nodes: hexagon with domain-colored inner ring + orange outer ring
      node.filter((d: any) => isPortalNode(d.id))
        .append('polygon')
        .attr('points', hexagonPoints(56))
        .attr('fill', (d: any) => {
          const meta = d.metadata as PortalNodeMetadata;
          return `${meta.domainColor}18`;
        })
        .attr('stroke', colorsRef.current.openclawStroke)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '7,3');

      node.filter((d: any) => isPortalNode(d.id))
        .append('polygon')
        .attr('points', hexagonPoints(44))
        .attr('fill', 'none')
        .attr('stroke', (d: any) => (d.metadata as PortalNodeMetadata).domainColor)
        .attr('stroke-width', 2);

      node.filter((d: any) => isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', -16)
        .attr('font-size', '10px')
        .attr('font-weight', 700)
        .attr('fill', colorsRef.current.openclawStroke)
        .text(() => `⬡ OpenClaw Portal`);

      node.filter((d: any) => isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 0)
        .attr('font-size', '10px')
        .attr('fill', (d: any) => (d.metadata as PortalNodeMetadata).domainColor)
        .attr('font-weight', 600)
        .text((d: any) => (d.metadata as PortalNodeMetadata).domainLabel);

      node.filter((d: any) => isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 16)
        .attr('font-size', '9px')
        .attr('fill', vizTheme.text.secondary)
        .text((d: any) => {
          const m = d.metadata as PortalNodeMetadata;
          return `×${m.dispatcherCount} dispatch · ${m.buses.length} bus · ${m.semanticLanes.length} lane(s)`;
        });

      // Interconnect (mechanical bus): diamond card
      node.filter((d: any) => d.role === 'interconnect')
        .append('polygon')
        .attr('points', diamondPoints(100, 60))
        .attr('fill', 'rgba(96,180,248,0.08)')
        .attr('stroke', colorsRef.current.busStroke)
        .attr('stroke-width', 2.5);

      node.filter((d: any) => d.role === 'interconnect')
        .append('polygon')
        .attr('points', diamondPoints(88, 50))
        .attr('fill', 'none')
        .attr('stroke', colorsRef.current.busStroke)
        .attr('stroke-width', 1)
        .attr('opacity', 0.35);

      node.filter((d: any) => d.role === 'interconnect')
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', -10)
        .attr('font-size', '11px')
        .attr('font-weight', 700)
        .attr('fill', colorsRef.current.busStroke)
        .text((d: MachineNode) => d.name.length > 22 ? d.name.slice(0, 22) + '…' : d.name);

      node.filter((d: any) => d.role === 'interconnect')
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 8)
        .attr('font-size', '9px')
        .attr('fill', colorsRef.current.busStroke)
        .attr('letter-spacing', '0.5px')
        .text('MECHANICAL BUS');

      node.filter((d: any) => d.role === 'interconnect')
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 26)
        .attr('font-size', '10px')
        .attr('fill', vizTheme.accent.input)
        .text((d: MachineNode) => `In: [${d.inputMapping.offset}:${d.inputMapping.offset + d.inputMapping.length}]`);

      // Agent-dispatcher: standard rect + ACP ring + badge
      node.filter((d: any) => d.role === 'agent-dispatcher')
        .append('rect')
        .attr('width', 168)
        .attr('height', 108)
        .attr('x', -84)
        .attr('y', -54)
        .attr('rx', 10)
        .attr('fill', 'none')
        .attr('stroke', colorsRef.current.openclawStroke)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5,3')
        .attr('opacity', 0.65);

      // Standard cards for non-virtual standard + agent-dispatcher nodes
      node.filter((d: any) => d.role !== 'interconnect' && !isPortalNode(d.id))
        .append('rect')
        .attr('width', 160)
        .attr('height', 100)
        .attr('x', -80)
        .attr('y', -50)
        .attr('rx', 8)
        .attr('fill', vizTheme.bg.cardIdle)
        .attr('stroke', (d: MachineNode) =>
          d.role === 'agent-dispatcher'
            ? colorsRef.current.openclawStroke
            : DOMAINS[(d.domain ?? 'general')].color)
        .attr('stroke-width', 2.5);

      // ACP badge for agent-dispatchers
      node.filter((d: any) => d.role === 'agent-dispatcher')
        .append('polygon')
        .attr('points', hexagonPoints(10))
        .attr('transform', 'translate(70,-40)')
        .attr('fill', colorsRef.current.openclawStroke)
        .attr('opacity', 0.9);

      node.filter((d: any) => d.role === 'agent-dispatcher')
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('transform', 'translate(70,-40)')
        .attr('y', 4)
        .attr('font-size', '7px')
        .attr('font-weight', 700)
        .attr('fill', '#fff')
        .attr('pointer-events', 'none')
        .text('ACP');

      node.filter((d: any) => d.role !== 'interconnect' && !isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', -20)
        .attr('font-size', '14px')
        .attr('font-weight', 'bold')
        .attr('fill', vizTheme.text.primary)
        .text((d: MachineNode) => d.name);

      node.filter((d: any) => d.role !== 'interconnect' && !isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 0)
        .attr('font-size', '11px')
        .attr('fill', vizTheme.accent.input)
        .text((d: MachineNode) => `In: [${d.inputMapping.offset}:${d.inputMapping.offset + d.inputMapping.length}]`);

      node.filter((d: any) => d.role !== 'interconnect' && !isPortalNode(d.id))
        .append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 15)
        .attr('font-size', '11px')
        .attr('fill', vizTheme.accent.output)
        .text((d: MachineNode) => `Out: [${d.outputMapping.offset}:${d.outputMapping.offset + d.outputMapping.length}]`);

      const stepText = node
        .filter((d: any) => !isPortalNode(d.id))
        .append<SVGTextElement>('text')
        .attr('text-anchor', 'middle')
        .attr('y', 35)
        .attr('font-size', '10px')
        .attr('fill', 'white');

      stepTextRef.current = stepText as any;

      // ── MQTT badge — upper-left of standard/dispatcher cards ─────────────
      // Created once; visibility is toggled by a separate effect when
      // mqttMachineIds changes so the badge tracks real-time MQTT source data.
      const mqttBadge = node
        .filter((d: any) => d.role !== 'interconnect' && !isPortalNode(d.id))
        .append<SVGGElement>('g')
        .attr('class', 'mqtt-badge')
        .attr('transform', 'translate(-78, -46)')
        .attr('display', 'none')
        .attr('pointer-events', 'none');

      mqttBadge.append('rect')
        .attr('width', 34)
        .attr('height', 13)
        .attr('rx', 4)
        .attr('fill', '#0284c7')
        .attr('opacity', 0.92);

      mqttBadge.append('text')
        .attr('text-anchor', 'middle')
        .attr('x', 17)
        .attr('y', 9.5)
        .attr('font-size', '7px')
        .attr('font-weight', 700)
        .attr('fill', '#fff')
        .text('MQTT');

      mqttBadgeSelRef.current = mqttBadge as any;
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
      if (isPortalNode(d.id)) return;
      loadMachineRef.current(d.id);
    });

    // ── Tooltip hover / click handlers ────────────────────────────────────
    node
      .on('mouseenter.tooltip', (event: MouseEvent, d: any) => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        if (isPortalNode(d.id)) {
          tooltipTimerRef.current = setTimeout(() => {
            const rect = containerRef.current!.getBoundingClientRect();
            const meta = d.metadata as PortalNodeMetadata;
            setPortalTooltip({
              domainId:     meta.domainId,
              domainLabel:  meta.domainLabel,
              domainColor:  meta.domainColor,
              x: event.clientX - rect.left + 14,
              y: event.clientY - rect.top - 10,
              dispatchers:  meta.dispatchers,
              buses:        meta.buses,
              semanticLanes: meta.semanticLanes,
              acpPsRegion:  meta.acpPsRegion,
            });
          }, 180);
          return;
        }
        tooltipTimerRef.current = setTimeout(() => {
          const rect = containerRef.current!.getBoundingClientRect();
          showTooltipRef.current(d.id, d.name, event.clientX - rect.left + 14, event.clientY - rect.top - 10);
        }, 180);
      })
      .on('mouseleave.tooltip', () => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = setTimeout(() => {
          setTooltip(prev => (prev?.pinned ? prev : null));
          setPortalTooltip(null);
        }, 220);
      })
      .on('click.tooltip', (_event: any, d: any) => {
        if (didDrag) return;
        if (isPortalNode(d.id)) return; // no click-pin for portals
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
    const CARD_PAD = compact ? COMPACT_R + 8 : 84;
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
    // Apply any active graph filters immediately
    applyGraphFilter();

    return () => { simulation.stop(); };
    // layoutEpoch forces rebuild on user reset; themeId forces rebuild on theme change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, dimensions, layoutEpoch, themeId]);

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
          if (d.isAcpEdge) return 'url(#mgv-arrow-acp)';
          if (d.isBusEdge) return 'url(#mgv-arrow-bus)';
          const srcId = typeof d.source === 'object' ? d.source.id : d.source;
          return firedIds.has(srcId) ? 'url(#mgv-arrow-active)' : 'url(#mgv-arrow)';
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeShape: d3.Selection<any, MachineNode, SVGGElement, unknown> = compactModeRef.current
      ? node.filter((d: any) => d.role === 'standard').select<SVGCircleElement>('circle')
      : node.filter((d: any) => !isPortalNode(d.id) && d.role !== 'interconnect').select<SVGRectElement>('rect:last-of-type');
    nodeShape
      .attr('fill', (d: MachineNode) => {
        const state = getMachineColorState(currentStep?.machineResults[d.id]);
        if (state === 'fired')  return colorsRef.current.cardFiredFill;
        if (state === 'active') return themeTokens.bg.cardActive;
        return themeTokens.bg.cardIdle;
      })
      .attr('stroke', (d: MachineNode) => {
        const state = getMachineColorState(currentStep?.machineResults[d.id]);
        if (state === 'fired')  return colorsRef.current.cardFiredStroke;
        if (state === 'active') return themeTokens.accent.input;
        if ((d as any).role === 'agent-dispatcher') return colorsRef.current.openclawStroke;
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

  // ── Graph filter visibility ─────────────────────────────────────────────────
  useEffect(() => {
    applyGraphFilter();
  }, [graphFilters, applyGraphFilter]);

  // ── MQTT badge visibility ───────────────────────────────────────────────────
  // Show the "MQTT" badge on each card that has a known MQTT source binding.
  // Runs whenever the mqttMachineIds set changes (populated at mount from
  // /api/pe/mqtt/mappings, not on every filter toggle).
  useEffect(() => {
    const sel = mqttBadgeSelRef.current;
    if (!sel) return;
    const ids = graphFilters.mqttMachineIds;
    sel.attr('display', (d: MachineNode) => ids.has(d.id) ? null : 'none');
  }, [graphFilters.mqttMachineIds]);

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

  // Compute active filter count and visible node count for status display
  const activeFilterCount = (
    (graphFilters.enabledNodeTypes.size < ALL_FILTER_NODE_TYPES.length ? 1 : 0) +
    (graphFilters.portalFocusActive ? 1 : 0) +
    (graphFilters.mqttFocusActive ? 1 : 0) +
    (graphFilters.selectedSemanticLanes.size > 0 ? 1 : 0)
  );
  const totalNodeCount = simNodesRef.current.length;
  const visibleNodeCount = activeFilterCount > 0
    ? composeFilters(simNodesRef.current as any[], simEdgesRef.current as any[], graphFilters).visibleNodeIds.size
    : totalNodeCount;

  const isCompact = graphData.nodes.length > COMPACT_MODE_THRESHOLD;

  const corpusLoaded    = graphData.nodes.length;
  const corpusTotal     = graphData.totalMachines ?? corpusLoaded;
  const corpusCovered   = corpusLoaded >= corpusTotal;
  const busNodeCount    = graphData.nodes.filter(n => getNodeRole(n) === 'interconnect').length;
  const dispatcherCount = graphData.nodes.filter(n => getNodeRole(n) === 'agent-dispatcher').length;

  return (
    <div className="machine-graph-view" ref={containerRef}>
      <div className="machine-graph-svg-wrapper">

        <Graph3DToggle is3D={is3D} onToggle={() => setIs3D(v => !v)} />

        {is3D && (
          <Graph3DView mode="machines" />
        )}

        {/* ── Corpus coverage chip — top-right corner ── */}
        {!is3D && (
          <div style={{
            position: 'absolute', top: 8, right: 52, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(4,10,20,0.82)', border: '1px solid #1e293b',
            borderRadius: 6, padding: '3px 10px', fontSize: 10,
            fontFamily: 'ui-monospace,monospace', pointerEvents: 'none',
          }}>
            <span style={{ color: vizTheme.text.secondary }}>Corpus</span>
            <span style={{
              color: corpusCovered ? vizTheme.status.activeStroke : vizTheme.status.processingStroke,
              fontWeight: 700,
            }}>
              {corpusLoaded}
            </span>
            {!corpusCovered && (
              <span style={{ color: vizTheme.text.muted }}>/ {corpusTotal}</span>
            )}
            <span style={{ color: vizTheme.text.muted }}>·</span>
            <span style={{ color: themeTokens.bus.interconnectStroke }}>{busNodeCount} bus</span>
            {dispatcherCount > 0 && (
              <>
                <span style={{ color: themeTokens.text.muted }}>·</span>
                <span style={{ color: themeTokens.openclaw.node }}>{dispatcherCount} ACP</span>
              </>
            )}
          </div>
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
                {graphData ? `${graphData.nodes.length} machines · ${busNodeCount} bus nodes · simulation settling…` : 'Loading machine graph…'}
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
                <span className="vis-legend-dot" style={{ background: themeTokens.card.firedFill, border: `1.5px solid ${themeTokens.card.firedStroke}` }} />
                <span>Output fired</span>
              </div>
              <div className="vis-legend-item">
                <span className="vis-legend-dot" style={{ background: themeTokens.bg.cardActive, border: `1.5px solid ${themeTokens.accent.input}` }} />
                <span>Event active</span>
              </div>
              <div className="vis-legend-item">
                <span className="vis-legend-dot" style={{ background: themeTokens.bg.cardIdle, border: `1px solid ${themeTokens.outline.idle}` }} />
                <span>Idle</span>
              </div>
              <div className="vis-legend-divider" />
              <div className="vis-legend-item">
                <span className="vis-legend-dash" />
                <span>Data flow</span>
              </div>
              <div className="vis-legend-item">
                <span className="vis-legend-dash" style={{ borderColor: themeTokens.bus.interconnectStroke, borderWidth: '2px' }} />
                <span style={{ color: themeTokens.bus.interconnectStroke }}>Mechanical bus flow</span>
              </div>
              <div className="vis-legend-item">
                <span className="vis-legend-dash" style={{ borderColor: themeTokens.openclaw.edge, borderStyle: 'dashed' }} />
                <span style={{ color: themeTokens.openclaw.node }}>ACP dispatch</span>
              </div>
              <div className="vis-legend-divider" />
              <div className="vis-legend-item" style={{ fontSize: '10px', color: themeTokens.text.secondary, letterSpacing: '0.5px', fontWeight: 600, textTransform: 'uppercase' }}>
                Node Roles
              </div>
              <div className="vis-legend-item">
                <span style={{
                  display: 'inline-block', width: 12, height: 12, flexShrink: 0,
                  background: themeTokens.bus.interconnectFill, border: `1.5px solid ${themeTokens.bus.interconnectStroke}`,
                  clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                }} />
                <span style={{ color: themeTokens.bus.interconnectStroke }}>Interconnect (Mech. Bus) · {busNodeCount}</span>
              </div>
              <div className="vis-legend-item">
                <span style={{
                  display: 'inline-block', width: 12, height: 12, flexShrink: 0, borderRadius: '50%',
                  background: themeTokens.openclaw.fill, border: `1.5px dashed ${themeTokens.openclaw.edge}`,
                }} />
                <span style={{ color: themeTokens.openclaw.node }}>Agent Dispatcher (ACP) · {dispatcherCount}</span>
              </div>
              {dispatcherCount > 0 && (
                <div className="vis-legend-item">
                  <span style={{
                    display: 'inline-block', width: 12, height: 12, flexShrink: 0,
                    background: themeTokens.openclaw.fill, border: `1.5px dashed ${themeTokens.openclaw.edge}`,
                    clipPath: 'polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)',
                  }} />
                  <span style={{ color: themeTokens.openclaw.node }}>OpenClaw Domain Portal</span>
                </div>
              )}
              {/* ── Filter panel (node-type chips, focus views, semantic lanes, reset) ── */}
              <GraphFilterPanel
                availableSemanticLanes={availableSemanticLanes}
                visibleNodeCount={visibleNodeCount}
                totalNodeCount={totalNodeCount}
              />

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

        {!is3D && portalTooltip && (
          <div
            className="portal-tooltip"
            style={{
              position:   'absolute',
              left:        portalTooltip.x,
              top:         portalTooltip.y,
              zIndex:      50,
              background:  'rgba(4,10,20,0.96)',
              border:      `1px solid ${portalTooltip.domainColor}`,
              borderRadius: 8,
              padding:     '10px 14px',
              minWidth:    260,
              maxWidth:    380,
              boxShadow:   '0 4px 24px rgba(0,0,0,0.6)',
              pointerEvents: 'none',
              fontFamily:  'ui-monospace,monospace',
              fontSize:    11,
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                color: '#ff6b35', fontSize: 14, fontWeight: 700,
              }}>⬡</span>
              <span style={{ color: '#ff6b35', fontWeight: 700, fontSize: 12 }}>
                OpenClaw Portal
              </span>
              <span style={{ color: portalTooltip.domainColor, fontWeight: 600, fontSize: 11 }}>
                · {portalTooltip.domainLabel}
              </span>
            </div>

            {/* Dispatchers */}
            <div style={{ color: '#7a9ab8', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
              ACP Dispatchers ({portalTooltip.dispatchers.length})
            </div>
            {portalTooltip.dispatchers.map(d => (
              <div key={d.id} style={{ color: '#ff6b35', marginLeft: 8, marginBottom: 2, fontSize: 10 }}>
                ↯ {d.name}
              </div>
            ))}

            {/* Mechanical buses */}
            {portalTooltip.buses.length > 0 && (
              <>
                <div style={{ color: '#7a9ab8', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 8, marginBottom: 4 }}>
                  Mechanical Buses ({portalTooltip.buses.length})
                </div>
                {portalTooltip.buses.map(b => (
                  <div key={b.id} style={{ color: '#60b4f8', marginLeft: 8, marginBottom: 2, fontSize: 10 }}>
                    ◈ {b.name}
                    <span style={{ color: '#3d5a72', marginLeft: 6 }}>
                      in{b.psIn} out{b.psOut}
                    </span>
                  </div>
                ))}
              </>
            )}

            {/* Semantic lanes */}
            {portalTooltip.semanticLanes.length > 0 && (
              <>
                <div style={{ color: '#7a9ab8', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 8, marginBottom: 4 }}>
                  Semantic Lanes ({portalTooltip.semanticLanes.length})
                </div>
                {portalTooltip.semanticLanes.map((l, i) => (
                  <div key={i} style={{ color: '#9b6dff', marginLeft: 8, marginBottom: 2, fontSize: 10 }}>
                    ⟿ {DOMAINS[l.fromDomain as DomainId]?.label ?? l.fromDomain}
                    {' → '}
                    {DOMAINS[l.toDomain as DomainId]?.label ?? l.toDomain}
                  </div>
                ))}
              </>
            )}

            {/* ACP completion region */}
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #1a3352', color: '#3d5a72', fontSize: 10 }}>
              Completions return to {portalTooltip.acpPsRegion}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
