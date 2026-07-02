/**
 * MachineInterconnectionGraph - ego-centric D3.js visualization
 *
 * The selected (current) machine is pinned at the center of the viewport and
 * its directly-connected machines orbit around it. Hovering / clicking a node
 * opens the shared interactive Critical-Event-Sequence tooltip (the former
 * "Sequences" view, now embedded). A compact summary of the current machine's
 * input vector is pinned to the top of the window.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import './MachineInterconnectionGraph.css';
import { useVisualizerStore } from '../store';
import {
  classifyMachine,
  DOMAINS,
  DOMAIN_ORDER,
  DomainId,
  getNodeRole,
  NodeRole,
  OPENCLAW_PS_REGION,
  PortalNodeMetadata,
  isPortalNode,
  portalNodeId,
} from './machineDomains';
import { buildPeSourceGroups, routeArcsToBuses, type ArcTargetInfo } from './peSourceArcs';
import { vizTheme } from '../styles/vizTheme';
import { Graph3DView } from './Graph3DView';
import { Graph3DToggle } from './Graph3DToggle';
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

interface Machine {
  id: string;
  name: string;
  description: string;
  perceptualMapping?: {
    input: { offset: number; length: number };
    output: { offset: number; length: number };
    bitsPerElement?: number;
  };
  metadata?: Record<string, any>;
  sequenceCount?: number;
  severity?: string;
}

interface MachineNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  description: string;
  inputMapping: { offset: number; length: number };
  outputMapping: { offset: number; length: number };
  isCurrent: boolean;
  isConnected: boolean;
  metadata?: Record<string, any>;
  sequenceCount?: number;
  domain: DomainId;
  isExternal: boolean;
  severity?: string;
  status?: 'idle' | 'processing' | 'active';
  role?: NodeRole | 'openclaw-portal' | 'pe-source';
  peOrigin?: string;
  peSourceCount?: number;
}

interface MachineLink {
  source: string | MachineNode;
  target: string | MachineNode;
  sourceRegion: { offset: number; length: number };
  targetRegion: { offset: number; length: number };
  overlapSize: number;
  isAcpEdge?: boolean;
  isPeSourceEdge?: boolean;
  peOrigin?: string;
  peSourceCount?: number;
  peMachineCount?: number;
}

interface PortalTooltipState {
  node: MachineNode;
  x: number;
  y: number;
}

const MIG_BUS_COLOR      = '#60b4f8';
const MIG_OPENCLAW_COLOR = '#ff6b35';
const MIG_OPENCLAW_FILL  = 'rgba(255,107,53,0.10)';

// PE-source provenance colors (Manager#27). Fallback for unknown origins.
const MIG_PE_SOURCE_COLORS: Record<string, string> = {
  mqtt:      '#22c55e',
  openclaw:  '#ff6b35',
  acp:       '#ff6b35',
  ollama:    '#a78bfa',
  openai:    '#10a37f',
  healthkit: '#f472b6',
  signal:    '#facc15',
  sensor:    '#94a3b8',
};
const peSourceColor = (origin: string) => MIG_PE_SOURCE_COLORS[origin] ?? '#94a3b8';
const peSourceNodeId = (origin: string) => `pe-source:${origin}`;

// Card nodes get the 200x140 machine card; portals and PE-source pills do not.
const isCardNode = (d: { role?: NodeRole | 'openclaw-portal' | 'pe-source' }) =>
  d.role !== 'openclaw-portal' && d.role !== 'pe-source';

// Minimal slice of a PE source needed to draw feed-forward arcs.
interface PESourceLite {
  type: string;
  active: boolean;
  origin?: string;
  region?: { offset: number; length: number };
}

// Raw per-step payload from the engine. Only the fields the tooltip needs are
// typed; the WebSocket frame carries more.
interface SimulationStep {
  stepNumber: number;
  perceptualSpace: number[];
  machineResults: Record<string, {
    machineId: string;
    machineName: string;
    inputVector: number[];
    outputVector: number[] | null;
    inputRegion?: { offset: number; length: number };
    outputRegion?: { offset: number; length: number } | null;
    transitionResult?: {
      sequenceResults?: Record<string, {
        activatedVectors?: string[];
        matchedVectors?: string[];
      }>;
    };
  }>;
}

interface MachineInterconnectionGraphProps {
  currentMachineId: string;
  machines: Machine[];
}

// ── Top-of-window current-input summary ──────────────────────────────────────
// Compact strip showing the selected machine's input region slice of the
// universal perceptual space, so an operator always sees what is driving the
// machine that's centered on screen.

const InputVectorSummary: React.FC<{
  machine: Machine | undefined;
  perceptualSpace: number[];
  step: number;
}> = ({ machine, perceptualSpace, step }) => {
  if (!machine?.perceptualMapping) return null;
  const { input } = machine.perceptualMapping;
  const slice = perceptualSpace.slice(input.offset, input.offset + input.length);
  const nonZero = slice.filter(v => v !== 0).length;
  const MAX_CELLS = 48;
  const shown = slice.slice(0, MAX_CELLS);

  return (
    <div className="mig-input-summary">
      <div className="mig-input-summary-head">
        <span className="mig-input-summary-name">{machine.name}</span>
        <span className="mig-input-summary-region">
          in[{input.offset}:{input.offset + input.length - 1}]
        </span>
        <span className="mig-input-summary-meta">
          {nonZero}/{slice.length} active · step {step}
        </span>
      </div>
      <div className="mig-input-summary-cells">
        {shown.map((v, i) => {
          const norm = Math.max(0, Math.min(1, Math.abs(v)));
          return (
            <div
              key={i}
              title={`[${input.offset + i}] = ${v.toFixed(3)}`}
              className="mig-input-cell"
              style={{
                background: v !== 0
                  ? `rgba(96, 165, 250, ${0.25 + norm * 0.7})`
                  : 'rgba(30, 41, 59, 0.8)',
              }}
            >
              {norm > 0.001 ? (Number.isInteger(v) ? v : v.toFixed(1)) : ''}
            </div>
          );
        })}
        {slice.length > MAX_CELLS && (
          <span className="mig-input-cell-more">+{slice.length - MAX_CELLS}</span>
        )}
        {slice.length === 0 && (
          <span className="mig-input-cell-empty">no input region data</span>
        )}
      </div>
    </div>
  );
};

export const MachineInterconnectionGraph: React.FC<MachineInterconnectionGraphProps> = ({
  currentMachineId,
  machines,
}) => {
  const { ws, loadMachine } = useVisualizerStore();
  const loadMachineRef = useRef(loadMachine);
  useEffect(() => { loadMachineRef.current = loadMachine; }, [loadMachine]);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 700 });

  // Persist node positions + zoom across step rebuilds.
  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const zoomTransformRef = useRef<d3.ZoomTransform | null>(null);

  const [perceptualSpace, setPerceptualSpace] = useState<number[]>([]);
  const [currentStep, setCurrentStep] = useState<SimulationStep | null>(null);
  const [machineStatuses, setMachineStatuses] = useState<Record<string, {
    status: 'idle' | 'processing' | 'active';
    lastInput?: number[];
    lastOutput?: number[];
  }>>({});
  const [is3D, setIs3D] = useState(false);

  // PE sources — feed-forward provenance arcs (Manager#27).
  const [peSources, setPeSources] = useState<PESourceLite[]>([]);
  const [showPeSources, setShowPeSources] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/pe/sources');
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        const raw: PESourceLite[] = Array.isArray(j.sources) ? j.sources : [];
        // Keep only arc-relevant fields and preserve array identity when the
        // topology hasn't changed, so the 20s poll never restarts the d3
        // simulation for a no-op (lastValue churn etc. is irrelevant here).
        const next = raw.map(src => ({
          type: src.type, active: src.active, origin: src.origin, region: src.region,
        }));
        setPeSources(prev =>
          JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
      } catch { /* PE unreachable — keep last known sources */ }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  const peSensorSources = useMemo(
    () => peSources.filter(s => s.type === 'sensor' && s.active && s.region),
    [peSources],
  );
  const peOriginsPresent = useMemo(
    () => Array.from(new Set(peSensorSources.map(s => s.origin ?? 'sensor'))).sort(),
    [peSensorSources],
  );

  // ── Embedded Sequences tooltip state (shared with MachineGraphView) ────────
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [portalTooltip, setPortalTooltip] = useState<PortalTooltipState | null>(null);
  const tooltipCacheRef = useRef<Map<string, TooltipMachineData>>(new Map());
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTooltipRef = useRef<(id: string, name: string, x: number, y: number) => void>(() => {});

  // Domain filter — each entry enables/disables a whole domain cluster.
  const [enabledDomains, setEnabledDomains] = useState<Record<DomainId, boolean>>({
    healthservices: true,
    lifebalance: true,
    healthpersonal: true,
    builtspace: true,
    transportation: true,
    legalservices: true,
    communityservices: true,
    agriculture: true,
    datacenter: true,
    digitallogic: true,
    ai: true,
    general: true,
  });

  const classifications = useMemo(() => {
    const map = new Map<string, ReturnType<typeof classifyMachine>>();
    for (const m of machines) map.set(m.id, classifyMachine(m));
    return map;
  }, [machines]);

  const domainCounts = useMemo(() => {
    const counts: Record<DomainId, number> = {
      healthservices: 0, lifebalance: 0, healthpersonal: 0,
      builtspace: 0, transportation: 0, legalservices: 0,
      communityservices: 0, agriculture: 0, datacenter: 0,
      digitallogic: 0, ai: 0, general: 0,
    };
    for (const c of classifications.values()) counts[c.domain]++;
    return counts;
  }, [classifications]);

  const externalCount = useMemo(() => {
    let n = 0;
    for (const c of classifications.values()) if (c.isExternal) n++;
    return n;
  }, [classifications]);

  // Track container size.
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // WebSocket — perceptual space + per-machine runtime status + raw step.
  useEffect(() => {
    if (!ws) return;
    const handleMessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'perceptual-simulation-stepped') {
        const step: SimulationStep = data.step;
        setCurrentStep(step);
        setPerceptualSpace(step.perceptualSpace);
        const newStatuses: Record<string, any> = {};
        Object.entries(step.machineResults).forEach(([machineId, result]) => {
          newStatuses[machineId] = {
            status: result.outputVector ? 'active' : 'processing',
            lastInput: result.inputVector,
            lastOutput: result.outputVector || undefined,
          };
        });
        setMachineStatuses(newStatuses);
      } else if (data.type === 'perceptual-simulation-reset') {
        setPerceptualSpace([]);
        setMachineStatuses({});
        setCurrentStep(null);
      }
    };
    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws]);

  // ── Tooltip data fetch (per-machine sequences) ─────────────────────────────
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

  // ── Live per-step state feeding the tooltip's sequence animation ───────────
  const tooltipLive: TooltipLiveResult = useMemo(() => {
    if (!tooltip || !currentStep) return EMPTY_LIVE;
    const r = currentStep.machineResults[tooltip.machineId];
    if (!r) return EMPTY_LIVE;
    const activated = new Set<string>();
    const matched = new Set<string>();
    const seqResults = r.transitionResult?.sequenceResults;
    if (seqResults) {
      for (const sr of Object.values(seqResults)) {
        for (const id of sr.activatedVectors ?? []) activated.add(id);
        for (const id of sr.matchedVectors ?? []) matched.add(id);
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

  // ── Build the ego-centric graph ────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current || !machines || machines.length === 0) return;

    const { width, height } = dimensions;
    const cx = width / 2;
    const cy = height / 2;

    const svg = d3.select(svgRef.current);

    // Machines with mappings whose domain is enabled.
    const validMachines = machines.filter(m => {
      if (!m.perceptualMapping) return false;
      const cls = classifications.get(m.id);
      if (!cls) return true;
      return enabledDomains[cls.domain];
    });

    const currentMachine = validMachines.find(m => m.id === currentMachineId);

    if (!currentMachine || !currentMachine.perceptualMapping) {
      svg.selectAll('*').remove();
      svg.append('text')
        .attr('x', cx).attr('y', cy)
        .attr('text-anchor', 'middle')
        .attr('fill', vizTheme.text.secondary)
        .attr('font-size', '16px')
        .text('Selected machine has no perceptual mapping');
      return;
    }

    // Connected = output(current) ∩ input(other)  OR  output(other) ∩ input(current).
    const { input: curIn, output: curOut } = currentMachine.perceptualMapping;
    const connectedIds = new Set<string>();
    validMachines.forEach(m => {
      if (m.id === currentMachineId || !m.perceptualMapping) return;
      const { input: mIn, output: mOut } = m.perceptualMapping;
      const curOutEnd = curOut.offset + curOut.length;
      const mInEnd = mIn.offset + mIn.length;
      const outToIn = !(curOutEnd <= mIn.offset || curOut.offset >= mInEnd);
      const mOutEnd = mOut.offset + mOut.length;
      const curInEnd = curIn.offset + curIn.length;
      const inFromOut = !(mOutEnd <= curIn.offset || mOut.offset >= curInEnd);
      if (outToIn || inFromOut) connectedIds.add(m.id);
    });

    // Ego subgraph: the current machine + its direct neighbours only.
    const egoMachines = validMachines.filter(
      m => m.id === currentMachineId || connectedIds.has(m.id),
    );
    const neighbourCount = egoMachines.length - 1;

    const ringR = Math.min(width, height) * 0.32;

    const nodes: MachineNode[] = egoMachines.map((m, i) => {
      const cls = classifications.get(m.id)
        ?? { domain: 'general' as DomainId, isExternal: false, reason: 'missing' };
      const meta = m.metadata ?? {};
      const isCurrent = m.id === currentMachineId;
      const angle = neighbourCount > 0 ? (i / Math.max(1, neighbourCount)) * 2 * Math.PI : 0;
      const saved = nodePositionsRef.current.get(m.id);
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        inputMapping: m.perceptualMapping!.input,
        outputMapping: m.perceptualMapping!.output,
        isCurrent,
        isConnected: true,
        metadata: m.metadata,
        sequenceCount: m.sequenceCount,
        domain: cls.domain,
        isExternal: cls.isExternal,
        severity: (m as any).severity ?? meta.severity,
        status: 'idle' as const,
        role: getNodeRole(m) as NodeRole,
        x: isCurrent ? cx : (saved?.x ?? cx + ringR * Math.cos(angle)),
        y: isCurrent ? cy : (saved?.y ?? cy + ringR * Math.sin(angle)),
        fx: isCurrent ? cx : undefined,
        fy: isCurrent ? cy : undefined,
      };
    });

    // Add one OpenClaw portal inside each active domain that has dispatchers.
    const dispatcherDomains = Array.from(new Set(
      nodes.filter(n => n.role === 'agent-dispatcher').map(n => n.domain),
    ));
    for (const domain of dispatcherDomains) {
      const domainNodes = nodes.filter(n => n.domain === domain);
      const dispatchers = domainNodes.filter(n => n.role === 'agent-dispatcher');
      const buses = domainNodes.filter(n => n.role === 'interconnect');
      if (dispatchers.length === 0) continue;

      const centroidSource = buses.length > 0 ? [...dispatchers, ...buses] : dispatchers;
      const avgX = d3.mean(centroidSource, n => n.x ?? cx) ?? cx;
      const avgY = d3.mean(centroidSource, n => n.y ?? cy) ?? cy;
      const id = portalNodeId(domain);
      const saved = nodePositionsRef.current.get(id);
      const portalMetadata: PortalNodeMetadata = {
        isPortal: true,
        domainId: domain,
        domainLabel: DOMAINS[domain].label,
        domainColor: DOMAINS[domain].color,
        dispatchers: dispatchers.map(n => ({ id: n.id, name: n.name })),
        buses: buses.map(n => ({
          id: n.id,
          name: n.name,
          psIn: `[${n.inputMapping.offset}:${n.inputMapping.offset + n.inputMapping.length - 1}]`,
          psOut: `[${n.outputMapping.offset}:${n.outputMapping.offset + n.outputMapping.length - 1}]`,
        })),
        semanticLanes: [],
        acpPsRegion: `PS[${OPENCLAW_PS_REGION.offset}:${OPENCLAW_PS_REGION.offset + OPENCLAW_PS_REGION.length - 1}]`,
        dispatcherCount: dispatchers.length,
      };

      nodes.push({
        id,
        name: `OpenClaw Portal - ${DOMAINS[domain].label}`,
        description: `Domain-local OpenClaw xACP portal for ${DOMAINS[domain].label}`,
        inputMapping: OPENCLAW_PS_REGION,
        outputMapping: OPENCLAW_PS_REGION,
        isCurrent: false,
        isConnected: true,
        metadata: portalMetadata,
        domain,
        isExternal: false,
        role: 'openclaw-portal',
        x: saved?.x ?? avgX + 120,
        y: saved?.y ?? avgY - 80,
      });
    }

    const nodeIds = new Set(nodes.map(n => n.id));
    const links: MachineLink[] = [];
    for (const sourceM of egoMachines) {
      if (!sourceM.perceptualMapping) continue;
      for (const targetM of egoMachines) {
        if (sourceM.id === targetM.id || !targetM.perceptualMapping) continue;
        const so = sourceM.perceptualMapping.output;
        const ti = targetM.perceptualMapping.input;
        const sEnd = so.offset + so.length;
        const tEnd = ti.offset + ti.length;
        const oStart = Math.max(so.offset, ti.offset);
        const oEnd = Math.min(sEnd, tEnd);
        if (oStart < oEnd && nodeIds.has(sourceM.id) && nodeIds.has(targetM.id)) {
          links.push({
            source: sourceM.id,
            target: targetM.id,
            sourceRegion: so,
            targetRegion: ti,
            overlapSize: oEnd - oStart,
          });
        }
      }
    }

    // ACP dispatch edges: agent-dispatcher nodes -> their domain-local portal.
    for (const n of nodes) {
      if (n.role !== 'agent-dispatcher') continue;
      const target = portalNodeId(n.domain);
      if (!nodeIds.has(target)) continue;
      links.push({
        source: n.id,
        target,
        sourceRegion: n.outputMapping,
        targetRegion: OPENCLAW_PS_REGION,
        overlapSize: 0,
        isAcpEdge: true,
      });
    }

    // PE-source provenance nodes (Manager#27): integration-fed sensor sources
    // (MQTT / OpenClaw / Ollama / HealthKit / bare signals) whose region
    // overlaps an ego machine's input mapping, grouped per provenance and
    // drawn as feed-forward arcs into the machines they stimulate.
    // Test/simulated sources are excluded: they exist per-machine and would
    // add one arc per machine without conveying interconnection.
    if (showPeSources && peSensorSources.length > 0) {
      const peGroups = buildPeSourceGroups(peSensorSources, egoMachines);
      let gi = 0;
      for (const [origin, gr] of peGroups) {
        const id = peSourceNodeId(origin);
        const saved = nodePositionsRef.current.get(id);
        const angle = (gi++ / Math.max(1, peGroups.size)) * 2 * Math.PI - Math.PI / 2;
        nodes.push({
          id,
          name: `PE Sources · ${origin}`,
          description: `${gr.sourceCount} ${origin} source(s) feeding this neighbourhood`,
          inputMapping: gr.envelope,
          outputMapping: gr.envelope,
          isCurrent: false,
          isConnected: true,
          domain: 'general' as DomainId,
          isExternal: false,
          role: 'pe-source',
          peOrigin: origin,
          peSourceCount: gr.sourceCount,
          x: saved?.x ?? cx + ringR * 1.7 * Math.cos(angle),
          y: saved?.y ?? cy + ringR * 1.7 * Math.sin(angle),
        });
        // Phase 2: aggregate onto the domain bus (>=3 targets) or, for
        // OpenClaw-fed groups, terminate on the domain portal (the ACP
        // completion "return" arc).
        const targetInfo = new Map<string, ArcTargetInfo>();
        for (const targetId of gr.perTarget.keys()) {
          const tn = nodes.find(nn => nn.id === targetId);
          if (!tn) continue;
          const bus = nodes.find(nn => nn.domain === tn.domain && nn.role === 'interconnect');
          const pid = portalNodeId(tn.domain);
          targetInfo.set(targetId, {
            domain: tn.domain,
            busId: bus?.id,
            portalId: nodeIds.has(pid) ? pid : undefined,
          });
        }
        for (const arc of routeArcsToBuses(gr.perTarget, targetInfo, origin)) {
          links.push({
            source: id,
            target: arc.terminatorId,
            sourceRegion: gr.envelope,
            targetRegion: arc.targetRegion,
            overlapSize: arc.overlap,
            isPeSourceEdge: true,
            peOrigin: origin,
            peSourceCount: arc.count,
            peMachineCount: arc.machineIds.length,
          });
        }
      }
    }

    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);
    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .filter(event => {
        if (event.type === 'dblclick') return false;
        const t = event.target as Element | null;
        if (t?.closest?.('g.node')) return false;
        return true;
      })
      .on('zoom', (event) => {
        zoomTransformRef.current = event.transform;
        g.attr('transform', event.transform);
      });
    svg.call(zoom as any);
    if (zoomTransformRef.current) {
      svg.call((zoom as any).transform, zoomTransformRef.current);
    }

    // Ego forces: neighbours orbit the pinned current node.
    const simulation = d3.forceSimulation(nodes as any)
      .force('link', d3.forceLink(links).id((d: any) => d.id)
        .distance(220).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-1100))
      .force('collision', d3.forceCollide().radius(120))
      .force('radial', d3.forceRadial<MachineNode>(
        d => d.isCurrent ? 0 : Math.min(width, height) * 0.32, cx, cy,
      ).strength(d => d.isCurrent ? 0 : 0.55))
      .force('center', d3.forceX<MachineNode>(cx).strength(0.02))
      .force('centerY', d3.forceY<MachineNode>(cy).strength(0.02));

    // Links
    const link = g.append('g').attr('class', 'links').selectAll('g').data(links).join('g');

    const endpointNodes = (d: MachineLink) => {
      const sId = typeof d.source === 'string' ? d.source : d.source.id;
      const tId = typeof d.target === 'string' ? d.target : d.target.id;
      return {
        s: nodes.find(n => n.id === sId),
        t: nodes.find(n => n.id === tId),
      };
    };

    const linkPath = link.append('path')
      .attr('class', (d: MachineLink) => d.isPeSourceEdge ? 'link-path pe-source-edge' : 'link-path')
      .attr('fill', 'none')
      .attr('stroke', (d: MachineLink) => {
        if (d.isPeSourceEdge) return peSourceColor(d.peOrigin ?? 'sensor');
        if (d.isAcpEdge) return MIG_OPENCLAW_COLOR;
        const { s, t } = endpointNodes(d);
        if (s?.role === 'interconnect' || t?.role === 'interconnect') return MIG_BUS_COLOR;
        return (s?.isCurrent || t?.isCurrent) ? vizTheme.edge.active : vizTheme.edge.idle;
      })
      .attr('stroke-width', (d: MachineLink) => {
        if (d.isPeSourceEdge) return 1.6;
        if (d.isAcpEdge) return 1.8;
        const { s, t } = endpointNodes(d);
        if (s?.role === 'interconnect' || t?.role === 'interconnect') return 3;
        return (s?.isCurrent || t?.isCurrent) ? 3 : 2;
      })
      .attr('stroke-dasharray', (d: MachineLink) => d.isPeSourceEdge ? '2,3' : d.isAcpEdge ? '6,4' : null)
      .attr('opacity', 0.7)
      .attr('marker-end', (d: MachineLink) => {
        if (d.isPeSourceEdge) return 'url(#arrowhead-pe)';
        if (d.isAcpEdge) return 'url(#arrowhead-acp)';
        const { s, t } = endpointNodes(d);
        if (s?.role === 'interconnect' || t?.role === 'interconnect') return 'url(#arrowhead-bus)';
        return (s?.isCurrent || t?.isCurrent) ? 'url(#arrowhead-active)' : 'url(#arrowhead)';
      });

    svg.append('defs').selectAll('marker')
      .data(['arrowhead', 'arrowhead-active', 'arrowhead-acp', 'arrowhead-bus', 'arrowhead-pe'])
      .join('marker')
      .attr('id', markerType => markerType)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 25)
      .attr('refY', 0)
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', (markerType: string) =>
        markerType === 'arrowhead-active' ? vizTheme.edge.active
        : markerType === 'arrowhead-acp'  ? MIG_OPENCLAW_COLOR
        : markerType === 'arrowhead-bus'  ? MIG_BUS_COLOR
        : markerType === 'arrowhead-pe'   ? '#94a3b8'
        : vizTheme.edge.arrowhead);

    const linkLabel = link.append('text')
      .attr('class', 'link-label')
      .attr('font-size', '10px')
      .attr('fill', vizTheme.edge.label)
      .attr('text-anchor', 'middle')
      .text((d: MachineLink) => d.isPeSourceEdge
        ? ((d.peMachineCount ?? 1) > 1
            ? `${d.peSourceCount ?? 0} src ⇒ ${d.peMachineCount} machines`
            : `${d.peSourceCount ?? 0} src → [${d.targetRegion.offset}:${d.targetRegion.offset + d.targetRegion.length - 1}]`)
        : `[${d.sourceRegion.offset}:${d.sourceRegion.offset + d.sourceRegion.length - 1}] → [${d.targetRegion.offset}:${d.targetRegion.offset + d.targetRegion.length - 1}]`
      );

    // Nodes
    const node = g.append('g').attr('class', 'nodes').selectAll('g').data(nodes).join('g')
      .attr('class', (d: MachineNode) =>
        d.role === 'openclaw-portal' ? 'node openclaw-portal'
        : d.role === 'pe-source'     ? 'node pe-source'
        : 'node')
      .call(d3.drag<any, MachineNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any)
      .on('dblclick', (_event: any, d: MachineNode) => {
        if (d.role === 'openclaw-portal' || d.role === 'pe-source') return;
        loadMachineRef.current(d.id);
      });

    // OpenClaw portal nodes: domain-local hexagons with an ACP ring.
    const hexPts = (r: number) => Array.from({ length: 6 }, (_, i) => {
      const a = (i * 60 - 30) * Math.PI / 180;
      return `${r * Math.cos(a)},${r * Math.sin(a)}`;
    }).join(' ');

    node.filter((d: MachineNode) => d.role === 'openclaw-portal')
      .append('polygon')
      .attr('points', hexPts(62))
      .attr('fill', 'none')
      .attr('stroke', MIG_OPENCLAW_COLOR)
      .attr('stroke-width', 3)
      .attr('stroke-dasharray', '6,4');

    node.filter((d: MachineNode) => d.role === 'openclaw-portal')
      .append('polygon')
      .attr('points', hexPts(52))
      .attr('fill', (d: MachineNode) => DOMAINS[d.domain].fill)
      .attr('stroke', (d: MachineNode) => DOMAINS[d.domain].color)
      .attr('stroke-width', 2);

    node.filter((d: MachineNode) => d.role === 'openclaw-portal')
      .append('text')
      .attr('text-anchor', 'middle').attr('y', -8)
      .attr('font-size', '12px').attr('font-weight', 700)
      .attr('fill', MIG_OPENCLAW_COLOR)
      .text('OpenClaw Portal');

    node.filter((d: MachineNode) => d.role === 'openclaw-portal')
      .append('text')
      .attr('text-anchor', 'middle').attr('y', 10)
      .attr('font-size', '10px')
      .attr('fill', (d: MachineNode) => DOMAINS[d.domain].color)
      .text((d: MachineNode) => DOMAINS[d.domain].short.toUpperCase());

    node.filter((d: MachineNode) => d.role === 'openclaw-portal')
      .append('text')
      .attr('text-anchor', 'middle').attr('y', 28)
      .attr('font-size', '9px').attr('fill', vizTheme.text.secondary)
      .text(`PS[${OPENCLAW_PS_REGION.offset}:${OPENCLAW_PS_REGION.offset + OPENCLAW_PS_REGION.length - 1}]`);

    // PE-source provenance nodes: dashed pill tagged with origin + count.
    const peNode = node.filter((d: MachineNode) => d.role === 'pe-source');
    peNode.append('rect')
      .attr('width', 150).attr('height', 56)
      .attr('x', -75).attr('y', -28).attr('rx', 12)
      .attr('fill', (d: MachineNode) => `${peSourceColor(d.peOrigin ?? 'sensor')}1a`)
      .attr('stroke', (d: MachineNode) => peSourceColor(d.peOrigin ?? 'sensor'))
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4,3');
    peNode.append('text')
      .attr('text-anchor', 'middle').attr('y', -10)
      .attr('font-size', '9px').attr('font-weight', 700)
      .attr('fill', (d: MachineNode) => peSourceColor(d.peOrigin ?? 'sensor'))
      .text('⇥ PE SOURCES');
    peNode.append('text')
      .attr('text-anchor', 'middle').attr('y', 4)
      .attr('font-size', '12px').attr('font-weight', 700)
      .attr('fill', vizTheme.text.primary)
      .text((d: MachineNode) => (d.peOrigin ?? 'sensor').toUpperCase());
    peNode.append('text')
      .attr('text-anchor', 'middle').attr('y', 18)
      .attr('font-size', '9px')
      .attr('fill', vizTheme.text.secondary)
      .text((d: MachineNode) =>
        `${d.peSourceCount ?? 0} src · [${d.inputMapping.offset}:${d.inputMapping.offset + d.inputMapping.length - 1}]`);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('rect')
      .attr('data-field', 'status-rect')
      .attr('width', 200)
      .attr('height', 140)
      .attr('x', -100)
      .attr('y', -70)
      .attr('rx', 10)
      .attr('fill', (d: MachineNode) => d.isCurrent ? vizTheme.bg.cardActive : vizTheme.bg.cardConnected)
      .attr('stroke', (d: MachineNode) =>
        d.role === 'agent-dispatcher' ? MIG_OPENCLAW_COLOR
        : d.role === 'interconnect'   ? MIG_BUS_COLOR
        : DOMAINS[d.domain].color)
      .attr('stroke-width', (d: MachineNode) => d.isCurrent ? 4 : 2.5);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('rect')
      .attr('width', 200)
      .attr('height', 6)
      .attr('x', -100)
      .attr('y', -70)
      .attr('rx', 3)
      .attr('fill', (d: MachineNode) =>
        d.role === 'agent-dispatcher' ? MIG_OPENCLAW_COLOR
        : d.role === 'interconnect'   ? MIG_BUS_COLOR
        : DOMAINS[d.domain].color)
      .attr('opacity', 0.9);

    node.filter((d: MachineNode) => d.isExternal && isCardNode(d))
      .append('g')
      .attr('class', 'external-chip')
      .call(g => {
        g.append('rect')
          .attr('x', -96).attr('y', -64)
          .attr('width', 66).attr('height', 14)
          .attr('rx', 7)
          .attr('fill', vizTheme.accent.externalFill)
          .attr('opacity', 0.9);
        g.append('text')
          .attr('x', -63).attr('y', -54)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9px')
          .attr('font-weight', 700)
          .attr('fill', vizTheme.text.emphasis)
          .text('↯ EXTERNAL');
      });

    // Role chip: BUS or ACP badge on non-portal nodes
    node.filter((d: MachineNode) => d.role === 'interconnect')
      .append('g')
      .attr('class', 'role-chip')
      .call(g => {
        g.append('rect')
          .attr('x', -96).attr('y', d => (d as MachineNode).isExternal ? -46 : -64)
          .attr('width', 38).attr('height', 14)
          .attr('rx', 7)
          .attr('fill', MIG_BUS_COLOR)
          .attr('opacity', 0.85);
        g.append('text')
          .attr('x', -77).attr('y', d => (d as MachineNode).isExternal ? -36 : -54)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9px').attr('font-weight', 700)
          .attr('fill', '#0a1428')
          .text('⊞ BUS');
      });

    node.filter((d: MachineNode) => d.role === 'agent-dispatcher')
      .append('g')
      .attr('class', 'role-chip')
      .call(g => {
        g.append('rect')
          .attr('x', 24).attr('y', -64)
          .attr('width', 38).attr('height', 14)
          .attr('rx', 7)
          .attr('fill', MIG_OPENCLAW_COLOR)
          .attr('opacity', 0.85);
        g.append('text')
          .attr('x', 43).attr('y', -54)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9px').attr('font-weight', 700)
          .attr('fill', '#fff')
          .text('↯ ACP');
      });

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('x', 94).attr('y', -54)
      .attr('text-anchor', 'end')
      .attr('font-size', '9px')
      .attr('font-weight', 700)
      .attr('fill', (d: MachineNode) =>
        d.role === 'agent-dispatcher' ? MIG_OPENCLAW_COLOR
        : d.role === 'interconnect'   ? MIG_BUS_COLOR
        : DOMAINS[d.domain].color)
      .text((d: MachineNode) =>
        d.role === 'interconnect'     ? 'BUS'
        : d.role === 'agent-dispatcher' ? 'ACP'
        : DOMAINS[d.domain].short.toUpperCase());

    // Current machine focus ring
    node.filter((d: MachineNode) => d.isCurrent)
      .append('rect')
      .attr('width', 214)
      .attr('height', 154)
      .attr('x', -107)
      .attr('y', -77)
      .attr('rx', 13)
      .attr('fill', 'none')
      .attr('stroke', vizTheme.outline.focus)
      .attr('stroke-width', 2.5)
      .attr('stroke-dasharray', '6,5')
      .attr('opacity', 0.7);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('y', -40)
      .attr('font-size', '14px')
      .attr('font-weight', 'bold')
      .attr('fill', (d: MachineNode) => d.isCurrent ? vizTheme.accent.current : vizTheme.text.primary)
      .text((d: MachineNode) => {
        const maxLen = 20;
        return d.name.length > maxLen ? d.name.substring(0, maxLen) + '...' : d.name;
      });

    node.filter((d: MachineNode) => isCardNode(d))
      .append('circle')
      .attr('data-field', 'status-dot')
      .attr('cx', 85)
      .attr('cy', -60)
      .attr('r', 6)
      .attr('fill', vizTheme.status.dotIdle)
      .attr('opacity', 0.9);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('y', -18)
      .attr('font-size', '11px')
      .attr('fill', vizTheme.accent.input)
      .text((d: MachineNode) => `In: [${d.inputMapping.offset}:${d.inputMapping.offset + d.inputMapping.length - 1}]`);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('y', -3)
      .attr('font-size', '11px')
      .attr('fill', vizTheme.accent.outputBright)
      .text((d: MachineNode) => `Out: [${d.outputMapping.offset}:${d.outputMapping.offset + d.outputMapping.length - 1}]`);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('data-field', 'last-input')
      .attr('text-anchor', 'middle')
      .attr('y', 15)
      .attr('font-size', '9px')
      .attr('fill', vizTheme.text.secondary);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('data-field', 'last-output')
      .attr('text-anchor', 'middle')
      .attr('y', 30)
      .attr('font-size', '9px')
      .attr('fill', vizTheme.accent.output);

    node.filter((d: MachineNode) => isCardNode(d))
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('y', 50)
      .attr('font-size', '10px')
      .attr('fill', vizTheme.text.secondary)
      .text((d: MachineNode) => d.sequenceCount ? `${d.sequenceCount} sequences` : '');

    // Invisible hit-rect drives the embedded Sequences tooltip.
    // Portal nodes use a domain-level ACP tooltip instead.
    node.filter((d: MachineNode) => isCardNode(d))
      .append('rect')
      .attr('width', 200).attr('height', 140)
      .attr('x', -100).attr('y', -70)
      .attr('fill', 'transparent')
      .style('cursor', 'pointer')
      .on('mouseenter', (event: MouseEvent, d: MachineNode) => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        const rect = containerRef.current!.getBoundingClientRect();
        const x = event.clientX - rect.left + 14;
        const y = event.clientY - rect.top - 10;
        tooltipTimerRef.current = setTimeout(() => {
          showTooltipRef.current(d.id, d.name, x, y);
        }, 160);
      })
      .on('mouseleave', () => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = setTimeout(() => {
          setTooltip(prev => (prev?.pinned ? prev : null));
        }, 220);
      })
      .on('click', (_event: any, d: MachineNode) => {
        setTooltip(prev => {
          if (!prev || prev.machineId !== d.id) return prev;
          return prev.pinned ? null : { ...prev, pinned: true };
        });
      });

    node.filter((d: MachineNode) => d.role === 'openclaw-portal')
      .append('circle')
      .attr('r', 66)
      .attr('fill', 'transparent')
      .style('cursor', 'pointer')
      .on('mouseenter', (event: MouseEvent, d: MachineNode) => {
        const rect = containerRef.current!.getBoundingClientRect();
        setPortalTooltip({
          node: d,
          x: event.clientX - rect.left + 14,
          y: event.clientY - rect.top - 10,
        });
      })
      .on('mouseleave', () => setPortalTooltip(null));

    svg.on('click.tooltip', (event: any) => {
      if (!(event.target as Element).closest?.('g.node')) {
        setTooltip(prev => (prev?.pinned ? prev : null));
        setPortalTooltip(null);
      }
    });

    simulation.on('tick', () => {
      for (const n of nodes) {
        if (n.isCurrent) { n.x = cx; n.y = cy; n.fx = cx; n.fy = cy; }
        if (n.x != null && n.y != null) nodePositionsRef.current.set(n.id, { x: n.x, y: n.y });
      }

      linkPath.attr('d', (d: any) => {
        const dx = d.target.x - d.source.x;
        const dy = d.target.y - d.source.y;
        const dr = Math.sqrt(dx * dx + dy * dy);
        return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
      });

      linkLabel
        .attr('x', (d: any) => (d.source.x + d.target.x) / 2)
        .attr('y', (d: any) => (d.source.y + d.target.y) / 2);

      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event: any, d: MachineNode) {
      if (d.isCurrent) return;
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    function dragged(event: any, d: MachineNode) {
      if (d.isCurrent) return;
      d.fx = event.x;
      d.fy = event.y;
    }
    function dragended(event: any, d: MachineNode) {
      if (d.isCurrent) return;
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    return () => {
      simulation.stop();
    };
  // Per-step status updates are applied in-place by the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, currentMachineId, dimensions, classifications, enabledDomains, peSensorSources, showPeSources]);

  // ── Lightweight per-step recolor — never rebuilds the simulation ──────────
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll<SVGGElement, MachineNode>('g.node').each(function(d) {
      if (d.role === 'openclaw-portal' || d.role === 'pe-source' || isPortalNode(d.id)) return;

      const info = machineStatuses[d.id];
      const status = info?.status ?? 'idle';

      d3.select(this).select('rect[data-field="status-rect"]')
        .attr('fill', () => {
          if (status === 'active')     return vizTheme.status.activeFill;
          if (status === 'processing') return vizTheme.status.processingFill;
          if (d.isCurrent)             return vizTheme.bg.cardActive;
          return vizTheme.bg.cardConnected;
        })
        .attr('stroke', () => {
          if (status === 'active')     return vizTheme.status.activeStroke;
          if (status === 'processing') return vizTheme.status.processingStroke;
          return DOMAINS[d.domain].color;
        });

      d3.select(this).select('circle[data-field="status-dot"]')
        .attr('fill', () => {
          if (status === 'active')     return vizTheme.status.dotActive;
          if (status === 'processing') return vizTheme.status.dotProcessing;
          return vizTheme.status.dotIdle;
        });

      const iv = info?.lastInput;
      d3.select(this).select('text[data-field="last-input"]')
        .text(() => {
          if (iv && iv.length > 0) {
            const preview = iv.slice(0, 4).map((v: number) => v.toFixed(1)).join(',');
            return `In: [${preview}${iv.length > 4 ? '...' : ''}]`;
          }
          return '';
        });

      const ov = info?.lastOutput;
      d3.select(this).select('text[data-field="last-output"]')
        .text(() => {
          if (ov && ov.length > 0) {
            const preview = ov.slice(0, 4).map((v: number) => v.toFixed(1)).join(',');
            return `Out: [${preview}${ov.length > 4 ? '...' : ''}]`;
          }
          return '';
        });
    });
  }, [machineStatuses]);

  // ── PE-source arc pulse (Manager#27 Phase 3) ──────────────────────────────
  // Flare feed-forward arcs whose stimulated elements are non-zero in the
  // current step's perceptual space — the observable trace of a source
  // (MQTT message, ACP completion, provider push) actually writing.
  useEffect(() => {
    if (!svgRef.current || perceptualSpace.length === 0) return;
    const svg = d3.select(svgRef.current);
    const hotSources = new Set<string>();
    svg.selectAll<SVGPathElement, MachineLink>('path.link-path')
      .filter((d: MachineLink) => !!d?.isPeSourceEdge)
      .each(function (d: MachineLink) {
        const { offset, length } = d.targetRegion;
        let hot = false;
        const end = Math.min(offset + length, perceptualSpace.length);
        for (let i = offset; i < end; i++) {
          if (perceptualSpace[i] !== 0) { hot = true; break; }
        }
        if (!hot) return;
        hotSources.add(typeof d.source === 'string' ? d.source : d.source.id);
        d3.select(this)
          .interrupt('pe-pulse')
          .transition('pe-pulse').duration(120)
          .attr('stroke-width', 4.5)
          .attr('opacity', 1)
          .transition().duration(480)
          .attr('stroke-width', 1.6)
          .attr('opacity', 0.7);
      });
    if (hotSources.size > 0) {
      svg.selectAll<SVGGElement, MachineNode>('g.node')
        .filter((d: MachineNode) => d.role === 'pe-source' && hotSources.has(d.id))
        .select('rect')
        .interrupt('pe-pulse')
        .transition('pe-pulse').duration(120)
        .attr('stroke-width', 4)
        .transition().duration(480)
        .attr('stroke-width', 2);
    }
  }, [perceptualSpace]);

  const currentMachine = machines.find(m => m.id === currentMachineId);

  return (
    <div ref={containerRef} className="machine-interconnection-graph">
      <Graph3DToggle is3D={is3D} onToggle={() => setIs3D(v => !v)} />

      {/* Current machine input-vector summary — pinned to top of window */}
      <InputVectorSummary
        machine={currentMachine}
        perceptualSpace={perceptualSpace}
        step={currentStep?.stepNumber ?? 0}
      />

      {is3D && (
        <Graph3DView
          mode="machines"
          onMachineHover={(id, clientX, clientY) => {
            if (!id) {
              if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
              tooltipTimerRef.current = setTimeout(
                () => setTooltip(prev => (prev?.pinned ? prev : null)), 220);
              return;
            }
            const m = machines.find(mm => mm.id === id);
            if (!m) return;
            if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
            const rect = containerRef.current?.getBoundingClientRect();
            const x = rect && clientX !== undefined ? clientX - rect.left + 14 : 20;
            const y = rect && clientY !== undefined ? clientY - rect.top  - 10 : 70;
            tooltipTimerRef.current = setTimeout(() => {
              showTooltipRef.current(m.id, m.name, x, y);
            }, 160);
          }}
        />
      )}

      <svg ref={svgRef} className="graph-svg" style={{ display: is3D ? 'none' : undefined }}></svg>

      {/* Embedded interactive Sequences tooltip (shared with MachineGraphView) */}
      {tooltip && (
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

      {portalTooltip && (() => {
        const meta = portalTooltip.node.metadata as PortalNodeMetadata;
        return (
          <div
            className="portal-tooltip"
            style={{ left: portalTooltip.x, top: portalTooltip.y }}
            onMouseEnter={() => setPortalTooltip(portalTooltip)}
            onMouseLeave={() => setPortalTooltip(null)}
          >
            <div className="portal-tooltip-title">OpenClaw Portal</div>
            <div className="portal-tooltip-domain" style={{ color: meta.domainColor }}>
              {meta.domainLabel}
            </div>
            <div className="portal-tooltip-row">
              <span>ACP Completion</span>
              <strong>{meta.acpPsRegion}</strong>
            </div>
            <div className="portal-tooltip-section">
              <div className="portal-tooltip-section-title">ACP Dispatchers</div>
              <div className="portal-tooltip-list">
                {meta.dispatchers.slice(0, 6).map(dispatcher => (
                  <div key={dispatcher.id} className="portal-tooltip-item">{dispatcher.name}</div>
                ))}
                {meta.dispatchers.length > 6 && (
                  <div className="portal-tooltip-more">+{meta.dispatchers.length - 6} more</div>
                )}
              </div>
            </div>
            <div className="portal-tooltip-section">
              <div className="portal-tooltip-section-title">Mechanical Bus</div>
              {meta.buses.length > 0 ? (
                <div className="portal-tooltip-list">
                  {meta.buses.slice(0, 4).map(bus => (
                    <div key={bus.id} className="portal-tooltip-item">
                      {bus.name} <span>{bus.psIn} -&gt; {bus.psOut}</span>
                    </div>
                  ))}
                  {meta.buses.length > 4 && (
                    <div className="portal-tooltip-more">+{meta.buses.length - 4} more</div>
                  )}
                </div>
              ) : (
                <div className="portal-tooltip-empty">No bus node in current ego graph</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Domain legend — click to toggle a domain's nodes on/off */}
      <div className="graph-legend">
        <div className="legend-section-title">Domains of Effect</div>
        {DOMAIN_ORDER.map(domainId => {
          const def = DOMAINS[domainId];
          const enabled = enabledDomains[domainId];
          const count = domainCounts[domainId];
          return (
            <button
              key={domainId}
              className={`legend-item legend-toggle ${enabled ? 'enabled' : 'disabled'}`}
              onClick={() =>
                setEnabledDomains(prev => ({ ...prev, [domainId]: !prev[domainId] }))
              }
              title={def.description}
            >
              <div
                className="legend-box"
                style={{ backgroundColor: def.fill, borderColor: def.color, borderWidth: 2 }}
              />
              <span className="legend-label">{def.label}</span>
              <span className="legend-count">{count}</span>
            </button>
          );
        })}

        {externalCount > 0 && (
          <div className="legend-item" title="Machines registered by an external stack (e.g. localAIStack)">
            <div className="legend-box" style={{
              borderColor: vizTheme.accent.externalFill,
              backgroundColor: 'rgba(168, 85, 247, 0.28)',
              borderStyle: 'dashed',
              borderWidth: 2,
            }} />
            <span className="legend-label">External Bridge</span>
            <span className="legend-count">{externalCount}</span>
          </div>
        )}

        <div className="legend-divider" />
        <div className="legend-section-title">Node Roles</div>
        <div className="legend-item">
          <div className="legend-box" style={{
            backgroundColor: 'rgba(96,180,248,0.10)',
            borderColor: MIG_BUS_COLOR, borderWidth: 2,
            clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
          }} />
          <span style={{ color: MIG_BUS_COLOR }}>Interconnect (Mech. Bus)</span>
        </div>
        <div className="legend-item">
          <div className="legend-box" style={{
            backgroundColor: MIG_OPENCLAW_FILL,
            borderColor: MIG_OPENCLAW_COLOR, borderWidth: 2, borderStyle: 'dashed',
            borderRadius: '50%',
          }} />
          <span style={{ color: MIG_OPENCLAW_COLOR }}>Agent Dispatcher (ACP)</span>
        </div>
        <div className="legend-item">
          <div className="legend-box" style={{
            backgroundColor: MIG_OPENCLAW_FILL,
            borderColor: MIG_OPENCLAW_COLOR, borderWidth: 2, borderStyle: 'dashed',
            clipPath: 'polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)',
          }} />
          <span style={{ color: MIG_OPENCLAW_COLOR }}>OpenClaw xACP</span>
        </div>
        <div className="legend-divider" />
        <div className="legend-section-title">Runtime</div>
        <div className="legend-item">
          <div className="legend-box" style={{ backgroundColor: vizTheme.status.activeFill, borderColor: vizTheme.status.activeStroke }} />
          <span>Active (Output)</span>
        </div>
        <div className="legend-item">
          <div className="legend-box" style={{ backgroundColor: vizTheme.status.processingFill, borderColor: vizTheme.status.processingStroke }} />
          <span>Processing</span>
        </div>
        <div className="legend-item">
          <div className="legend-arrow" />
          <span>Data Flow</span>
        </div>
        <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 24, height: 2, borderTop: `2px dashed ${MIG_OPENCLAW_COLOR}`, opacity: 0.8 }} />
          <span style={{ color: MIG_OPENCLAW_COLOR }}>ACP Dispatch</span>
        </div>
        <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 24, height: 3, background: MIG_BUS_COLOR, opacity: 0.7 }} />
          <span style={{ color: MIG_BUS_COLOR }}>Mech. Bus Flow</span>
        </div>
        <div className="legend-divider" />
        <div className="legend-section-title">PE Sources</div>
        <button
          className={`legend-item legend-toggle ${showPeSources ? 'enabled' : 'disabled'}`}
          onClick={() => setShowPeSources(v => !v)}
          title="Feed-forward arcs from integration-fed PE sources (MQTT, OpenClaw, Ollama, ...) into machines whose input regions they cover"
        >
          <div className="legend-box" style={{
            borderColor: '#94a3b8', borderWidth: 2, borderStyle: 'dashed',
            borderRadius: 12, backgroundColor: 'rgba(148,163,184,0.12)',
          }} />
          <span className="legend-label">Source Feed-forward</span>
          <span className="legend-count">{peSensorSources.length}</span>
        </button>
        {showPeSources && peOriginsPresent.map(origin => (
          <div key={origin} className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 24, height: 2, borderTop: `2px dashed ${peSourceColor(origin)}`, opacity: 0.9 }} />
            <span style={{ color: peSourceColor(origin), fontSize: 11 }}>{origin}</span>
          </div>
        ))}
        <div className="legend-divider" />
        <div className="legend-item" style={{ color: '#64748b', fontSize: '10px' }}>
          Hover a machine for its sequences · click to pin
        </div>
        <div className="legend-item" style={{ color: '#64748b', fontSize: '10px' }}>
          Double-click a machine to open it
        </div>
        <div className="legend-item" style={{ color: '#64748b', fontSize: '10px' }}>
          Source arcs pulse when their elements are non-zero in the current step
        </div>
      </div>
    </div>
  );
};
