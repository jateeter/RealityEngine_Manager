/**
 * Graph3DView - 3D force-directed graph visualization using Three.js
 *
 * Renders machines as 3D spheres with domain hull/bubble meshes,
 * directed edges as arrows, and provides orbit controls for
 * pan/zoom/rotate interaction.
 *
 * Domain bubbles are convex hulls rendered as transparent meshes.
 * Non-intersecting layout is ensured by 3D domain anchoring.
 */

import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import ReactDOM from 'react-dom';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { useVisualizerStore } from '../store';
import {
  classifyMachine,
  DOMAINS,
  DOMAIN_ORDER,
  DomainId,
  getNodeRole,
  NodeRole,
  OPENCLAW_PS_REGION,
  portalNodeId,
  isPortalNode,
} from './machineDomains';
import { vizTheme } from '../styles/vizTheme';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MachineNode3D {
  id: string;
  name: string;
  description: string;
  inputMapping: { offset: number; length: number };
  outputMapping: { offset: number; length: number };
  metadata: Record<string, any>;
  domain: DomainId;
  isExternal: boolean;
  role?: NodeRole | 'openclaw-virtual';
  // 3d-force-graph managed
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  // Runtime
  colorState?: 'idle' | 'active' | 'fired';
}

interface MachineEdge3D {
  source: string;
  target: string;
  sourceRegion: { offset: number; length: number };
  targetRegion: { offset: number; length: number };
  overlap: boolean;
  isAcpEdge?: boolean;
}

const G3D_BUS_COLOR      = '#60b4f8';
const G3D_OPENCLAW_COLOR = '#ff6b35';

interface MachineGraphData {
  nodes: Array<{
    id: string;
    name: string;
    description: string;
    inputMapping: { offset: number; length: number };
    outputMapping: { offset: number; length: number };
    metadata: Record<string, any>;
  }>;
  edges: MachineEdge3D[];
  perceptualSpaceDimension: number;
}

interface SimulationStep {
  stepNumber: number;
  perceptualSpace: number[];
  machineResults: Record<string, {
    machineId: string;
    machineName: string;
    inputVector: number[];
    outputVector: number[] | null;
    transitionResult?: {
      sequenceResults?: Record<string, {
        activatedVectors?: string[];
        matchedVectors?: string[];
      }>;
    };
  }>;
}

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

// ── Domain tooltip ────────────────────────────────────────────────────────────

interface DomainActivity {
  machineId: string;
  machineName: string;
  status: 'fired' | 'active';
  seqNames: string[];
}

function getDomainActivity(
  domainId: DomainId,
  nodes: MachineNode3D[],
  step: SimulationStep | null,
): DomainActivity[] {
  if (!step) return [];
  const out: DomainActivity[] = [];
  for (const node of nodes) {
    if (node.domain !== domainId) continue;
    const mr = step.machineResults[node.id];
    if (!mr) continue;
    const fired = mr.outputVector !== null && mr.outputVector !== undefined;
    const seqResults = mr.transitionResult?.sequenceResults ?? {};
    const activeSeqs = Object.entries(seqResults)
      .filter(([, sr]) => (sr.activatedVectors?.length ?? 0) > 0)
      .map(([name]) => name);
    if (fired || activeSeqs.length > 0) {
      out.push({
        machineId: node.id,
        machineName: mr.machineName || node.name,
        status: fired ? 'fired' : 'active',
        seqNames: activeSeqs,
      });
    }
  }
  return out;
}

