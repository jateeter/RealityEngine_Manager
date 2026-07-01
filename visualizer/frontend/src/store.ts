import { create } from 'zustand';
import { Machine } from './types';
import { api } from './api';
import type { DomainId } from './components/machineDomains';
import { DOMAIN_ORDER } from './components/machineDomains';
import type { FilterNodeType } from './components/graphFilters';
import { ALL_FILTER_NODE_TYPES } from './components/graphFilters';
import type { ThemeId } from './styles/themes/index';

// ── Visualizer settings ───────────────────────────────────────────────────────

export interface VisualizerSettings {
  themeId:             ThemeId;
  compactThreshold:    number;
  edgeOpacity:         number;
  semanticLaneOpacity: number;
  domainHullOpacity:   number;
  animationSpeed:      'slow' | 'normal' | 'fast';
  reduceMotion:        boolean;
  autoOpenLegend:      boolean;
  showCorpusChip:      boolean;
  showEdgeLabels:      boolean;
  threeDDefault:       boolean;
  nodeLabelCutoff:     number;
}

const DEFAULT_SETTINGS: VisualizerSettings = {
  themeId:             'dark',
  compactThreshold:    100,
  edgeOpacity:         0.80,
  semanticLaneOpacity: 0.14,
  domainHullOpacity:   0.75,
  animationSpeed:      'normal',
  reduceMotion:        false,
  autoOpenLegend:      false,
  showCorpusChip:      true,
  showEdgeLabels:      false,
  threeDDefault:       false,
  nodeLabelCutoff:     22,
};

// ── Graph filter state ────────────────────────────────────────────────────────

export interface GraphFilterState {
  enabledNodeTypes: Set<FilterNodeType>;
  portalFocusActive: boolean;
  mqttFocusActive: boolean;
  selectedSemanticLanes: Set<string>;
  mqttMachineIds: Set<string>;
}

const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  enabledNodeTypes:      new Set(ALL_FILTER_NODE_TYPES),
  portalFocusActive:     false,
  mqttFocusActive:       false,
  selectedSemanticLanes: new Set(),
  mqttMachineIds:        new Set(),
};

interface VisualizerState {
  currentView: 'selection' | 'interconnection' | 'perceptual-engine';

  settings: VisualizerSettings;
  updateSettings: (patch: Partial<VisualizerSettings>) => void;

  machines: Machine[];
  currentMachineId: string | null;
  currentMachine: Machine | null;

  ws: WebSocket | null;

  hoveredDomainId: DomainId | null;
  graphZoomState: { k: number; x: number; y: number } | null;
  selectedDomains: DomainId[];

  graphFilters: GraphFilterState;

  setCurrentView: (view: 'selection' | 'interconnection' | 'perceptual-engine') => void;
  setMachines: (machines: Machine[]) => void;
  loadMachine: (machineId: string) => Promise<void>;

  connectWebSocket: () => void;
  disconnectWebSocket: () => void;

  setHoveredDomainId: (id: DomainId | null) => void;
  setGraphZoomState: (state: { k: number; x: number; y: number } | null) => void;
  toggleDomain: (id: DomainId) => void;
  setAllDomains: (selected: boolean) => void;

  toggleNodeType: (type: FilterNodeType) => void;
  setPortalFocus: (active: boolean) => void;
  setMqttFocus: (active: boolean) => void;
  toggleSemanticLane: (key: string) => void;
  setMqttMachineIds: (ids: Set<string>) => void;
  resetGraphFilters: () => void;
}

export const useVisualizerStore = create<VisualizerState>((set, get) => ({
  currentView: 'selection',
  machines: [],
  currentMachineId: null,
  currentMachine: null,
  ws: null,
  hoveredDomainId: null,
  graphZoomState: null,
  selectedDomains: [...DOMAIN_ORDER],
  graphFilters: { ...DEFAULT_GRAPH_FILTERS },
  settings: { ...DEFAULT_SETTINGS },

  updateSettings: (patch) => set(state => ({
    settings: { ...state.settings, ...patch },
  })),

  setCurrentView: (view) => set({ currentView: view }),
  setMachines: (machines) => set({ machines }),

  loadMachine: async (machineId: string) => {
    try {
      const machine = await api.getMachine(machineId);
      set({ currentMachine: machine, currentMachineId: machineId });
    } catch (error) {
      console.error('Error loading machine:', error);
    }
  },

  connectWebSocket: () => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onerror = (error) => { console.error('WebSocket error:', error); };
    ws.onmessage = (_event) => { /* step updates handled by MachineGraphView directly */ };

    (window as any).realityEngineWS = ws;
    set({ ws });
  },

  disconnectWebSocket: () => {
    const { ws } = get();
    if (ws) {
      ws.close();
      (window as any).realityEngineWS = null;
      set({ ws: null });
    }
  },

  setHoveredDomainId: (id) => set({ hoveredDomainId: id }),
  setGraphZoomState: (state) => set({ graphZoomState: state }),

  toggleDomain: (id) => set(state => {
    const cur = state.selectedDomains;
    return {
      selectedDomains: cur.includes(id) ? cur.filter(d => d !== id) : [...cur, id],
    };
  }),
  setAllDomains: (selected) => set({ selectedDomains: selected ? [...DOMAIN_ORDER] : [] }),

  toggleNodeType: (type) => set(state => {
    const cur = new Set(state.graphFilters.enabledNodeTypes);
    if (cur.has(type)) cur.delete(type); else cur.add(type);
    return { graphFilters: { ...state.graphFilters, enabledNodeTypes: cur } };
  }),

  setPortalFocus: (active) => set(state => ({
    graphFilters: { ...state.graphFilters, portalFocusActive: active },
  })),

  setMqttFocus: (active) => set(state => ({
    graphFilters: { ...state.graphFilters, mqttFocusActive: active },
  })),

  toggleSemanticLane: (key) => set(state => {
    const cur = new Set(state.graphFilters.selectedSemanticLanes);
    if (cur.has(key)) cur.delete(key); else cur.add(key);
    return { graphFilters: { ...state.graphFilters, selectedSemanticLanes: cur } };
  }),

  setMqttMachineIds: (ids) => set(state => ({
    graphFilters: { ...state.graphFilters, mqttMachineIds: ids },
  })),

  resetGraphFilters: () => set({ graphFilters: { ...DEFAULT_GRAPH_FILTERS } }),
}));
