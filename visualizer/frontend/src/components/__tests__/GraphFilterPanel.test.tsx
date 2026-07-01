/**
 * GraphFilterPanel component tests — Vitest + React Testing Library
 *
 * Covers the legend filter UI as specified in Manager#18:
 * - Renders node-type chips for all 4 categories (Machines, Interconnects,
 *   Agent Dispatchers, Portals)
 * - All chips start aria-pressed="true" (all types enabled by default)
 * - Toggling a chip calls toggleNodeType with the correct type
 * - "OpenClaw Portals only" checkbox toggles portalFocusActive
 * - "MQTT sources only" checkbox toggles mqttFocusActive
 * - Filter status count appears when any filter is active
 * - Reset button appears only when filters are active and calls resetGraphFilters
 * - Bus semantic lane checkboxes render when lanes are provided
 * - Selecting two semantic lanes calls toggleSemanticLane for each
 * - Reset button is absent when no filters are active
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphFilterPanel } from '../GraphFilterPanel';
import { ALL_FILTER_NODE_TYPES, FILTER_NODE_TYPE_LABELS } from '../graphFilters';

// ── Mock store ─────────────────────────────────────────────────────────────────

const mockToggleNodeType     = vi.fn();
const mockSetPortalFocus     = vi.fn();
const mockSetMqttFocus       = vi.fn();
const mockToggleSemanticLane = vi.fn();
const mockResetGraphFilters  = vi.fn();

const defaultGraphFilters = {
  enabledNodeTypes:      new Set(ALL_FILTER_NODE_TYPES),
  portalFocusActive:     false,
  mqttFocusActive:       false,
  selectedSemanticLanes: new Set<string>(),
  mqttMachineIds:        new Set<string>(),
};

let storeState = { ...defaultGraphFilters };

vi.mock('../../store', () => ({
  useVisualizerStore: (sel: any) => sel({
    graphFilters: storeState,
    toggleNodeType:     mockToggleNodeType,
    setPortalFocus:     mockSetPortalFocus,
    setMqttFocus:       mockSetMqttFocus,
    toggleSemanticLane: mockToggleSemanticLane,
    resetGraphFilters:  mockResetGraphFilters,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({
    tokens: {
      openclaw: { node: '#ff6b35' },
    },
  }),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NO_LANES: [] = [];
const SOME_LANES = [
  { key: 'agriculture|healthservices', label: 'AGRICULTURE → HEALTHSERVICES' },
  { key: 'energy|transportation',      label: 'ENERGY → TRANSPORTATION' },
];

function renderPanel({
  lanes = NO_LANES,
  visible = 20,
  total = 20,
}: { lanes?: typeof SOME_LANES; visible?: number; total?: number } = {}) {
  return render(
    <GraphFilterPanel
      availableSemanticLanes={lanes}
      visibleNodeCount={visible}
      totalNodeCount={total}
    />,
  );
}

// ── Reset before each test ────────────────────────────────────────────────────

beforeEach(() => {
  storeState = {
    enabledNodeTypes:      new Set(ALL_FILTER_NODE_TYPES),
    portalFocusActive:     false,
    mqttFocusActive:       false,
    selectedSemanticLanes: new Set<string>(),
    mqttMachineIds:        new Set<string>(),
  };
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GraphFilterPanel — node-type chips', () => {
  it('renders a chip for each of the 4 node-type categories', () => {
    renderPanel();
    const chips = screen.getAllByRole('button', { hidden: false });
    const chipLabels = chips.map(c => c.textContent);
    for (const type of ALL_FILTER_NODE_TYPES) {
      expect(chipLabels).toContain(FILTER_NODE_TYPE_LABELS[type]);
    }
    expect(ALL_FILTER_NODE_TYPES).toHaveLength(4);
  });

  it('all chips start with aria-pressed="true" (all types enabled)', () => {
    renderPanel();
    for (const type of ALL_FILTER_NODE_TYPES) {
      const chip = screen.getByRole('button', { name: new RegExp(FILTER_NODE_TYPE_LABELS[type], 'i') });
      expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
  });

  it('chips are aria-pressed="false" when type is disabled', () => {
    storeState = {
      ...storeState,
      enabledNodeTypes: new Set(['interconnect', 'agent-dispatcher', 'openclaw-virtual']),
    };
    renderPanel();
    const machineChip = screen.getByRole('button', { name: /Machines/i });
    expect(machineChip).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a chip calls toggleNodeType with the correct type', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Machines/i }));
    expect(mockToggleNodeType).toHaveBeenCalledWith('standard');

    fireEvent.click(screen.getByRole('button', { name: /Interconnects/i }));
    expect(mockToggleNodeType).toHaveBeenCalledWith('interconnect');

    fireEvent.click(screen.getByRole('button', { name: /Agent Dispatchers/i }));
    expect(mockToggleNodeType).toHaveBeenCalledWith('agent-dispatcher');

    fireEvent.click(screen.getByRole('button', { name: /Portals/i }));
    expect(mockToggleNodeType).toHaveBeenCalledWith('openclaw-virtual');
  });

  it('chip group has correct ARIA group role and label', () => {
    renderPanel();
    expect(screen.getByRole('group', { name: /Node type filters/i })).toBeInTheDocument();
  });
});

describe('GraphFilterPanel — focus view controls', () => {
  it('renders OpenClaw Portals only checkbox unchecked by default', () => {
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: /OpenClaw Portals only/i });
    expect(cb).not.toBeChecked();
  });

  it('checking "OpenClaw Portals only" calls setPortalFocus(true)', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /OpenClaw Portals only/i }));
    expect(mockSetPortalFocus).toHaveBeenCalledWith(true);
  });

  it('renders "OpenClaw Portals only" checked when portalFocusActive=true', () => {
    storeState = { ...storeState, portalFocusActive: true };
    renderPanel();
    expect(screen.getByRole('checkbox', { name: /OpenClaw Portals only/i })).toBeChecked();
  });

  it('unchecking portal focus calls setPortalFocus(false)', () => {
    storeState = { ...storeState, portalFocusActive: true };
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /OpenClaw Portals only/i }));
    expect(mockSetPortalFocus).toHaveBeenCalledWith(false);
  });

  it('renders MQTT sources only checkbox unchecked by default', () => {
    renderPanel();
    expect(screen.getByRole('checkbox', { name: /MQTT sources only/i })).not.toBeChecked();
  });

  it('checking "MQTT sources only" calls setMqttFocus(true)', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /MQTT sources only/i }));
    expect(mockSetMqttFocus).toHaveBeenCalledWith(true);
  });
});

describe('GraphFilterPanel — filter status and reset', () => {
  it('does not show filter status or reset button when no filters active', () => {
    renderPanel({ visible: 20, total: 20 });
    expect(screen.queryByText(/\d+\/\d+/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset all graph filters/i })).not.toBeInTheDocument();
  });

  it('shows filter status "X/Y" when a node-type is disabled', () => {
    storeState = {
      ...storeState,
      enabledNodeTypes: new Set(['interconnect', 'agent-dispatcher', 'openclaw-virtual']),
    };
    renderPanel({ visible: 5, total: 20 });
    expect(screen.getByText('5/20')).toBeInTheDocument();
  });

  it('shows reset button when portal focus is active', () => {
    storeState = { ...storeState, portalFocusActive: true };
    renderPanel({ visible: 3, total: 20 });
    const resetBtn = screen.getByRole('button', { name: /Reset all graph filters/i });
    expect(resetBtn).toBeInTheDocument();
  });

  it('clicking reset button calls resetGraphFilters', () => {
    storeState = { ...storeState, mqttFocusActive: true };
    renderPanel({ visible: 2, total: 20 });
    fireEvent.click(screen.getByRole('button', { name: /Reset all graph filters/i }));
    expect(mockResetGraphFilters).toHaveBeenCalledTimes(1);
  });

  it('filter status live region has aria-live="polite"', () => {
    storeState = {
      ...storeState,
      enabledNodeTypes: new Set(['interconnect']),
    };
    renderPanel({ visible: 8, total: 20 });
    const status = screen.getByText('8/20');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});

describe('GraphFilterPanel — semantic lane filters', () => {
  it('does not render lane section when no lanes provided', () => {
    renderPanel({ lanes: NO_LANES });
    expect(screen.queryByRole('group', { name: /Semantic lane filters/i })).not.toBeInTheDocument();
  });

  it('renders semantic lane checkboxes when lanes are provided', () => {
    renderPanel({ lanes: SOME_LANES });
    expect(screen.getByRole('group', { name: /Semantic lane filters/i })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(SOME_LANES.length + 2); // + portal + mqtt
  });

  it('lane checkboxes render with correct labels', () => {
    renderPanel({ lanes: SOME_LANES });
    expect(screen.getByRole('checkbox', { name: /AGRICULTURE → HEALTHSERVICES/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /ENERGY → TRANSPORTATION/i })).toBeInTheDocument();
  });

  it('lane checkboxes start unchecked', () => {
    renderPanel({ lanes: SOME_LANES });
    for (const lane of SOME_LANES) {
      expect(screen.getByRole('checkbox', { name: new RegExp(lane.label, 'i') })).not.toBeChecked();
    }
  });

  it('clicking a lane checkbox calls toggleSemanticLane with the lane key', () => {
    renderPanel({ lanes: SOME_LANES });
    fireEvent.click(screen.getByRole('checkbox', { name: /AGRICULTURE → HEALTHSERVICES/i }));
    expect(mockToggleSemanticLane).toHaveBeenCalledWith('agriculture|healthservices');
  });

  it('selected lanes show as checked', () => {
    storeState = {
      ...storeState,
      selectedSemanticLanes: new Set(['agriculture|healthservices']),
    };
    renderPanel({ lanes: SOME_LANES });
    expect(screen.getByRole('checkbox', { name: /AGRICULTURE → HEALTHSERVICES/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ENERGY → TRANSPORTATION/i })).not.toBeChecked();
  });

  it('clicking two lanes independently calls toggleSemanticLane twice', () => {
    renderPanel({ lanes: SOME_LANES });
    fireEvent.click(screen.getByRole('checkbox', { name: /AGRICULTURE → HEALTHSERVICES/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /ENERGY → TRANSPORTATION/i }));
    expect(mockToggleSemanticLane).toHaveBeenCalledTimes(2);
    expect(mockToggleSemanticLane).toHaveBeenNthCalledWith(1, 'agriculture|healthservices');
    expect(mockToggleSemanticLane).toHaveBeenNthCalledWith(2, 'energy|transportation');
  });

  it('active lane selection triggers reset button visibility', () => {
    storeState = {
      ...storeState,
      selectedSemanticLanes: new Set(['energy|transportation']),
    };
    renderPanel({ lanes: SOME_LANES, visible: 10, total: 20 });
    expect(screen.getByRole('button', { name: /Reset all graph filters/i })).toBeInTheDocument();
  });
});
