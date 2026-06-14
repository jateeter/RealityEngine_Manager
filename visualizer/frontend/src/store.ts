import { create } from 'zustand';
import { Machine } from './types';
import { api } from './api';
import type { DomainId } from './components/machineDomains';
import { DOMAIN_ORDER } from './components/machineDomains';

interface VisualizerState {
  currentView: 'selection' | 'interconnection' | 'perceptual-engine';

  machines: Machine[];
  currentMachineId: string | null;
  currentMachine: Machine | null;

  ws: WebSocket | null;

  hoveredDomainId: DomainId | null;
  graphZoomState: { k: number; x: number; y: number } | null;
  selectedDomains: DomainId[];

  setCurrentView: (view: 'selection' | 'interconnection' | 'perceptual-engine') => void;
  setMachines: (machines: Machine[]) => void;
  loadMachine: (machineId: string) => Promise<void>;

  connectWebSocket: () => void;
  disconnectWebSocket: () => void;

  setHoveredDomainId: (id: DomainId | null) => void;
  setGraphZoomState: (state: { k: number; x: number; y: number } | null) => void;
  toggleDomain: (id: DomainId) => void;
  setAllDomains: (selected: boolean) => void;
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
}));
