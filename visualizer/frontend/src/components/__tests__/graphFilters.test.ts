import { describe, it, expect } from 'vitest';
import {
  applyNodeTypeFilter,
  applyPortalFocusFilter,
  applyMqttFilter,
  applyBusSemanticFilter,
  composeFilters,
  semanticLaneKey,
  semanticLaneLabel,
  ALL_FILTER_NODE_TYPES,
  type FilterNodeType,
  type FilterableNode,
  type FilterableEdge,
} from '../graphFilters';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const machines: FilterableNode[] = [
  { id: 'mach-1', role: 'standard',         domain: 'healthservices' },
  { id: 'mach-2', role: 'standard',         domain: 'agriculture' },
  { id: 'bus-1',  role: 'interconnect',     domain: 'healthservices' },
  { id: 'disp-1', role: 'agent-dispatcher', domain: 'healthservices' },
  { id: 'disp-2', role: 'agent-dispatcher', domain: 'agriculture' },
  { id: '__openclaw_portal_healthservices__', role: 'openclaw-virtual', domain: 'healthservices' },
  { id: '__openclaw_portal_agriculture__',   role: 'openclaw-virtual', domain: 'agriculture' },
];

const edges: FilterableEdge[] = [
  { source: 'mach-1', target: 'bus-1' },
  { source: 'bus-1',  target: 'disp-1' },
  { source: 'disp-1', target: '__openclaw_portal_healthservices__' },
  { source: 'mach-2', target: 'disp-2' },
  { source: 'disp-2', target: '__openclaw_portal_agriculture__' },
  { source: 'mach-1', target: 'mach-2' },  // cross-domain
];

// ── applyNodeTypeFilter ───────────────────────────────────────────────────────

describe('applyNodeTypeFilter', () => {
  it('returns all nodes when all types are enabled', () => {
    const result = applyNodeTypeFilter(machines, new Set(ALL_FILTER_NODE_TYPES));
    expect(result.size).toBe(machines.length);
  });

  it('returns all nodes when the enabled set is empty (pass-through)', () => {
    const result = applyNodeTypeFilter(machines, new Set());
    expect(result.size).toBe(machines.length);
  });

  it('filters to only standard machines', () => {
    const result = applyNodeTypeFilter(machines, new Set<FilterNodeType>(['standard']));
    expect(result.has('mach-1')).toBe(true);
    expect(result.has('mach-2')).toBe(true);
    expect(result.has('bus-1')).toBe(false);
    expect(result.has('disp-1')).toBe(false);
    expect(result.has('__openclaw_portal_healthservices__')).toBe(false);
  });

  it('filters to only agent-dispatcher and interconnect', () => {
    const result = applyNodeTypeFilter(
      machines,
      new Set<FilterNodeType>(['agent-dispatcher', 'interconnect']),
    );
    expect(result.has('disp-1')).toBe(true);
    expect(result.has('disp-2')).toBe(true);
    expect(result.has('bus-1')).toBe(true);
    expect(result.has('mach-1')).toBe(false);
    expect(result.has('__openclaw_portal_healthservices__')).toBe(false);
  });

  it('detects portal nodes by ID prefix regardless of role field', () => {
    const nodesWithWrongRole: FilterableNode[] = [
      { id: '__openclaw_portal_energy__', role: 'standard', domain: 'energy' },
    ];
    const result = applyNodeTypeFilter(
      nodesWithWrongRole,
      new Set<FilterNodeType>(['openclaw-virtual']),
    );
    expect(result.has('__openclaw_portal_energy__')).toBe(true);
  });
});

// ── applyPortalFocusFilter ────────────────────────────────────────────────────

