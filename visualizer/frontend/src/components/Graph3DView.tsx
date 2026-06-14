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

import React, { useEffect, useRef, useCallback, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import { useVisualizerStore } from '../store';
import {
  classifyMachine,
  DOMAINS,
  DOMAIN_ORDER,
  DomainId,
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
}

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
  return { color: DOMAINS[domain].color, alpha: 0.15 };
}

// ── ConvexHull geometry builder ────────────────────────────────────────────────

function buildConvexHullMesh(
  points: THREE.Vector3[],
  color: string,
  alpha: number,
): THREE.Mesh | null {
  if (points.length < 4) {
    // For fewer than 4 points, create a sphere enclosing them
    if (points.length === 0) return null;
    const center = new THREE.Vector3();
    points.forEach(p => center.add(p));
    center.divideScalar(points.length);
    let maxR = 0;
    points.forEach(p => { maxR = Math.max(maxR, center.distanceTo(p)); });
    const radius = Math.max(maxR + 40, 60);
    const geo = new THREE.SphereGeometry(radius, 24, 16);
    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: alpha * 1.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(center);
    return mesh;
  }

  // Compute centroid
  const centroid = new THREE.Vector3();
  points.forEach(p => centroid.add(p));
  centroid.divideScalar(points.length);

  // Scale points outward slightly for padding
  const padded = points.map(p => {
    const dir = new THREE.Vector3().subVectors(p, centroid).normalize();
    return p.clone().add(dir.multiplyScalar(35));
  });

  // Create an ellipsoid that fits the point cloud
  const bbox = new THREE.Box3();
  padded.forEach(p => bbox.expandByPoint(p));
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const bboxCenter = new THREE.Vector3();
  bbox.getCenter(bboxCenter);

  // Use icosphere and warp to approximate hull shape
  const icoGeo = new THREE.IcosahedronGeometry(1, 2);
  const posAttr = icoGeo.attributes.position;
  const halfSize = size.clone().multiplyScalar(0.55).addScalar(30);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i) * halfSize.x + bboxCenter.x;
    const y = posAttr.getY(i) * halfSize.y + bboxCenter.y;
    const z = posAttr.getZ(i) * halfSize.z + bboxCenter.z;
    posAttr.setXYZ(i, x, y, z);
  }
  icoGeo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: alpha * 1.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  return new THREE.Mesh(icoGeo, mat);
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
      } else if (data.type === 'perceptual-simulation-reset') {
        currentStepRef.current = null;
        updateNodeColors();
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

  // ── Update hull + node + link visibility when domain filter changes ──────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || mode !== 'machines') return;

    const selected = new Set(selectedDomains);

    // Hide/show hull meshes
    hullMeshesRef.current.forEach(mesh => {
      const domain = (mesh.userData as any).domain as DomainId;
      mesh.visible = selected.has(domain);
    });

    // Filter nodes: only show nodes whose domain is selected
    const visibleNodes = allNodesRef.current.filter(n => selected.has(n.domain));
    const visibleIds = new Set(visibleNodes.map(n => n.id));

    // Filter links: only show links where both endpoints are visible
    const visibleLinks = allLinksRef.current.filter(e => {
      const srcId = typeof e.source === 'object' ? (e.source as any).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as any).id : e.target;
      return visibleIds.has(srcId) && visibleIds.has(tgtId);
    });

    graph.graphData({ nodes: visibleNodes, links: visibleLinks });
  }, [selectedDomains, mode]);

  // ── Mount machines graph ────────────────────────────────────────────────────
  function mountMachinesGraph() {
    const container = containerRef.current!;
    const data = graphData!;

    // Classify and build nodes
    const nodes: MachineNode3D[] = data.nodes.map(n => {
      const cls = classifyMachine(n);
      const anchor = domainAnchor3D(cls.domain);
      return {
        ...n,
        domain: cls.domain,
        isExternal: cls.isExternal,
        colorState: 'idle' as const,
        x: anchor.x + (Math.random() - 0.5) * 200,
        y: anchor.y + (Math.random() - 0.5) * 200,
        z: anchor.z + (Math.random() - 0.5) * 150,
      };
    });

    const links = data.edges.map(e => ({ ...e }));

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
      .onNodeHover((node: any) => {
        const id = node ? (node as MachineNode3D).id : null;
        const { x, y } = mousePosRef.current;
        onMachineHoverRef.current?.(id, x, y);
      })
      .nodeColor((node: any) => {
        const n = node as MachineNode3D;
        const step = currentStepRef.current;
        const state = getMachineColorState(step?.machineResults[n.id]);
        if (state === 'fired') return '#ef4444';
        if (state === 'active') return vizTheme.accent.input;
        return domainColorHex(n.domain);
      })
      .nodeOpacity(0.92)
      .nodeResolution(16)
      .nodeVal((node: any) => {
        // Scale node size by sequence count or default
        const n = node as MachineNode3D;
        return Math.max(4, Math.min(20, (n.metadata?.sequenceCount ?? 3) * 2));
      })
      .linkSource('source')
      .linkTarget('target')
      .linkColor(() => EDGE_COLOR)
      .linkOpacity(0.8)
      .linkWidth(2.5)
      .linkDirectionalArrowLength(8)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor(() => ARROW_COLOR)
      .linkDirectionalParticles(0)
      .onNodeClick((node: any) => {
        const n = node as MachineNode3D;
        loadMachine(n.id);
      })
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3);

    // Add domain anchor forces via the d3 simulation
    const sim = graph.d3Force('charge');
    if (sim) {
      (sim as any).strength(-150);
    }

    // Add custom domain attraction forces
    graph
      .d3Force('domainX', forceX3D(nodes, 'x'))
      .d3Force('domainY', forceX3D(nodes, 'y'))
      .d3Force('domainZ', forceX3D(nodes, 'z'));

    graphRef.current = graph;

    // Build domain hulls after initial layout settles
    const hullTimer = setTimeout(() => buildDomainHulls(graph, nodes), 3000);

    // Periodically update hulls during simulation
    const hullInterval = setInterval(() => buildDomainHulls(graph, nodes), 1500);
    const stopHullUpdate = setTimeout(() => clearInterval(hullInterval), 15000);

    return () => {
      clearTimeout(hullTimer);
      clearInterval(hullInterval);
      clearTimeout(stopHullUpdate);
      // Clear any stale hover state so the shared tooltip overlay closes
      // when the user toggles back to 2D.
      onMachineHoverRef.current?.(null);
      // Remove hull meshes
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

  // ── Build domain hull meshes ──────────────────────────────────────────────
  function buildDomainHulls(graph: ForceGraph3DInstance, nodes: MachineNode3D[]) {
    const scene = graph.scene();

    // Remove old hulls
    hullMeshesRef.current.forEach(mesh => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    hullMeshesRef.current = [];

    const selected = new Set(selectedDomains);

    // Group nodes by domain
    const byDomain = new Map<DomainId, MachineNode3D[]>();
    for (const d of DOMAIN_ORDER) byDomain.set(d, []);
    for (const n of nodes) {
      byDomain.get(n.domain)!.push(n);
    }

    for (const [domainId, domainNodes] of byDomain.entries()) {
      if (domainNodes.length === 0) continue;

      const points = domainNodes.map(n =>
        new THREE.Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0)
      );

      const { color, alpha } = parseDomainFill(domainId);
      const mesh = buildConvexHullMesh(points, color, alpha);
      if (mesh) {
        mesh.userData = { domain: domainId };
        mesh.visible = selected.has(domainId);
        mesh.renderOrder = -1; // Render behind nodes
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
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: vizTheme.bg.page,
      }}
    />
  );
};

// ── Custom d3 force for 3D domain anchoring ──────────────────────────────────
// Pulls nodes toward their domain's 3D anchor position on a given axis.

function forceX3D(
  nodes: MachineNode3D[],
  axis: 'x' | 'y' | 'z',
) {
  const strength = 0.12;

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
