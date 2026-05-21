import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useVisualizerStore } from '../store';
import { VectorNode, OutputVector } from '../types';
import { Graph3DView } from './Graph3DView';
import { Graph3DToggle } from './Graph3DToggle';
import './VisLegend.css';

// ── Shared vis-palette (matches Tobias/MachineGraphView) ─────────────────────
const C_INITIAL       = '#3b82f6'; // blue  — start / A+ node
const C_ACTIVE        = '#06b6d4'; // cyan  — queued / active
const C_FIRED         = '#f59e0b'; // amber — output just emitted
const C_TERMINAL_REST = '#111827'; // dark  — terminal node, not yet fired
const C_DEFAULT       = '#64748b'; // slate — intermediate
const C_EDGE_IDLE     = '#e2e8f0'; // slate-200 — off-white for idle directed edges

const nodeColor = (d: { wasJustMatched?: boolean; isActive: boolean; isInitial: boolean; hasOutput: boolean }): string => {
  if (d.wasJustMatched) return C_FIRED;
  if (d.isActive)       return C_ACTIVE;
  if (d.isInitial)      return C_INITIAL;
  if (d.hasOutput)      return C_TERMINAL_REST;
  return C_DEFAULT;
};
const nodeStroke = (d: { wasJustMatched?: boolean; isActive: boolean; isInitial: boolean; hasOutput: boolean }): string => {
  if (d.wasJustMatched && d.isActive) return C_ACTIVE;
  if (d.wasJustMatched)               return '#fbbf24';
  if (d.isActive && d.hasOutput)      return C_ACTIVE;
  if (d.hasOutput)                    return C_FIRED;
  if (d.isActive)                     return '#0891b2';
  if (d.isInitial)                    return '#2563eb';
  return '#475569';
};
const nodeStrokeWidth = (d: { wasJustMatched?: boolean; isActive: boolean; hasOutput: boolean }): number => {
  if (d.wasJustMatched && d.isActive) return 6;
  if (d.wasJustMatched)               return 5;
  if (d.hasOutput)                    return 4;
  if (d.isActive)                     return 3;
  return 2;
};
const nodeFilter = (d: { wasJustMatched?: boolean; isActive: boolean }): string => {
  if (d.wasJustMatched && d.isActive) return `drop-shadow(0 0 10px ${C_FIRED}) drop-shadow(0 0 8px ${C_ACTIVE})`;
  if (d.wasJustMatched)               return `drop-shadow(0 0 10px ${C_FIRED})`;
  if (d.isActive)                     return `drop-shadow(0 0 6px ${C_ACTIVE})`;
  return 'none';
};

// ── Layout persistence ────────────────────────────────────────────────────────
const CEG_LAYOUT_PREFIX = 'ceg-graph-layout';