const DomainTooltip: React.FC<{
  domainId: DomainId;
  x: number;
  y: number;
  nodes: MachineNode3D[];
  step: SimulationStep | null;
}> = ({ domainId, x, y, nodes, step }) => {
  const domain = DOMAINS[domainId];
  const activity = getDomainActivity(domainId, nodes, step);
  const machineCount = nodes.filter(n => n.domain === domainId).length;
  const panelRef = useRef<HTMLDivElement>(null);

  // Clamp to viewport — runs after React commits style so getBoundingClientRect is accurate.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overR = rect.right  - (window.innerWidth  - 8);
    const overB = rect.bottom - (window.innerHeight - 8);
    if (overR > 0) el.style.left = `${Math.max(4, x - overR)}px`;
    if (overB > 0) el.style.top  = `${Math.max(4, y - overB)}px`;
  });

  const S = {
    panel: {
      position: 'fixed' as const, left: x, top: y,
      width: 284, zIndex: 9990,
      background: '#0b1220',
      border: `1px solid ${domain.color}55`,
      borderRadius: 8,
      boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
      fontFamily: 'ui-monospace, monospace',
      fontSize: 12, color: '#e2e8f0',
      pointerEvents: 'none' as const,
      overflow: 'hidden' as const,
    },
    header: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 14px',
      borderBottom: '1px solid #1e293b',
      background: '#0f172a',
    },
    dot: {
      width: 10, height: 10, borderRadius: '50%',
      background: domain.color, flexShrink: 0,
    } as React.CSSProperties,
    title: { fontWeight: 700, fontSize: 13, color: '#f1f5f9', letterSpacing: 0.3 },
    count: { marginLeft: 'auto', fontSize: 10, color: '#475569' },
    desc: {
      padding: '8px 14px 10px',
      color: '#94a3b8', lineHeight: 1.55, fontSize: 11,
      borderBottom: '1px solid #1e293b',
    },
    cesSection: { padding: '8px 14px 12px' },
    cesHeader: {
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
      letterSpacing: 0.8, color: '#475569', marginBottom: 7,
    },
    empty: { color: '#475569', fontSize: 11 },
    row: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 },
    rowDot: (fired: boolean) => ({
      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
      background: fired ? '#ef4444' : '#38bdf8',
    } as React.CSSProperties),
    machineName: { color: '#cbd5e1', fontSize: 11, flex: 1, minWidth: 0,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
    badge: (fired: boolean) => ({
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
      letterSpacing: 0.4, color: fired ? '#ef4444' : '#38bdf8',
      flexShrink: 0,
    } as React.CSSProperties),
    seqChips: { paddingLeft: 12, display: 'flex', flexWrap: 'wrap' as const, gap: 3, marginBottom: 2 },
    chip: {
      fontSize: 9, color: '#64748b',
      background: '#080d18', border: '1px solid #1e293b',
      borderRadius: 3, padding: '1px 5px',
    },
  };

  return (
    <div ref={panelRef} style={S.panel}>
      <div style={S.header}>
        <div style={S.dot} />
        <span style={S.title}>{domain.label}</span>
        <span style={S.count}>{machineCount} machine{machineCount !== 1 ? 's' : ''}</span>
      </div>
      <div style={S.desc}>{domain.description}</div>
      <div style={S.cesSection}>
        <div style={S.cesHeader}>Active CES</div>
        {!step ? (
          <div style={S.empty}>No simulation running</div>
        ) : activity.length === 0 ? (
          <div style={S.empty}>No active sequences</div>
        ) : (
          activity.map(a => (
            <div key={a.machineId}>
              <div style={S.row}>
                <div style={S.rowDot(a.status === 'fired')} />
                <span style={S.machineName}>{a.machineName}</span>
                <span style={S.badge(a.status === 'fired')}>{a.status}</span>
              </div>
              {a.seqNames.length > 0 && (
                <div style={S.seqChips}>
                  {a.seqNames.map(s => <span key={s} style={S.chip}>{s}</span>)}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ── 3D domain anchors ─────────────────────────────────────────────────────────
// Extend the 2D 4x3 grid into 3D space. Z is spread across rows to add depth.
const SPREAD = 600;
const Z_SPREAD = 300;

function domainAnchor3D(domain: DomainId): { x: number; y: number; z: number } {
  const a = DOMAINS[domain].anchor;
  // Map 2D grid (0..1 x 0..1) to 3D centered coordinates
  const col = Math.round((a.x - 0.125) / 0.25); // 0..3
  const row = Math.round((a.y - 0.20) / 0.30);   // 0..2
  return {
    x: (col - 1.5) * SPREAD,
    y: -(row - 1) * SPREAD,
    z: (col % 2 === 0 ? -1 : 1) * Z_SPREAD * (row - 1) * 0.5,
  };
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function domainColorHex(domain: DomainId): string {
  return DOMAINS[domain].color;
}

// Parse rgba fill string to hex + alpha
function parseDomainFill(domain: DomainId): { color: string; alpha: number } {
  const fill = DOMAINS[domain].fill;
  const m = fill.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) {
    const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
    const a = m[4] ? parseFloat(m[4]) : 1;
    const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
    return { color: hex, alpha: a };
  }
  return { color: DOMAINS[domain].color, alpha: 0.18 };
}

// ── Domain membrane builder ────────────────────────────────────────────────────
// Uses ConvexGeometry to wrap the actual node cluster shape rather than a sphere.
// Each node position is expanded MEMBRANE_PAD units outward from the cluster
// centroid before the hull is computed, so the membrane surface sits a consistent
// gap outside every node regardless of cluster shape.

// Gap between node center and membrane surface (scene units).
// Max node visual radius ≈ 11 (nodeRelSize 4 × ∛20); +19 gives clear breathing room.
const MEMBRANE_PAD = 30;

function deduplicatePoints(pts: THREE.Vector3[], tol = 1.0): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const tol2 = tol * tol;
  for (const p of pts) {
    if (!out.some(q => q.distanceToSquared(p) < tol2)) out.push(p);
  }
  return out;
}

function buildDomainMembrane(
  points: THREE.Vector3[],
  color: string,
  alpha: number,
): THREE.Mesh | null {
  if (points.length === 0) return null;

  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: alpha,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const centroid = new THREE.Vector3();
  points.forEach(p => centroid.add(p));
  centroid.divideScalar(points.length);

  // Expand each point outward from centroid so the hull surface clears the nodes.
  const expanded = points.map(p => {
    const offset = new THREE.Vector3().subVectors(p, centroid);
    const len = offset.length();
    if (len < 1e-6) return p.clone().addScalar(MEMBRANE_PAD); // node at centroid
    return p.clone().addScaledVector(offset.normalize(), MEMBRANE_PAD);
  });

  // ConvexGeometry needs ≥ 4 non-coplanar points.
  const unique = deduplicatePoints(expanded);
  if (unique.length >= 4) {
    try {
      const geo = new ConvexGeometry(unique);
      geo.computeVertexNormals(); // smooth shading across facets
      return new THREE.Mesh(geo, mat);
    } catch {
      // fall through to sphere fallback
    }
  }

  // Sphere fallback: 1–3 nodes or coplanar set.
  let maxDist = 0;
  expanded.forEach(p => { maxDist = Math.max(maxDist, centroid.distanceTo(p)); });
  const geo = new THREE.SphereGeometry(Math.max(maxDist, 75), 32, 24);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(centroid);
  return mesh;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Graph3DViewProps {
  /** Source of graph data: 'machines' for the interconnection graph, 'events' for per-machine CES */
  mode?: 'machines' | 'events';
  /** For 'events' mode: nodes and edges from the parent CriticalEventGraphView */
  eventNodes?: Array<{
    id: string;
    label: string;
    isInitial: boolean;
    isActive: boolean;
    hasOutput: boolean;
    wasJustMatched?: boolean;
    cluster?: string;
  }>;
  eventEdges?: Array<{ source: string; target: string }>;
  /** For 'machines' mode: fired when the cursor hovers a machine sphere (or
   *  leaves it — null). clientX/Y are viewport coordinates of the mouse at
   *  hover time, forwarded so the parent can position its tooltip overlay. */
  onMachineHover?: (machineId: string | null, clientX?: number, clientY?: number) => void;
}

export const Graph3DView: React.FC<Graph3DViewProps> = ({
  mode = 'machines',
  eventNodes,
  eventEdges,
  onMachineHover,
}) => {
  const onMachineHoverRef = useRef(onMachineHover);
  useEffect(() => { onMachineHoverRef.current = onMachineHover; }, [onMachineHover]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const hullMeshesRef = useRef<THREE.Mesh[]>([]);
  const [graphData, setGraphData] = useState<MachineGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentStepRef = useRef<SimulationStep | null>(null);

  // Domain hover tooltip — position + which domain is hovered.
  // A ref mirrors the state so pointer-event closures and the WS handler
  // can read/write it without stale capture.
  const [domainTooltip, setDomainTooltip] = useState<{
    domainId: DomainId; x: number; y: number;
  } | null>(null);
  const domainTooltipRef = useRef(domainTooltip);
  const setDomainTooltipRef = useRef(setDomainTooltip);
  useEffect(() => {
    domainTooltipRef.current = domainTooltip;
  }, [domainTooltip]);

  const ws = useVisualizerStore(state => state.ws);
  const loadMachine = useVisualizerStore(state => state.loadMachine);
  const selectedDomains = useVisualizerStore(state => state.selectedDomains);
  const selectedDomainsRef = useRef(selectedDomains);
  useEffect(() => { selectedDomainsRef.current = selectedDomains; }, [selectedDomains]);
  // Keep a reference to all nodes so domain filter can rebuild graphData
  const allNodesRef = useRef<MachineNode3D[]>([]);
  const allLinksRef = useRef<MachineEdge3D[]>([]);

  // ── Fetch machine graph data ──────────────────────────────────────────────
  const fetchGraphData = useCallback(async () => {
    if (mode !== 'machines') return;
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
      setError(`Error: ${err.message}`);
    }
  }, [mode]);

  useEffect(() => { fetchGraphData(); }, [fetchGraphData]);

  useEffect(() => {
    const handler = () => { fetchGraphData(); };
    window.addEventListener('re:engine-switched', handler);
    return () => window.removeEventListener('re:engine-switched', handler);
  }, [fetchGraphData]);

  // Track mouse viewport position so onNodeHover can forward it to the parent.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => { mousePosRef.current = { x: e.clientX, y: e.clientY }; };
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, []);

  // ── WebSocket step updates ──────────────────────────────────────────────────
  useEffect(() => {
    if (!ws || mode !== 'machines') return;
    const handleMessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'perceptual-simulation-stepped') {
        currentStepRef.current = data.step;
        updateNodeColors();
        // Spread-create new object so React re-renders the tooltip and picks up
        // the latest step from currentStepRef — only pays a re-render if open.
        if (domainTooltipRef.current) {
          setDomainTooltipRef.current({ ...domainTooltipRef.current });
        }
      } else if (data.type === 'perceptual-simulation-reset') {
        currentStepRef.current = null;
        updateNodeColors();
        if (domainTooltipRef.current) {
          setDomainTooltipRef.current({ ...domainTooltipRef.current });
        }
      }
    };
    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, mode]);

  // ── Update node colors based on simulation step ─────────────────────────────
  const updateNodeColors = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    // Force a visual refresh - 3d-force-graph will re-call nodeColor
    graph.nodeColor(graph.nodeColor());
  }, []);

  // ── Build and mount the 3D graph ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    // Events mode
    if (mode === 'events') {
      if (!eventNodes?.length) return;
      return mountEventsGraph();
    }

    // Machines mode
    if (!graphData || graphData.nodes.length === 0) return;
    return mountMachinesGraph();
  }, [graphData, mode, eventNodes, eventEdges]);

  // ── Update nodes, links, and bubbles when domain filter changes ──────────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || mode !== 'machines') return;

    const selected = new Set(selectedDomains);

    const visibleNodes = allNodesRef.current.filter(n => selected.has(n.domain));
    const visibleIds = new Set(visibleNodes.map(n => n.id));
    const visibleLinks = allLinksRef.current.filter(e => {
      const srcId = typeof e.source === 'object' ? (e.source as any).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as any).id : e.target;
      return visibleIds.has(srcId) && visibleIds.has(tgtId);
    });

    graph.graphData({ nodes: visibleNodes, links: visibleLinks });

    // Rebuild bubbles for the new selection — simpler than toggling visibility
    // since buildDomainHulls now skips non-selected domains entirely.
    buildDomainHulls(graph, allNodesRef.current);
  }, [selectedDomains, mode]);

  // ── Mount machines graph ────────────────────────────────────────────────────
  function mountMachinesGraph() {
    const container = containerRef.current!;
    const data = graphData!;

    // Classify and build nodes
    const nodes: MachineNode3D[] = data.nodes.map(n => {
      const cls = classifyMachine(n);
      const role = getNodeRole(n);
      const anchor = domainAnchor3D(cls.domain);
      return {
        ...n,
        domain: cls.domain,
        isExternal: cls.isExternal,
        role,
        colorState: 'idle' as const,
        x: anchor.x + (Math.random() - 0.5) * 80,
        y: anchor.y + (Math.random() - 0.5) * 80,
        z: anchor.z + (Math.random() - 0.5) * 60,
      };
    });

    const links: MachineEdge3D[] = data.edges.map(e => ({ ...e }));

    // ── Per-domain OpenClaw portal nodes (3D) ──────────────────────────────────
    const dispatchersByDomain = new Map<DomainId, MachineNode3D[]>();
    for (const n of nodes) {
      if (n.role !== 'agent-dispatcher') continue;
      const dom = n.domain;
      if (!dispatchersByDomain.has(dom)) dispatchersByDomain.set(dom, []);
      dispatchersByDomain.get(dom)!.push(n);
    }

    for (const [domain, domainDispatchers] of dispatchersByDomain) {
      const pid    = portalNodeId(domain);
      const anchor = domainAnchor3D(domain);
      const portalNode: MachineNode3D = {
        id:            pid,
        name:          `OpenClaw Portal · ${DOMAINS[domain].label}`,
        description:   `Domain ACP portal — ${domainDispatchers.length} dispatcher(s)`,
        inputMapping:  OPENCLAW_PS_REGION,
        outputMapping: OPENCLAW_PS_REGION,
        metadata:      {
          virtual: true, isPortal: true, domainId: domain,
          domainColor: DOMAINS[domain].color, dispatcherCount: domainDispatchers.length,
        },
        domain,
        isExternal: false,
        role:          'openclaw-virtual',
        colorState:    'idle',
        // Elevated above domain plane
        x: anchor.x, y: anchor.y + SPREAD * 0.8, z: anchor.z,
        fx: anchor.x, fy: anchor.y + SPREAD * 0.8, fz: anchor.z,
      };
      nodes.push(portalNode);

      for (const d of domainDispatchers) {
        links.push({
          source:        d.id,
          target:        pid,
          sourceRegion:  d.outputMapping,
          targetRegion:  OPENCLAW_PS_REGION,
          overlap:       false,
          isAcpEdge:     true,
        });
      }
    }

    // Store all nodes/links for domain filtering
    allNodesRef.current = nodes;
    allLinksRef.current = links;

    // Apply initial domain filter
    const selected = new Set(selectedDomainsRef.current);
    const visibleNodes = nodes.filter(n => selected.has(n.domain));
    const visibleIds = new Set(visibleNodes.map(n => n.id));
    const visibleLinks = links.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

    // 2D edge style constants (match MachineGraphView)
    const EDGE_COLOR = '#8ab4cc';       // EDGE_IDLE_COLOR from 2D view
    const ARROW_COLOR = '#8ab4cc';      // same bright blue-grey for arrowheads

    // Create the 3D force graph
    const graph = new ForceGraph3D(container)
      .backgroundColor(vizTheme.bg.page)
      .graphData({ nodes: visibleNodes, links: visibleLinks })
      .nodeId('id')
      // The built-in mouse-pinned label is suppressed — the parent renders a
      // shared in-view tooltip overlay driven by onNodeHover below, matching
      // the 2D MachineInterconnectionGraph behaviour.
      .nodeLabel(() => '')
      // Node hover is driven by our capture-phase onPointerMove handler,
      // which raycasts __threeObj meshes and calls onMachineHoverRef directly.
      // onNodeHover is left empty to avoid double-calling the parent callback.
      .onNodeHover(() => {})
      .nodeColor((node: any) => {
        const n = node as MachineNode3D;
        if (isPortalNode(n.id)) return G3D_OPENCLAW_COLOR;
        const step = currentStepRef.current;
        const state = getMachineColorState(step?.machineResults[n.id]);
        if (state === 'fired') return '#ef4444';
        if (state === 'active') return vizTheme.accent.input;
        if (n.role === 'agent-dispatcher') return G3D_OPENCLAW_COLOR;
        if (n.role === 'interconnect')     return G3D_BUS_COLOR;
        return domainColorHex(n.domain);
      })
      .nodeOpacity(0.92)
      .nodeResolution(16)
      .nodeVal((node: any) => {
        const n = node as MachineNode3D;
        if (isPortalNode(n.id)) return 20;
        if (n.role === 'interconnect') return Math.max(8, Math.min(28, (n.metadata?.sequenceCount ?? 4) * 3));
        return Math.max(4, Math.min(20, (n.metadata?.sequenceCount ?? 3) * 2));
      })
      .linkSource('source')
      .linkTarget('target')
      .linkColor((link: any) => link.isAcpEdge ? G3D_OPENCLAW_COLOR : EDGE_COLOR)
      .linkOpacity(0.8)
      .linkWidth((link: any) => link.isAcpEdge ? 1.5 : 2.5)
      .linkDirectionalArrowLength(8)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor((link: any) => link.isAcpEdge ? G3D_OPENCLAW_COLOR : ARROW_COLOR)
      .linkDirectionalParticles(0)
      .onNodeClick((node: any) => {
        const n = node as MachineNode3D;
        loadMachine(n.id);
      })
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3);

    // Weaker charge so domain attraction can win against inter-node repulsion
    const sim = graph.d3Force('charge');
    if (sim) {
      (sim as any).strength(-60);
    }

    // Strong domain attraction forces — must outcompete cross-domain link forces
    graph
      .d3Force('domainX', forceX3D(nodes, 'x'))
      .d3Force('domainY', forceX3D(nodes, 'y'))
      .d3Force('domainZ', forceX3D(nodes, 'z'));

    graphRef.current = graph;

    // Build hulls immediately (nodes start tight to their anchors)
    buildDomainHulls(graph, nodes);

    // Rebuild when the simulation converges — most accurate result
    graph.onEngineStop(() => buildDomainHulls(graph, nodes));

    // Also refresh during simulation so membranes track the settling layout
    const hullInterval = setInterval(() => buildDomainHulls(graph, nodes), 1000);
    const stopHullUpdate = setTimeout(() => clearInterval(hullInterval), 12000);

    // ── Domain membrane drag ──────────────────────────────────────────────────
    // Pointer events on the renderer canvas are intercepted in capture phase
    // so our handler fires before 3d-force-graph's OrbitControls see them.
    // While dragging a membrane, OrbitControls are disabled and pointer is
    // captured so the drag continues even if the cursor leaves the canvas.

    const canvas = graph.renderer().domElement;
    const raycaster = new THREE.Raycaster();

    // Mutable hover/drag state (not React state — we don't need a re-render)
    let dragDomainId: DomainId | null = null;
    let dragNdcZ = 0;
    const dragPrevWorld = new THREE.Vector3();
    // Last node id reported as hovered — tracked so we emit null exactly once on leave.
    let hoveredNodeId: string | null = null;

    // Find the node whose __threeObj is `obj` or an ancestor of `obj`.
    const findHitNode = (obj: THREE.Object3D): MachineNode3D | null => {
      for (const n of nodes) {
        const root = (n as any).__threeObj as THREE.Object3D | undefined;
        if (!root) continue;
        let o: THREE.Object3D | null = obj;
        while (o) { if (o === root) return n; o = o.parent; }
      }
      return null;
    };

    const ndcFromEvent = (e: PointerEvent): THREE.Vector2 => {
      const rect = canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const camera = graph.camera() as THREE.PerspectiveCamera;
      raycaster.setFromCamera(ndcFromEvent(e), camera);
      // Node click takes priority — if the cursor is on a node, let
      // 3d-force-graph handle the event (don't start domain drag).
      const nodeObjs = nodes
        .map(n => (n as any).__threeObj as THREE.Object3D)
        .filter(Boolean);
      if (raycaster.intersectObjects(nodeObjs, true).length > 0) return;
      const hits = raycaster.intersectObjects(hullMeshesRef.current);
      if (hits.length === 0) return;

      e.stopPropagation();
      canvas.setPointerCapture(e.pointerId);

      // Hide node and domain tooltips for the duration of the drag
      if (hoveredNodeId !== null) { hoveredNodeId = null; onMachineHoverRef.current?.(null); }
      domainTooltipRef.current = null;
      setDomainTooltipRef.current(null);

      dragDomainId = (hits[0].object.userData as any).domain as DomainId;
      // Record NDC z of the hit point so every pointermove unprojects at the
      // same camera-space depth, giving a correct camera-plane translation.
      const ndcHit = hits[0].point.clone().project(camera);
      dragNdcZ = ndcHit.z;
      const ndc = ndcFromEvent(e);
      dragPrevWorld.set(ndc.x, ndc.y, dragNdcZ).unproject(camera);

      (graph.controls() as any).enabled = false;
      canvas.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      const ndc = ndcFromEvent(e);

      if (!dragDomainId) {
        const camera = graph.camera() as THREE.PerspectiveCamera;
        raycaster.setFromCamera(ndc, camera);

        // ── Node hover (highest priority) ──────────────────────────────────
        // Drive tooltip directly from our capture handler so the bubble-phase
        // onNodeHover callback isn't needed for correctness.
        const nodeObjs = nodes
          .map(n => (n as any).__threeObj as THREE.Object3D)
          .filter(Boolean);
        const nodeHits = raycaster.intersectObjects(nodeObjs, true);
        if (nodeHits.length > 0) {
          const hitNode = findHitNode(nodeHits[0].object);
          const newId = hitNode?.id ?? null;
          if (newId !== hoveredNodeId) {
            hoveredNodeId = newId;
            if (newId) onMachineHoverRef.current?.(newId, e.clientX, e.clientY);
          }
          // Suppress domain tooltip while over a node
          if (domainTooltipRef.current !== null) {
            domainTooltipRef.current = null;
            setDomainTooltipRef.current(null);
          }
          return;
        }

        // Cursor left a node
        if (hoveredNodeId !== null) {
          hoveredNodeId = null;
          onMachineHoverRef.current?.(null);
        }

        // ── Domain membrane hover ───────────────────────────────────────────
        const hits = raycaster.intersectObjects(hullMeshesRef.current);
        if (hits.length > 0) {
          canvas.style.cursor = 'grab';
          const hoveredDomain = (hits[0].object.userData as any).domain as DomainId;
          // Only update state when the hovered domain changes — avoids a React
          // re-render on every pointermove while over the same membrane.
          if (domainTooltipRef.current?.domainId !== hoveredDomain) {
            const tip = { domainId: hoveredDomain, x: e.clientX + 16, y: e.clientY - 10 };
            domainTooltipRef.current = tip;
            setDomainTooltipRef.current(tip);
          }
        } else {
          canvas.style.cursor = '';
          if (domainTooltipRef.current !== null) {
            domainTooltipRef.current = null;
            setDomainTooltipRef.current(null);
          }
        }
        return;
      }

      e.stopPropagation();

      const camera = graph.camera() as THREE.PerspectiveCamera;
      const curWorld = new THREE.Vector3(ndc.x, ndc.y, dragNdcZ).unproject(camera);
      const dx = curWorld.x - dragPrevWorld.x;
      const dy = curWorld.y - dragPrevWorld.y;
      const dz = curWorld.z - dragPrevWorld.z;
      dragPrevWorld.copy(curWorld);

      // Move every node in the domain (all nodes, not just visible ones, so
      // filtered-out nodes stay coherent with the cluster if re-enabled later).
      for (const node of nodes) {
        if (node.domain !== dragDomainId) continue;
        node.fx = (node.x ?? 0) + dx;
        node.fy = (node.y ?? 0) + dy;
        node.fz = (node.z ?? 0) + dz;
        // Update x/y/z directly so this frame's hull rebuild sees the new positions
        // before the d3 simulation propagates fx/fy/fz on its next tick.
        node.x = node.fx;
        node.y = node.fy;
        node.z = node.fz;
      }

      buildDomainHulls(graph, nodes);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragDomainId) return;
      e.stopPropagation();
      dragDomainId = null;
      (graph.controls() as any).enabled = true;
      canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = '';
    };

    canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
    canvas.addEventListener('pointermove', onPointerMove, { capture: true });
    canvas.addEventListener('pointerup',   onPointerUp,   { capture: true });
    canvas.addEventListener('pointercancel', onPointerUp, { capture: true });

    return () => {
      clearInterval(hullInterval);
      clearTimeout(stopHullUpdate);
      canvas.removeEventListener('pointerdown',   onPointerDown, { capture: true });
      canvas.removeEventListener('pointermove',   onPointerMove, { capture: true });
      canvas.removeEventListener('pointerup',     onPointerUp,   { capture: true });
      canvas.removeEventListener('pointercancel', onPointerUp,   { capture: true });
      // Clear any stale hover state so the shared tooltip overlay closes
      // when the user toggles back to 2D.
      onMachineHoverRef.current?.(null);
      // Remove membrane meshes
      hullMeshesRef.current.forEach(mesh => {
        graph.scene().remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
      hullMeshesRef.current = [];
      graph._destructor();
      graphRef.current = null;
    };
  }

  // ── Mount events graph (CriticalEventGraphView data) ────────────────────────
  function mountEventsGraph() {
    const container = containerRef.current!;

    const nodes = eventNodes!.map(n => ({
      ...n,
      x: (Math.random() - 0.5) * 300,
      y: (Math.random() - 0.5) * 300,
      z: (Math.random() - 0.5) * 200,
    }));

    const links = (eventEdges ?? []).map(e => ({ ...e }));

    const C_INITIAL = '#3b82f6';
    const C_ACTIVE = '#06b6d4';
    const C_FIRED = '#f59e0b';
    const C_TERMINAL = '#111827';
    const C_DEFAULT = '#64748b';

    const graph = new ForceGraph3D(container)
      .backgroundColor(vizTheme.bg.page)
      .graphData({ nodes, links })
      .nodeId('id')
      .nodeLabel((node: any) => {
        const n = node as typeof nodes[0];
        return `<div style="background:${vizTheme.bg.panel};color:${vizTheme.text.primary};padding:6px 10px;border-radius:4px;font-size:11px">
          ${n.label}
        </div>`;
      })
      .nodeColor((node: any) => {
        const n = node as typeof nodes[0];
        if (n.wasJustMatched) return C_FIRED;
        if (n.isActive) return C_ACTIVE;
        if (n.isInitial) return C_INITIAL;
        if (n.hasOutput) return C_TERMINAL;
        return C_DEFAULT;
      })
      .nodeOpacity(0.9)
      .nodeResolution(12)
      .nodeVal(4)
      .linkColor(() => '#e2e8f0')
      .linkOpacity(0.8)
      .linkWidth(2)
      .linkDirectionalArrowLength(6)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor(() => '#e2e8f0')
      .d3AlphaDecay(0.025)
      .d3VelocityDecay(0.3);

    graphRef.current = graph;

    return () => {
      graph._destructor();
      graphRef.current = null;
    };
  }

  // ── Build domain membrane meshes ─────────────────────────────────────────
  function buildDomainHulls(graph: ForceGraph3DInstance, nodes: MachineNode3D[]) {
    const scene = graph.scene();

    hullMeshesRef.current.forEach(mesh => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    hullMeshesRef.current = [];

    // Use ref so callbacks scheduled via setTimeout/setInterval/onEngineStop
    // always see the current domain filter selection rather than the stale
    // closure value from when mountMachinesGraph ran.
    const selected = new Set(selectedDomainsRef.current);

    const byDomain = new Map<DomainId, MachineNode3D[]>();
    for (const d of DOMAIN_ORDER) byDomain.set(d, []);
    for (const n of nodes) {
      if (isPortalNode(n.id)) continue; // portal nodes sit inside their domain hull, not above it
      if (selected.has(n.domain)) byDomain.get(n.domain)!.push(n);
    }

    for (const [domainId, domainNodes] of byDomain.entries()) {
      if (domainNodes.length === 0) continue;

      const points = domainNodes.map(n =>
        new THREE.Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0)
      );

      const { color, alpha } = parseDomainFill(domainId);
      const mesh = buildDomainMembrane(points, color, alpha);
      if (mesh) {
        mesh.userData = { domain: domainId };
        mesh.renderOrder = -1;
        scene.add(mesh);
        hullMeshesRef.current.push(mesh);
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: vizTheme.text.secondary, fontSize: 14,
        background: vizTheme.bg.page,
      }}>
        {error}
      </div>
    );
  }

  if (mode === 'machines' && !graphData) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: vizTheme.text.secondary, fontSize: 14,
        background: vizTheme.bg.page,
      }}>
        Loading 3D graph...
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
          background: vizTheme.bg.page,
        }}
      />
      {domainTooltip && ReactDOM.createPortal(
        <DomainTooltip
          domainId={domainTooltip.domainId}
          x={domainTooltip.x}
          y={domainTooltip.y}
          nodes={allNodesRef.current}
          step={currentStepRef.current}
        />,
        document.body,
      )}
    </>
  );
};

// ── Custom d3 force for 3D domain anchoring ──────────────────────────────────
// Pulls nodes toward their domain's 3D anchor position on a given axis.

function forceX3D(
  nodes: MachineNode3D[],
  axis: 'x' | 'y' | 'z',
) {
  // 0.40 is strong enough to outcompete cross-domain link forces while still
  // allowing nodes to spread naturally within their cluster.
  const strength = 0.40;

  function force(alpha: number) {
    for (const node of nodes) {
      const anchor = domainAnchor3D(node.domain);
      const target = anchor[axis];
      const current = (node as any)[axis] ?? 0;
      const delta = (target - current) * strength * alpha;
      (node as any)[`v${axis}`] = ((node as any)[`v${axis}`] ?? 0) + delta;
    }
  }

  // d3-force interface
  (force as any).initialize = () => {};

  return force as any;
}

export default Graph3DView;
