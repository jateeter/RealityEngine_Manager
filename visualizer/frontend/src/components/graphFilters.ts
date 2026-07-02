/**
 * graphFilters — Pure filter functions for the machine graph.
 *
 * All functions are side-effect-free so they can be unit-tested
 * without any DOM, D3, or React dependencies.
 */

import type { NodeRole } from './machineDomains';
import { isPortalNode } from './machineDomains';

// ── Node role categories available in the filter UI ──────────────────────────

export type FilterNodeType =
  | 'standard'
  | 'interconnect'
  | 'agent-dispatcher'
  | 'openclaw-virtual'
  | 'pe-source';

export const ALL_FILTER_NODE_TYPES: FilterNodeType[] = [
  'standard',
  'interconnect',
  'agent-dispatcher',
  'openclaw-virtual',
  'pe-source',
];

export const FILTER_NODE_TYPE_LABELS: Record<FilterNodeType, string> = {
  'standard':          'Machines',
  'interconnect':      'Interconnects',
  'agent-dispatcher':  'Agent Dispatchers',
  'openclaw-virtual':  'Portals',
  'pe-source':         'PE Sources',
};

// ── Minimal shape requirements ────────────────────────────────────────────────

export interface FilterableNode {
  id: string;
  role?: NodeRole | 'openclaw-virtual' | 'pe-source';
  domain?: string;
  inputMapping?: { offset: number; length: number };
}

export interface FilterableEdge {
  source: string | { id: string };
  target: string | { id: string };
}

function edgeSrcId(e: FilterableEdge): string {
  return typeof e.source === 'object' ? e.source.id : e.source;
}

function edgeTgtId(e: FilterableEdge): string {
  return typeof e.target === 'object' ? e.target.id : e.target;
}

// ── Individual filter functions ───────────────────────────────────────────────

/**
 * Returns the subset of nodes whose role is in `enabledTypes`.
 * An empty set disables no nodes (pass-through).
 */
export function applyNodeTypeFilter<N extends FilterableNode>(
  nodes: N[],
  enabledTypes: Set<FilterNodeType>,
): Set<string> {
  if (enabledTypes.size === 0 || enabledTypes.size === ALL_FILTER_NODE_TYPES.length) {
    return new Set(nodes.map(n => n.id));
  }
  return new Set(
    nodes
      .filter(n => {
        const role = isPortalNode(n.id)
          ? 'openclaw-virtual'
          : (n.role ?? 'standard');
        return enabledTypes.has(role as FilterNodeType);
      })
      .map(n => n.id),
  );
}

/**
 * Returns nodes that are either portal nodes or directly connected (via an edge)
 * to a portal node — i.e. agent-dispatchers in the same domain.
 * Edges are scoped to those whose both endpoints survive.
 */
export function applyPortalFocusFilter<N extends FilterableNode, E extends FilterableEdge>(
  nodes: N[],
  edges: E[],
): { visibleNodeIds: Set<string>; visibleEdgeIds: Set<number> } {
  const portalIds = new Set(nodes.filter(n => isPortalNode(n.id)).map(n => n.id));

  // Collect machine IDs that are connected to a portal node
  const connectedIds = new Set<string>();
  for (const e of edges) {
    const src = edgeSrcId(e);
    const tgt = edgeTgtId(e);
    if (portalIds.has(tgt)) connectedIds.add(src);
    if (portalIds.has(src)) connectedIds.add(tgt);
  }

  const visibleNodeIds = new Set([...portalIds, ...connectedIds]);

  const visibleEdgeIds = new Set<number>();
  edges.forEach((e, i) => {
    if (visibleNodeIds.has(edgeSrcId(e)) && visibleNodeIds.has(edgeTgtId(e))) {
      visibleEdgeIds.add(i);
    }
  });

  return { visibleNodeIds, visibleEdgeIds };
}

/**
 * Returns nodes whose input PS region overlaps any MQTT-sourced sensor band.
 * `mqttMachineIds` is a pre-computed set populated by querying `/api/pe/mqtt/mappings`.
 */
export function applyMqttFilter<N extends FilterableNode>(
  nodes: N[],
  mqttMachineIds: Set<string>,
): Set<string> {
  if (mqttMachineIds.size === 0) return new Set(nodes.map(n => n.id));
  return new Set(nodes.filter(n => mqttMachineIds.has(n.id)).map(n => n.id));
}

/**
 * Returns nodes participating in at least one of the `selectedLanes`.
 * Each lane key is `"domainA|domainB"` (sorted alphabetically).
 */