describe('applyPortalFocusFilter', () => {
  it('returns only portal nodes and their direct neighbors', () => {
    const { visibleNodeIds } = applyPortalFocusFilter(machines, edges);
    // Portals
    expect(visibleNodeIds.has('__openclaw_portal_healthservices__')).toBe(true);
    expect(visibleNodeIds.has('__openclaw_portal_agriculture__')).toBe(true);
    // Direct neighbors of portals
    expect(visibleNodeIds.has('disp-1')).toBe(true);
    expect(visibleNodeIds.has('disp-2')).toBe(true);
    // Not directly connected to any portal
    expect(visibleNodeIds.has('mach-1')).toBe(false);
    expect(visibleNodeIds.has('bus-1')).toBe(false);
  });

  it('includes only edges connecting visible nodes', () => {
    const { visibleEdgeIds } = applyPortalFocusFilter(machines, edges);
    // disp-1 → portal_healthservices (index 2)
    expect(visibleEdgeIds.has(2)).toBe(true);
    // disp-2 → portal_agriculture (index 4)
    expect(visibleEdgeIds.has(4)).toBe(true);
    // mach-1 → bus-1 (index 0) — mach-1 not visible
    expect(visibleEdgeIds.has(0)).toBe(false);
  });

  it('returns empty visible sets when no portals exist', () => {
    const noPortalNodes: FilterableNode[] = [
      { id: 'mach-a', role: 'standard', domain: 'general' },
    ];
    const { visibleNodeIds } = applyPortalFocusFilter(noPortalNodes, []);
    expect(visibleNodeIds.size).toBe(0);
  });

  it('handles object-style edge source/target', () => {
    const objEdges: FilterableEdge[] = [
      { source: { id: 'disp-1' }, target: { id: '__openclaw_portal_healthservices__' } },
    ];
    const { visibleNodeIds } = applyPortalFocusFilter(machines, objEdges);
    expect(visibleNodeIds.has('disp-1')).toBe(true);
    expect(visibleNodeIds.has('__openclaw_portal_healthservices__')).toBe(true);
  });
});

// ── applyMqttFilter ───────────────────────────────────────────────────────────

describe('applyMqttFilter', () => {
  it('returns all nodes when mqttMachineIds is empty (pass-through)', () => {
    const result = applyMqttFilter(machines, new Set());
    expect(result.size).toBe(machines.length);
  });

  it('returns only machines whose ID is in the MQTT set', () => {
    const mqttIds = new Set(['mach-1', 'mach-2']);
    const result = applyMqttFilter(machines, mqttIds);
    expect(result.has('mach-1')).toBe(true);
    expect(result.has('mach-2')).toBe(true);
    expect(result.has('bus-1')).toBe(false);
    expect(result.has('disp-1')).toBe(false);
  });

  it('returns empty set when no nodes match', () => {
    const result = applyMqttFilter(machines, new Set(['nonexistent-id']));
    expect(result.size).toBe(0);
  });
});

// ── applyBusSemanticFilter ────────────────────────────────────────────────────

describe('applyBusSemanticFilter', () => {
  it('returns all nodes and edges when no lanes selected', () => {
    const { visibleNodeIds, visibleEdgeIds } = applyBusSemanticFilter(
      machines, edges, new Set(),
    );
    expect(visibleNodeIds.size).toBe(machines.length);
    expect(visibleEdgeIds.size).toBe(edges.length);
  });

  it('shows only nodes in domains connected by selected lane', () => {
    const laneKey = 'agriculture|healthservices'; // sorted
    const { visibleNodeIds } = applyBusSemanticFilter(
      machines, edges, new Set([laneKey]),
    );
    // mach-1 → mach-2 is a cross-domain edge (healthservices → agriculture)
    // both domains should be visible
    expect(visibleNodeIds.has('mach-1')).toBe(true);
    expect(visibleNodeIds.has('mach-2')).toBe(true);
    expect(visibleNodeIds.has('bus-1')).toBe(true);  // also healthservices
    expect(visibleNodeIds.has('disp-1')).toBe(true); // healthservices
  });

  it('includes the cross-domain edge in visible edges', () => {
    const laneKey = 'agriculture|healthservices';
    const { visibleEdgeIds } = applyBusSemanticFilter(
      machines, edges, new Set([laneKey]),
    );
    // mach-1 → mach-2 is index 5
    expect(visibleEdgeIds.has(5)).toBe(true);
  });
});