function cegLayoutKey(machineId: string | null | undefined): string {
  return `${CEG_LAYOUT_PREFIX}-${machineId ?? 'default'}`;
}
function loadCegLayout(machineId: string | null | undefined): Record<string, { fx: number; fy: number }> {
  try {
    const raw = localStorage.getItem(cegLayoutKey(machineId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveCegLayout(nodes: d3.SimulationNodeDatum[], machineId: string | null | undefined): void {
  const pins: Record<string, { fx: number; fy: number }> = {};
  for (const n of nodes as any[]) {
    if (n.fx != null && n.fy != null) pins[n.id] = { fx: n.fx, fy: n.fy };
  }
  try { localStorage.setItem(cegLayoutKey(machineId), JSON.stringify(pins)); } catch { /* ignore */ }
}

interface CriticalEventGraphViewProps {
  selectedSequenceId?: string | null;
}

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  label: string;
  isInitial: boolean;
  isActive: boolean;
  hasOutput: boolean;
  wasJustMatched?: boolean;
  lastOutputVector?: OutputVector | null;
  cluster?: string;
  clusterCenter?: { x: number; y: number };
  outputCount?: number;
  sequenceName?: string;
  metadata?: Record<string, any>;
  elements?: Array<{
    value: number;
    comparatorType: string;
    threshold?: number;
  }>;
  outputVectors?: Array<{
    id: string;
    vector: number[];
    timestamp: number;
    metadata?: string | Record<string, any>;
  }>;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  isActive?: boolean;
}

const CriticalEventGraphView: React.FC<CriticalEventGraphViewProps> = ({ selectedSequenceId }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const zoomTransformRef = useRef<d3.ZoomTransform | null>(null);
  const previousResetKeyRef = useRef<number>(0);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const nodeSelRef = useRef<d3.Selection<SVGCircleElement, GraphNode, SVGGElement, unknown> | null>(null);
  const linkSelRef = useRef<d3.Selection<SVGLineElement, GraphLink, SVGGElement, unknown> | null>(null);
  const structuralKeyRef = useRef<string>('');
  const { sequences, currentMachine, setHighlightedOutputId } = useVisualizerStore();
  const [legendOpen, setLegendOpen] = useState(false);
  const [is3D,       setIs3D]       = useState(false);
  const [layoutResetKey, setLayoutResetKey] = useState(0);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    // Clear positions only when layout reset key actually changes
    if (layoutResetKey !== previousResetKeyRef.current) {
      nodePositionsRef.current.clear();
      zoomTransformRef.current = null;
      try { localStorage.removeItem(cegLayoutKey(currentMachine?.id)); } catch { /* ignore */ }
      previousResetKeyRef.current = layoutResetKey;
    }

    // Get display sequences
    const displaySequences = currentMachine
      ? sequences.filter(seq => currentMachine.sequenceIds.includes(seq.sequenceId))
      : selectedSequenceId
      ? sequences.filter(s => s.sequenceId === selectedSequenceId)
      : sequences;

    if (displaySequences.length === 0) return;

    // Build graph data
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const clusters: Record<string, string[]> = {};

    displaySequences.forEach((sequence) => {
      const clusterId = sequence.sequenceId;
      clusters[clusterId] = [];

      sequence.nodes.forEach((node: VectorNode) => {
        const graphNode: GraphNode = {
          id: node.id,
          name: node.metadata?.name || node.label || node.id,
          label: node.label,
          isInitial: node.isInitial,
          isActive: node.isActive,
          hasOutput: node.hasOutput || (node.outputVectors && node.outputVectors.length > 0),
          wasJustMatched: node.wasJustMatched || false,
          lastOutputVector: node.lastOutputVector || null,
          cluster: clusterId,
          outputCount: node.outputVectors?.length || 0,
          sequenceName: sequence.sequenceName,
          metadata: node.metadata,
          elements: node.elements,
          outputVectors: node.outputVectors
        };
        nodes.push(graphNode);
        clusters[clusterId].push(node.id);
      });

      sequence.edges.forEach((edge) => {
        const sourceNode = sequence.nodes.find(n => n.id === edge.source);
        links.push({
          source: edge.source,
          target: edge.target,
          isActive: sourceNode?.isActive || false
        });
      });
    });

    // Set up dimensions
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Compute structural key — encodes node IDs + edge topology only, not state flags.
    const structuralKey = nodes.map(n => n.id).sort().join(',') + '|' +
      links.map(l => `${l.source as string}->${l.target as string}`).sort().join(',');

    // State-only change: same node IDs and edges — update visual attrs in-place,
    // no SVG teardown or simulation restart.
    if (
      structuralKey === structuralKeyRef.current &&
      layoutResetKey === previousResetKeyRef.current &&
      nodeSelRef.current !== null &&
      linkSelRef.current !== null
    ) {
      const nodeById = new Map<string, GraphNode>(nodes.map(n => [n.id, n]));
      nodeSelRef.current
        .attr('fill', d => nodeColor(nodeById.get(d.id) ?? d))
        .attr('stroke', d => nodeStroke(nodeById.get(d.id) ?? d))
        .attr('stroke-width', d => nodeStrokeWidth(nodeById.get(d.id) ?? d))
        .style('filter', d => nodeFilter(nodeById.get(d.id) ?? d));
      linkSelRef.current
        .attr('stroke', d => {
          const srcId = typeof d.source === 'object' ? (d.source as GraphNode).id : d.source as string;
          return (nodeById.get(srcId)?.isActive ?? false) ? C_ACTIVE : C_EDGE_IDLE;
        })
        .attr('stroke-width', d => {
          const srcId = typeof d.source === 'object' ? (d.source as GraphNode).id : d.source as string;
          return (nodeById.get(srcId)?.isActive ?? false) ? 3 : 2;
        })
        .attr('marker-end', d => {
          const srcId = typeof d.source === 'object' ? (d.source as GraphNode).id : d.source as string;
          return (nodeById.get(srcId)?.isActive ?? false) ? 'url(#arrowhead-active)' : 'url(#arrowhead)';
        });
      return;
    }

    // Structural change — update key and do full SVG rebuild.
    structuralKeyRef.current = structuralKey;

    // Clear previous SVG content
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    // Create container group for zoom/pan
    const g = svg.append('g');

    // Set up zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
        zoomTransformRef.current = event.transform;
      });

    svg.call(zoom);

    // Restore zoom transform if it exists
    if (zoomTransformRef.current) {
      svg.call(zoom.transform, zoomTransformRef.current);
    }

    // Define arrow markers
    const defs = svg.append('defs');

    // Normal arrow
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 25)
      .attr('refY', 0)
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', C_EDGE_IDLE);

    // Active arrow (cyan — matches C_ACTIVE)
    defs.append('marker')
      .attr('id', 'arrowhead-active')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 25)
      .attr('refY', 0)
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', C_ACTIVE);

    // Calculate cluster centers
    const clusterIds = Object.keys(clusters);
    const clusterCenters: Record<string, { x: number; y: number }> = {};

    clusterIds.forEach((clusterId, i) => {
      const angle = (i / clusterIds.length) * 2 * Math.PI;
      const radius = Math.min(width, height) * 0.3;
      clusterCenters[clusterId] = {
        x: width / 2 + radius * Math.cos(angle),
        y: height / 2 + radius * Math.sin(angle)
      };
    });

    // Assign cluster centers to nodes and restore positions if available
    let allNodesHavePositions = true;
    const savedPins = loadCegLayout(currentMachine?.id);
    nodes.forEach(node => {
      if (node.cluster) {
        node.clusterCenter = clusterCenters[node.cluster];
      }

      // Pinned positions (localStorage) take priority — kept fixed permanently
      const pin = savedPins[node.id];
      if (pin) {
        node.x  = pin.fx;
        node.y  = pin.fy;
        node.fx = pin.fx;
        node.fy = pin.fy;
      } else {
        // Restore transient position from previous render (in-memory only)
        const savedPosition = nodePositionsRef.current.get(node.id);
        if (savedPosition) {
          node.x  = savedPosition.x;
          node.y  = savedPosition.y;
          node.fx = savedPosition.x;
          node.fy = savedPosition.y;
        } else {
          allNodesHavePositions = false;
        }
      }
    });

    // Create force simulation
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(d => d.id).distance(100).strength(1))
      .force('charge', d3.forceManyBody<GraphNode>().strength(-300))
      .force('collision', d3.forceCollide<GraphNode>().radius(35))
      .force('x', d3.forceX<GraphNode>(d => d.clusterCenter ? d.clusterCenter.x : width / 2).strength(0.3))
      .force('y', d3.forceY<GraphNode>(d => d.clusterCenter ? d.clusterCenter.y : height / 2).strength(0.3));

    // Create links
    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('class', 'link')
      .attr('stroke', d => d.isActive ? C_ACTIVE : C_EDGE_IDLE)
      .attr('stroke-width', d => d.isActive ? 3 : 2)
      .attr('marker-end', d => d.isActive ? 'url(#arrowhead-active)' : 'url(#arrowhead)');

    // Create nodes
    const node = g.append('g')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('class', 'node')
      .attr('r', 15)
      .attr('fill', d => nodeColor(d))
      .attr('stroke', d => nodeStroke(d))
      .attr('stroke-width', d => nodeStrokeWidth(d))
      .style('cursor', 'pointer')
      .style('filter', d => {
        if (d.isActive) {
          return nodeFilter(d);
        }
        return 'none';
      });

    // Apply drag behavior — pin on drop, double-click to unpin
    const dragBehavior = d3.drag<any, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x ?? 0;
        d.fy = d.y ?? 0;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        // Pin at dropped position and persist
        d.fx = d.x ?? d.fx;
        d.fy = d.y ?? d.fy;
        saveCegLayout(nodes, currentMachine?.id);
      });

    node.call(dragBehavior as any);

    // Double-click to unpin
    let lastDblClickTime = 0;
    let lastDblClickId: string | null = null;
    node.on('dblclick', (_event, d: any) => {
      const now = Date.now();
      if (now - lastDblClickTime < 350 && lastDblClickId === d.id) {
        d.fx = null;
        d.fy = null;
        simulation.alpha(0.3).restart();
        saveCegLayout(nodes, currentMachine?.id);
      }
      lastDblClickTime = now;
      lastDblClickId   = d.id;
    });

    // Add hover behavior for final events with outputs
    node
      .on('mouseover', (_event, d) => {
        // Only highlight if this is a final event with an output
        if (d.hasOutput && d.lastOutputVector && d.lastOutputVector.id) {
          setHighlightedOutputId(d.lastOutputVector.id);
        }
      })
      .on('mouseout', () => {
        setHighlightedOutputId(null);
      });

    // Add labels
    const label = g.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text(d => d.name)
      .attr('font-size', 10)
      .attr('dx', 20)
      .attr('dy', 5)
      .attr('fill', '#e2e8f0')
      .style('pointer-events', 'none');

    // Add output vector display for final events
    const outputDisplay = g.append('g')
      .selectAll('g.output-display')
      .data(nodes.filter(d => d.lastOutputVector))
      .join('g')
      .attr('class', 'output-display');

    // Output vector background
    outputDisplay.append('rect')
      .attr('x', -50)
      .attr('y', -40)
      .attr('width', 100)
      .attr('height', 20)
      .attr('rx', 10)
      .attr('fill', 'rgba(168, 85, 247, 0.9)')
      .attr('stroke', '#c084fc')
      .attr('stroke-width', 2)
      .style('filter', 'drop-shadow(0 0 8px #a855f7)');

    // Output vector text
    outputDisplay.append('text')
      .text(d => {
        if (d.lastOutputVector && d.lastOutputVector.vector) {
          const formatted = d.lastOutputVector.vector
            .slice(0, 3)  // Show first 3 values
            .map(v => v.toFixed(1))
            .join(', ');
          return d.lastOutputVector.vector.length > 3
            ? `[${formatted}...]`
            : `[${formatted}]`;
        }
        return '';
      })
      .attr('text-anchor', 'middle')
      .attr('y', -25)
      .attr('font-size', 10)
      .attr('font-family', 'monospace')
      .attr('font-weight', '700')
      .attr('fill', '#fff')
      .style('pointer-events', 'none');

    // Create or reuse tooltip
    let tooltip;

    if (!tooltipRef.current) {
      // Create tooltip and append to body for proper positioning
      tooltip = d3.select('body')
        .append('div')
        .attr('class', 'event-tooltip')
        .style('position', 'fixed')
        .style('padding', '12px')
        .style('background', 'rgba(0, 0, 0, 0.98)')
        .style('border', '2px solid #3b82f6')
        .style('border-radius', '10px')
        .style('pointer-events', 'none')
        .style('font-size', '11px')
        .style('color', '#e2e8f0')
        .style('z-index', '10000')
        .style('display', 'none')
        .style('max-width', '400px')
        .style('box-shadow', '0 8px 32px rgba(0, 0, 0, 0.8), 0 0 20px rgba(59, 130, 246, 0.3)');

      tooltipRef.current = tooltip.node() as HTMLDivElement;
    } else {
      tooltip = d3.select(tooltipRef.current);
    }

    // Helper function to format metadata
    const formatMetadata = (metadata: Record<string, any> | undefined) => {
      if (!metadata || Object.keys(metadata).length === 0) return '';

      const items = Object.entries(metadata)
        .filter(([key]) => key !== 'name') // Skip 'name' as it's shown in header
        .map(([key, value]) => {
          const displayValue = typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
          return `
            <div style="display: flex; margin: 4px 0;">
              <span style="color: #94a3b8; min-width: 100px; font-weight: 500;">${key}:</span>
              <span style="color: #e2e8f0; margin-left: 8px; word-break: break-word;">${displayValue}</span>
            </div>
          `;
        })
        .join('');

      return items ? `
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #334155;">
          <div style="font-weight: 700; color: #94a3b8; margin-bottom: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">Metadata</div>
          ${items}
        </div>
      ` : '';
    };

    // Helper function to format event vector elements
    const formatElements = (elements: Array<{ value: number; comparatorType: string; threshold?: number }> | undefined) => {
      if (!elements || elements.length === 0) return '';

      const elementItems = elements
        .map((el, idx) => {
          const thresholdText = el.threshold !== undefined ? ` (threshold: ${el.threshold.toFixed(2)})` : '';
          return `
            <div style="display: flex; align-items: center; margin: 4px 0; font-family: monospace; font-size: 10px;">
              <span style="color: #64748b; min-width: 20px;">[${idx}]</span>
              <span style="color: #22c55e; margin: 0 8px; font-weight: 600;">${el.value.toFixed(3)}</span>
              <span style="color: #94a3b8;">${el.comparatorType}${thresholdText}</span>
            </div>
          `;
        })
        .join('');

      return `
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #334155;">
          <div style="font-weight: 700; color: #94a3b8; margin-bottom: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">Event Vector (${elements.length} elements)</div>
          <div style="background: rgba(15, 23, 42, 0.5); padding: 8px; border-radius: 6px; max-height: 150px; overflow-y: auto;">
            ${elementItems}
          </div>
        </div>
      `;
    };

    // Helper function to format output vectors
    const formatOutputVectors = (outputs: Array<{ id: string; vector: number[]; timestamp: number; metadata?: string | Record<string, any>; provenance?: string[] }> | undefined) => {
      if (!outputs || outputs.length === 0) return '';

      const outputItems = outputs
        .map((output, idx) => {
          const vectorStr = output.vector.map(v => v.toFixed(2)).join(', ');
          const metaStr = output.metadata
            ? (typeof output.metadata === 'string'
                ? output.metadata
                : JSON.stringify(output.metadata))
            : '';
          const timestamp = new Date(output.timestamp).toLocaleTimeString();
          // Provenance chain: comma-separated vector ids that led to this fire.
          // Helps an operator audit *why* a RED-tier output was asserted.
          const provStr = Array.isArray(output.provenance) && output.provenance.length > 0
            ? output.provenance.join(' → ')
            : '';

          return `
            <div style="margin: 6px 0; padding: 6px; background: rgba(245, 158, 11, 0.1); border-left: 2px solid #f59e0b; border-radius: 4px;">
              <div style="font-weight: 600; color: #fbbf24; margin-bottom: 3px;">#${idx + 1}: ${output.id}</div>
              <div style="font-family: monospace; font-size: 10px; color: #cbd5e1; margin: 2px 0;">[${vectorStr}]</div>
              ${metaStr ? `<div style="font-size: 10px; color: #94a3b8; margin-top: 3px;">${metaStr}</div>` : ''}
              ${provStr ? `<div style="font-size: 10px; color: #a78bfa; margin-top: 3px; font-family: monospace; word-break: break-all;">↳ ${provStr}</div>` : ''}
              <div style="font-size: 9px; color: #64748b; margin-top: 3px;">⏱ ${timestamp}</div>
            </div>
          `;
        })
        .join('');

      return `
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #334155;">
          <div style="font-weight: 700; color: #f59e0b; margin-bottom: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">Output Vectors (${outputs.length})</div>
          <div style="max-height: 200px; overflow-y: auto;">
            ${outputItems}
          </div>
        </div>
      `;
    };

    // Node interactions
    node.on('mouseover', function(event, d) {
      // Highlight node
      d3.select(this)
        .attr('r', 18)
        .style('filter', 'brightness(1.5)');

      // Build state badges
      const states = [];
      if (d.isInitial)      states.push('<span style="background:#3b82f6;color:#fff;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;">INITIAL</span>');
      if (d.isActive)       states.push('<span style="background:#06b6d4;color:#000;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;">ACTIVE</span>');
      if (d.wasJustMatched) states.push('<span style="background:#f59e0b;color:#000;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;">FIRED</span>');
      if (d.hasOutput)      states.push('<span style="background:#f59e0b;color:#000;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;">OUTPUT</span>');

      // Build comprehensive tooltip
      const tooltipContent = `
        <div style="border-bottom: 2px solid #3b82f6; padding-bottom: 10px; margin-bottom: 10px;">
          <div style="font-weight: 700; font-size: 14px; color: #3b82f6; margin-bottom: 6px;">
            ${d.name}
          </div>
          <div style="display: flex; gap: 4px; margin-bottom: 6px;">
            ${states.join('')}
          </div>
          <div style="font-family: monospace; color: #64748b; font-size: 10px;">
            ID: <span style="color: #94a3b8;">${d.id}</span>
          </div>
          ${d.label && d.label !== d.name ? `
            <div style="color: #94a3b8; font-size: 10px; margin-top: 3px;">
              Label: ${d.label}
            </div>
          ` : ''}
          ${d.sequenceName ? `
            <div style="color: #94a3b8; font-size: 10px; margin-top: 3px;">
              Sequence: <span style="color: #8b5cf6;">${d.sequenceName}</span>
            </div>
          ` : ''}
        </div>

        ${formatElements(d.elements)}
        ${formatMetadata(d.metadata)}
        ${formatOutputVectors(d.outputVectors)}
      `;

      // Calculate tooltip position to prevent off-screen (using clientX/clientY for fixed positioning)
      let tooltipX = event.clientX + 15;
      let tooltipY = event.clientY - 15;

      tooltip.html(tooltipContent)
        .style('display', 'block')
        .style('opacity', '0');

      // Get tooltip dimensions after content is set
      const tooltipNode = tooltip.node() as HTMLElement;
      const tooltipRect = tooltipNode.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // Adjust X position if tooltip goes off right edge
      if (tooltipX + tooltipRect.width > windowWidth - 20) {
        tooltipX = event.clientX - tooltipRect.width - 15;
      }

      // Adjust Y position if tooltip goes off bottom edge
      if (tooltipY + tooltipRect.height > windowHeight - 20) {
        tooltipY = windowHeight - tooltipRect.height - 20;
      }

      // Ensure tooltip doesn't go off top edge
      if (tooltipY < 20) {
        tooltipY = 20;
      }

      // Ensure tooltip doesn't go off left edge
      if (tooltipX < 20) {
        tooltipX = 20;
      }

      tooltip
        .style('left', tooltipX + 'px')
        .style('top', tooltipY + 'px')
        .style('max-height', (windowHeight - 40) + 'px')
        .style('overflow-y', 'auto')
        .transition()
        .duration(150)
        .style('opacity', '1');

      // Highlight connected links
      link.style('opacity', l => {
        const source = typeof l.source === 'object' ? l.source : nodes.find(n => n.id === l.source);
        const target = typeof l.target === 'object' ? l.target : nodes.find(n => n.id === l.target);
        return (source?.id === d.id || target?.id === d.id) ? 1 : 0.2;
      });

      // Highlight connected nodes
      node.style('opacity', n => {
        if (n.id === d.id) return 1;
        const isConnected = links.some(l => {
          const source = typeof l.source === 'object' ? l.source : nodes.find(node => node.id === l.source);
          const target = typeof l.target === 'object' ? l.target : nodes.find(node => node.id === l.target);
          return (source?.id === d.id && target?.id === n.id) || (target?.id === d.id && source?.id === n.id);
        });
        return isConnected ? 1 : 0.3;
      });

      label.style('opacity', n => n.id === d.id ? 1 : 0.3);
    })
    .on('mouseout', function(_event, d) {
      // Reset node — restore correct glow based on state
      d3.select(this)
        .attr('r', 15)
        .style('filter', nodeFilter(d));

      // Hide tooltip with fade out
      tooltip
        .transition()
        .duration(100)
        .style('opacity', '0')
        .on('end', function() {
          d3.select(this).style('display', 'none');
        });

      // Reset highlights
      link.style('opacity', 1);
      node.style('opacity', 1);
      label.style('opacity', 1);
    });

    // applyPositions: shared tick function used by both the live simulation and the
    // frozen-layout fast path — eliminates duplicated position-update code.
    const applyPositions = (): void => {
      link
        .attr('x1', d => {
          const source = typeof d.source === 'object' ? d.source : nodes.find(n => n.id === d.source);
          return source?.x || 0;
        })
        .attr('y1', d => {
          const source = typeof d.source === 'object' ? d.source : nodes.find(n => n.id === d.source);
          return source?.y || 0;
        })
        .attr('x2', d => {
          const target = typeof d.target === 'object' ? d.target : nodes.find(n => n.id === d.target);
          return target?.x || 0;
        })
        .attr('y2', d => {
          const target = typeof d.target === 'object' ? d.target : nodes.find(n => n.id === d.target);
          return target?.y || 0;
        });
      node
        .attr('cx', d => d.x || 0)
        .attr('cy', d => d.y || 0);
      label
        .attr('x', d => d.x || 0)
        .attr('y', d => d.y || 0);
      outputDisplay
        .attr('transform', d => `translate(${d.x || 0}, ${d.y || 0})`);
      nodes.forEach(n => {
        if (n.x !== undefined && n.y !== undefined) {
          nodePositionsRef.current.set(n.id, { x: n.x, y: n.y });
        }
      });
    };

    // Update positions on simulation tick
    simulation.on('tick', applyPositions);

    // If all nodes have saved positions, stop simulation immediately and update visuals once
    if (allNodesHavePositions) {
      // Apply positions via the shared helper — no simulation ticks needed.
      applyPositions();

      node
        .attr('fill', d => nodeColor(d))
        .attr('stroke', d => nodeStroke(d))
        .attr('stroke-width', d => nodeStrokeWidth(d))
        .style('filter', d => nodeFilter(d));

      // Update link colors based on active state
      link
        .attr('stroke', d => d.isActive ? C_ACTIVE : C_EDGE_IDLE)
        .attr('stroke-width', d => d.isActive ? 3 : 2)
        .attr('marker-end', d => d.isActive ? 'url(#arrowhead-active)' : 'url(#arrowhead)');

      // Stop simulation but keep fx/fy (respect pinned positions)
      simulation.alpha(0).stop();

      // Unfix only non-pinned nodes
      nodes.forEach(n => {
        if (!savedPins[n.id]) {
          n.fx = null;
          n.fy = null;
        }
      });
    }

    // Save selections for the state-only fast path on subsequent renders.
    simulationRef.current = simulation;
    nodeSelRef.current = node as any;
    linkSelRef.current = link as any;

    // Cleanup
    return () => {
      simulation.stop();
      // Hide tooltip but don't remove it (it's reused)
      if (tooltipRef.current) {
        d3.select(tooltipRef.current).style('display', 'none');
      }
    };
  }, [sequences, selectedSequenceId, currentMachine, layoutResetKey]);

  // Cleanup tooltip on unmount
  useEffect(() => {
    return () => {
      if (tooltipRef.current) {
        tooltipRef.current.remove();
        tooltipRef.current = null;
      }
    };
  }, []);

  // Build event node/edge data for 3D mode
  const eventNodes3D = React.useMemo(() => {
    if (!is3D) return undefined;
    const displaySequences = currentMachine
      ? sequences.filter(seq => currentMachine.sequenceIds.includes(seq.sequenceId))
      : selectedSequenceId
      ? sequences.filter(s => s.sequenceId === selectedSequenceId)
      : sequences;
    return displaySequences.flatMap(seq =>
      seq.nodes.map(n => ({
        id: n.id,
        label: n.label,
        isInitial: n.isInitial,
        isActive: n.isActive,
        hasOutput: n.hasOutput || (n.outputVectors?.length ?? 0) > 0,
        wasJustMatched: n.wasJustMatched,
        cluster: seq.sequenceId,
      }))
    );
  }, [is3D, sequences, currentMachine, selectedSequenceId]);

  const eventEdges3D = React.useMemo(() => {
    if (!is3D) return undefined;
    const displaySequences = currentMachine
      ? sequences.filter(seq => currentMachine.sequenceIds.includes(seq.sequenceId))
      : selectedSequenceId
      ? sequences.filter(s => s.sequenceId === selectedSequenceId)
      : sequences;
    return displaySequences.flatMap(seq =>
      seq.edges.map(e => ({ source: e.source, target: e.target }))
    );
  }, [is3D, sequences, currentMachine, selectedSequenceId]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', background: '#0a0a0a' }}>
      <Graph3DToggle is3D={is3D} onToggle={() => setIs3D(v => !v)} />

      {is3D && (
        <Graph3DView mode="events" eventNodes={eventNodes3D} eventEdges={eventEdges3D} />
      )}

      <svg ref={svgRef} style={{ width: '100%', height: '100%', cursor: 'grab', display: is3D ? 'none' : undefined }} />

      {/* Reset Layout — top-right, consistent with MachineGraphView header style */}
      {!is3D && (
      <button
        className="vis-reset-layout-btn"
        onClick={() => setLayoutResetKey(prev => prev + 1)}
        style={{ position: 'absolute', top: '14px', right: '50px', zIndex: 50 }}
        title="Clear pinned positions and let force layout run freely"
      >
        ⊹ Reset Layout
      </button>
      )}

      {/* Floating left-side legend — same placement as Tobias */}
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
              <span className="vis-legend-dot" style={{ background: C_INITIAL }} />
              <span>Start node (A+)</span>
            </div>
            <div className="vis-legend-item">
              <span className="vis-legend-dot" style={{ background: C_ACTIVE }} />
              <span>Queued / active</span>
            </div>
            <div className="vis-legend-item">
              <span className="vis-legend-dot vis-legend-ring" style={{ borderColor: C_FIRED }} />
              <span>Terminal (output)</span>
            </div>
            <div className="vis-legend-item">
              <span className="vis-legend-dot" style={{ background: C_FIRED }} />
              <span>Output emitted</span>
            </div>
            <div className="vis-legend-item">
              <span className="vis-legend-dot" style={{ background: C_DEFAULT }} />
              <span>Intermediate</span>
            </div>
            <div className="vis-legend-divider" />
            <div className="vis-legend-item" style={{ color: '#64748b', fontSize: '10px' }}>
              Scroll to zoom · Drag to pan
            </div>
            <div className="vis-legend-item" style={{ color: '#64748b', fontSize: '10px' }}>
              Drag node to pin
            </div>
            <div className="vis-legend-item" style={{ color: '#64748b', fontSize: '10px' }}>
              Double-click to unpin
            </div>
          </div>
        </div>
      </div>

      {/* Tooltip Scrollbar Styling */}
      <style>{`
        /* Custom scrollbar for event tooltip */
        .event-tooltip {
          scrollbar-width: thin;
          scrollbar-color: #3b82f6 rgba(15, 23, 42, 0.5);
        }

        .event-tooltip::-webkit-scrollbar {
          width: 8px;
        }

        .event-tooltip::-webkit-scrollbar-track {
          background: rgba(15, 23, 42, 0.5);
          border-radius: 4px;
        }

        .event-tooltip::-webkit-scrollbar-thumb {
          background: #3b82f6;
          border-radius: 4px;
        }

        .event-tooltip::-webkit-scrollbar-thumb:hover {
          background: #60a5fa;
        }

        /* Smooth transitions for tooltips */
        .event-tooltip {
          transition: opacity 150ms ease-in-out;
        }
      `}</style>
    </div>
  );
};

export default CriticalEventGraphView;