export function applyBusSemanticFilter<N extends FilterableNode, E extends FilterableEdge>(
  nodes: N[],
  edges: E[],
  selectedLanes: Set<string>,
): { visibleNodeIds: Set<string>; visibleEdgeIds: Set<number> } {
  if (selectedLanes.size === 0) {
    return {
      visibleNodeIds: new Set(nodes.map(n => n.id)),
      visibleEdgeIds: new Set(edges.map((_, i) => i)),
    };
  }

  // Build a node → domain map
  const domainOf = new Map(nodes.map(n => [n.id, n.domain ?? 'general']));

  const visibleEdgeIds = new Set<number>();
  const visibleDomains = new Set<string>();

  edges.forEach((e, i) => {
    const srcDomain = domainOf.get(edgeSrcId(e)) ?? 'general';
    const tgtDomain = domainOf.get(edgeTgtId(e)) ?? 'general';
    if (srcDomain === tgtDomain) return;
    const laneKey = [srcDomain, tgtDomain].sort().join('|');
    if (selectedLanes.has(laneKey)) {
      visibleEdgeIds.add(i);
      visibleDomains.add(srcDomain);
      visibleDomains.add(tgtDomain);
    }
  });

  const visibleNodeIds = new Set(
    nodes.filter(n => visibleDomains.has(n.domain ?? 'general')).map(n => n.id),
  );

  return { visibleNodeIds, visibleEdgeIds };
}

// ── Composed filter ───────────────────────────────────────────────────────────

export interface GraphFilterState {
  enabledNodeTypes: Set<FilterNodeType>;
  portalFocusActive: boolean;
  mqttFocusActive: boolean;
  selectedSemanticLanes: Set<string>;
  mqttMachineIds: Set<string>;
}

/**
 * Compose all active filters into a unified set of visible node and edge IDs.
 * Filters are AND-composed: a node must pass every active filter to be visible.
 */
export function composeFilters<N extends FilterableNode, E extends FilterableEdge>(
  nodes: N[],
  edges: E[],
  filterState: GraphFilterState,
): { visibleNodeIds: Set<string>; visibleEdgeIds: Set<number> } {
  const allNodeIds = new Set(nodes.map(n => n.id));
  const allEdgeIds = new Set(edges.map((_, i) => i));

  const isDefaultState =
    (filterState.enabledNodeTypes.size === 0 ||
      filterState.enabledNodeTypes.size === ALL_FILTER_NODE_TYPES.length) &&
    !filterState.portalFocusActive &&
    !filterState.mqttFocusActive &&
    filterState.selectedSemanticLanes.size === 0;

  if (isDefaultState) {
    return { visibleNodeIds: allNodeIds, visibleEdgeIds: allEdgeIds };
  }

  let nodeIds: Set<string> = allNodeIds;
  let edgeIds: Set<number> = allEdgeIds;

  // Node-type filter
  if (filterState.enabledNodeTypes.size > 0 &&
    filterState.enabledNodeTypes.size < ALL_FILTER_NODE_TYPES.length) {
    const typeResult = applyNodeTypeFilter(nodes, filterState.enabledNodeTypes);
    nodeIds = new Set([...nodeIds].filter(id => typeResult.has(id)));
    edgeIds = new Set(
      [...edgeIds].filter(i => nodeIds.has(edgeSrcId(edges[i])) && nodeIds.has(edgeTgtId(edges[i]))),
    );
  }

  // Portal focus (overrides node-type filter when active)
  if (filterState.portalFocusActive) {
    const { visibleNodeIds, visibleEdgeIds } = applyPortalFocusFilter(nodes, edges);
    nodeIds = new Set([...nodeIds].filter(id => visibleNodeIds.has(id)));
    edgeIds = new Set([...edgeIds].filter(i => visibleEdgeIds.has(i)));
  }

  // MQTT focus
  if (filterState.mqttFocusActive) {
    const mqttIds = applyMqttFilter(nodes, filterState.mqttMachineIds);
    nodeIds = new Set([...nodeIds].filter(id => mqttIds.has(id)));
    edgeIds = new Set(
      [...edgeIds].filter(i => nodeIds.has(edgeSrcId(edges[i])) && nodeIds.has(edgeTgtId(edges[i]))),
    );
  }

  // Bus semantic filter
  if (filterState.selectedSemanticLanes.size > 0) {
    const { visibleNodeIds, visibleEdgeIds } = applyBusSemanticFilter(
      nodes, edges, filterState.selectedSemanticLanes,
    );
    nodeIds = new Set([...nodeIds].filter(id => visibleNodeIds.has(id)));
    edgeIds = new Set([...edgeIds].filter(i => visibleEdgeIds.has(i)));
  }

  return { visibleNodeIds: nodeIds, visibleEdgeIds: edgeIds };
}

// ── Semantic lane key helpers ─────────────────────────────────────────────────

export function semanticLaneKey(domainA: string, domainB: string): string {
  return [domainA, domainB].sort().join('|');
}

export function semanticLaneLabel(key: string, domainLabel: (d: string) => string): string {
  const [a, b] = key.split('|');
  return `${domainLabel(a)} → ${domainLabel(b)}`;
}