// ── composeFilters ────────────────────────────────────────────────────────────

describe('composeFilters', () => {
  const defaultFilters = {
    enabledNodeTypes: new Set(ALL_FILTER_NODE_TYPES),
    portalFocusActive: false,
    mqttFocusActive: false,
    selectedSemanticLanes: new Set<string>(),
    mqttMachineIds: new Set<string>(),
  };

  it('returns all nodes/edges when filter state is default', () => {
    const { visibleNodeIds, visibleEdgeIds } = composeFilters(machines, edges, defaultFilters);
    expect(visibleNodeIds.size).toBe(machines.length);
    expect(visibleEdgeIds.size).toBe(edges.length);
  });

  it('applies node-type filter when types are restricted', () => {
    const filters = {
      ...defaultFilters,
      enabledNodeTypes: new Set<FilterNodeType>(['agent-dispatcher', 'openclaw-virtual']),
    };
    const { visibleNodeIds } = composeFilters(machines, edges, filters);
    expect(visibleNodeIds.has('disp-1')).toBe(true);
    expect(visibleNodeIds.has('disp-2')).toBe(true);
    expect(visibleNodeIds.has('__openclaw_portal_healthservices__')).toBe(true);
    expect(visibleNodeIds.has('mach-1')).toBe(false);
    expect(visibleNodeIds.has('bus-1')).toBe(false);
  });

  it('applies portal focus filter', () => {
    const filters = { ...defaultFilters, portalFocusActive: true };
    const { visibleNodeIds } = composeFilters(machines, edges, filters);
    expect(visibleNodeIds.has('disp-1')).toBe(true);
    expect(visibleNodeIds.has('__openclaw_portal_healthservices__')).toBe(true);
    expect(visibleNodeIds.has('mach-1')).toBe(false);
  });

  it('applies MQTT focus filter', () => {
    const filters = {
      ...defaultFilters,
      mqttFocusActive: true,
      mqttMachineIds: new Set(['mach-1']),
    };
    const { visibleNodeIds } = composeFilters(machines, edges, filters);
    expect(visibleNodeIds.has('mach-1')).toBe(true);
    expect(visibleNodeIds.has('mach-2')).toBe(false);
    expect(visibleNodeIds.has('disp-1')).toBe(false);
  });

  it('composes portal focus with node-type filter', () => {
    // Node-type restricts to agents + portals; portal focus further restricts
    // to portal neighbors. Agents that are direct portal neighbors survive both.
    const filters = {
      ...defaultFilters,
      enabledNodeTypes: new Set<FilterNodeType>(['agent-dispatcher', 'openclaw-virtual']),
      portalFocusActive: true,
    };
    const { visibleNodeIds } = composeFilters(machines, edges, filters);
    expect(visibleNodeIds.has('disp-1')).toBe(true);
    expect(visibleNodeIds.has('__openclaw_portal_healthservices__')).toBe(true);
    // bus-1 would be a portal neighbor but it's excluded by node-type filter
    expect(visibleNodeIds.has('bus-1')).toBe(false);
  });
});

// ── semanticLaneKey / semanticLaneLabel ───────────────────────────────────────

describe('semanticLaneKey', () => {
  it('sorts domain names alphabetically', () => {
    expect(semanticLaneKey('transportation', 'agriculture')).toBe('agriculture|transportation');
    expect(semanticLaneKey('agriculture', 'transportation')).toBe('agriculture|transportation');
  });

  it('produces the same key for both orderings', () => {
    const a = semanticLaneKey('energy', 'healthservices');
    const b = semanticLaneKey('healthservices', 'energy');
    expect(a).toBe(b);
  });
});

describe('semanticLaneLabel', () => {
  it('formats the key into a human-readable label', () => {
    const label = semanticLaneLabel(
      'agriculture|healthservices',
      d => d.toUpperCase(),
    );
    expect(label).toBe('AGRICULTURE → HEALTHSERVICES');
  });
});
