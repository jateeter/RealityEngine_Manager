import { create } from 'zustand';
import {
  SequenceGraph,
  Machine,
  OutputVector,
  MachineCreateRequest,
  MachineUpdateRequest,
  PESource,
  PETestSource,
} from './types';
import { api, perceptionEngineApi } from './api';
import type { DomainId } from './components/machineDomains';
import { DOMAIN_ORDER } from './components/machineDomains';

/** One accepted MQTT PUBLISH forwarded by the PE through the visualizer
 *  backend.  Used to drive the live-ingest stream in the universe monitor. */
export interface MqttIngestEvent {
  sensorId: string;
  mappingId: string;
  topic: string;
  offset: number;
  length: number;
  values: number[];
  ttlMs: number;
  timestamp: number;
}

/** Ring-buffer cap on recent MQTT ingests held in the store.  Tuned for the
 *  universe monitor's live-feed panel — large enough to feel live, small
 *  enough that re-renders stay cheap. */
const MQTT_INGEST_CAP = 120;

interface VisualizerState {
  // View state
  currentView: 'selection' | 'administration' | 'interconnection' | 'tobias';

  // Machine management
  machines: Machine[];
  currentMachineId: string | null;
  lastViewedMachineId: string | null;

  sequences: SequenceGraph[];
  currentMachine: Machine | null;

  // WebSocket
  ws: WebSocket | null;

  // Output stream state (used by MachineContainerView / CriticalEventGraphView)
  currentOutputVectors: OutputVector[];
  highlightedOutputId: string | null;

  // Currently selected CES (sequence) — set by the hierarchical Machines tree
  // when a user picks a specific Critical Event Sequence under a machine. The
  // Machine view scopes its CES graph to this sequence; cleared on machine
  // change or back-navigation.
  selectedSequenceId: string | null;
  setSelectedSequenceId: (id: string | null) => void;

  // MQTT live-ingest stream — ring buffer of the most recent N accepted
  // PUBLISH messages.  Pushed by the visualizer backend when it sees
  // `mqtt-ingest` events forwarded from the Perception Engine's WS.
  recentMqttIngests: MqttIngestEvent[];

  // PE source state — test sources created from machine inputSequences
  peSources: PESource[];

  // View actions
  setCurrentView: (view: 'selection' | 'administration' | 'interconnection' | 'tobias') => void;

  // Machine management actions
  setMachines: (machines: Machine[]) => void;
  loadMachine: (machineId: string) => Promise<void>;
  createMachine: (request: MachineCreateRequest) => Promise<Machine>;
  updateMachine: (machineId: string, request: MachineUpdateRequest) => Promise<void>;
  deleteMachine: (machineId: string) => Promise<void>;

  // PE source actions
  togglePeSource: (sourceId: string, active: boolean) => Promise<void>;
  setAllPeSourcesActive: (active: boolean) => Promise<void>;
  refreshPeSources: () => Promise<void>;

  // Machine JSON actions
  listMachineJSONFiles: () => Promise<any[]>;
  loadMachineFromJSON: (name: string) => Promise<void>;
  importMachineJSON: (jsonString: string) => Promise<void>;
  exportMachineToJSON: (machineId: string, pretty?: boolean) => Promise<string>;

  // Demo loaders
  loadDataCenterExample: () => Promise<void>;
  loadMultiStepExample: () => Promise<void>;
  loadKleeneStarExample: () => Promise<void>;

  // WebSocket lifecycle
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;

  // Output stream actions
  setCurrentOutputVectors: (outputs: OutputVector[]) => void;
  setHighlightedOutputId: (outputId: string | null) => void;

  // Domain hover (set by MachineGraphView hull hover, read by TobiasView header)
  hoveredDomainId: DomainId | null;
  setHoveredDomainId: (id: DomainId | null) => void;

  // Persisted zoom transform — survives view switches so the settled layout
  // is the starting point for every context that mounts MachineGraphView.
  graphZoomState: { k: number; x: number; y: number } | null;
  setGraphZoomState: (state: { k: number; x: number; y: number } | null) => void;

  // Domain visibility filter — shared across all graph view contexts.
  // All domains selected by default; multi-select; empty = all hidden.
  selectedDomains: DomainId[];
  toggleDomain:   (id: DomainId) => void;
  setAllDomains:  (selected: boolean) => void;
}

export const useVisualizerStore = create<VisualizerState>((set, get) => ({
  // Initialization
  currentView: 'selection',
  machines: [],
  currentMachineId: null,
  lastViewedMachineId: localStorage.getItem('lastViewedMachineId'),
  sequences: [],
  currentMachine: null,
  ws: null,
  currentOutputVectors: [],
  highlightedOutputId: null,
  recentMqttIngests: [],
  peSources: [],
  selectedSequenceId: null,
  setSelectedSequenceId: (id) => set({ selectedSequenceId: id }),
  hoveredDomainId: null,
  graphZoomState: null,
  selectedDomains: [...DOMAIN_ORDER],

  // View actions
  setCurrentView: (view) => set({ currentView: view }),

  // Machine management
  setMachines: (machines) => set({ machines }),

  loadMachine: async (machineId: string) => {
    try {
      const machine = await api.getMachine(machineId);
      const prevMachineId = get().currentMachineId;
      set({
        currentMachine: machine,
        currentMachineId: machineId,
        lastViewedMachineId: machineId,
        currentView: 'administration',
        currentOutputVectors: [],
        // Drop any prior CES scope when switching machines.
        selectedSequenceId: prevMachineId === machineId ? get().selectedSequenceId : null,
      });

      localStorage.setItem('lastViewedMachineId', machineId);

      const sequences = await api.getSequences();
      set({ sequences });

      if (machine.isExample) {
        try {
          if (machineId === 'multi-step-example') {
            await get().loadMultiStepExample();
          } else if (machineId === 'data-center-example') {
            await get().loadDataCenterExample();
          } else if (machineId === 'kleene-star-example') {
            await get().loadKleeneStarExample();
          }
        } catch (error) {
          console.error('Could not load example data for machine:', error);
        }
      }

      // Create PE TestSources from the machine's inputSequences.  The PE
      // auto-grows its persistent vector to fit any source it receives, so
      // we no longer gate this on PERCEPTUAL_DIM — every machine with a
      // mapping and inputSequences gets sources created.
      const mapping = machine.perceptualMapping?.input;
      if (mapping && machine.metadata?.inputSequences?.length) {
        try {
          const region = mapping!;
          const inputSeqs: Array<{ name: string; vectors: number[][] }> =
            machine.metadata.inputSequences;

          // Remove any existing TestSources for this machine, then recreate
          const existing: PESource[] = await perceptionEngineApi.getSources();
          await Promise.all(
            existing
              .filter((s): s is PETestSource => s.type === 'test' && s.machineId === machineId)
              .map(s => perceptionEngineApi.deleteSource(s.id).catch(() => {}))
          );

          await Promise.all(
            inputSeqs.map(seq =>
              perceptionEngineApi.addSource({
                type:         'test',
                name:         seq.name,
                region,
                active:       true,
                machineId,
                machineName:  machine.name,
                sequenceName: seq.name,
                inputs:       seq.vectors,
                loop:         true,
              })
            )
          );

          // Refresh full source list so other types survive
          const allSources: PESource[] = await perceptionEngineApi.getSources();
          set({ peSources: allSources });
        } catch (err) {
          console.error('Could not create PE sources for machine:', err);
          // Non-fatal: PE may not be running
        }
      } else {
        // Still refresh sources so panel reflects current state
        perceptionEngineApi.getSources()
          .then(sources => set({ peSources: sources }))
          .catch(() => {});
      }
    } catch (error) {
      console.error('Error loading machine:', error);
      throw error;
    }
  },

  createMachine: async (request: MachineCreateRequest) => {
    try {
      const machine = await api.createMachine(request);
      set({ machines: [...get().machines, machine] });
      return machine;
    } catch (error) {
      console.error('Error creating machine:', error);
      throw error;
    }
  },

  updateMachine: async (machineId: string, request: MachineUpdateRequest) => {
    try {
      await api.updateMachine(machineId, request);
      const updated = get().machines.map(m =>
        m.id === machineId ? { ...m, ...request, updatedAt: Date.now() } : m
      );
      set({ machines: updated });

      if (get().currentMachineId === machineId) {
        const machine = await api.getMachine(machineId);
        set({ currentMachine: machine });
      }
    } catch (error) {
      console.error('Error updating machine:', error);
      throw error;
    }
  },

  deleteMachine: async (machineId: string) => {
    try {
      await api.deleteMachine(machineId);
      set({ machines: get().machines.filter(m => m.id !== machineId) });

      if (get().currentMachineId === machineId) {
        set({ currentMachine: null, currentMachineId: null, currentView: 'selection' });
        localStorage.removeItem('lastViewedMachineId');
      }
    } catch (error) {
      console.error('Error deleting machine:', error);
      throw error;
    }
  },

  // PE source actions
  togglePeSource: async (sourceId: string, active: boolean) => {
    try {
      await perceptionEngineApi.updateSource(sourceId, { active });
      set(state => ({
        peSources: state.peSources.map(s => s.id === sourceId ? { ...s, active } : s),
      }));
    } catch (err) {
      console.error('Failed to toggle PE source:', err);
    }
  },

  setAllPeSourcesActive: async (active: boolean) => {
    const { peSources } = get();
    const testSources = peSources.filter((s): s is PETestSource => s.type === 'test');
    try {
      await Promise.all(testSources.map(s => perceptionEngineApi.updateSource(s.id, { active })));
      set(state => ({
        peSources: state.peSources.map(s =>
          s.type === 'test' ? { ...s, active } : s
        ),
      }));
    } catch (err) {
      console.error('Failed to set all PE sources:', err);
    }
  },

  refreshPeSources: async () => {
    try {
      const sources: PESource[] = await perceptionEngineApi.getSources();
      set({ peSources: sources });
    } catch {
      // PE not reachable — leave state as-is
    }
  },

  // Machine JSON actions
  listMachineJSONFiles: async () => {
    try {
      const response = await api.listMachineJSONFiles();
      return response.machines;
    } catch (error) {
      console.error('Error listing machine JSON files:', error);
      throw error;
    }
  },

  loadMachineFromJSON: async (name: string) => {
    try {
      const response = await api.loadMachineFromJSON(name);
      const machine = response.machine;

      const machines = get().machines;
      const existingIndex = machines.findIndex(m => m.id === machine.id);
      if (existingIndex >= 0) {
        machines[existingIndex] = machine;
        set({ machines: [...machines] });
      } else {
        set({ machines: [...machines, machine] });
      }

      await get().loadMachine(machine.id);
    } catch (error) {
      console.error('Error loading machine from JSON:', error);
      throw error;
    }
  },

  importMachineJSON: async (jsonString: string) => {
    try {
      const response = await api.importMachineJSON(jsonString);
      const machine = response.machine;
      set({ machines: [...get().machines, machine] });
      await get().loadMachine(machine.id);
    } catch (error) {
      console.error('Error importing machine JSON:', error);
      throw error;
    }
  },

  exportMachineToJSON: async (machineId: string, pretty: boolean = true) => {
    try {
      return await api.exportMachineToJSON(machineId, pretty);
    } catch (error) {
      console.error('Error exporting machine to JSON:', error);
      throw error;
    }
  },

  // Demo loaders
  loadDataCenterExample: async () => {
    try {
      await api.loadDataCenterExample();
      const sequences = await api.getSequences();
      set({ sequences });
    } catch (error) {
      console.error('Error loading data center example:', error);
    }
  },

  loadMultiStepExample: async () => {
    try {
      const result = await api.loadMultiStepExample();
      set({ currentMachine: result.machine || null });
      const sequences = await api.getSequences();
      set({ sequences });
    } catch (error) {
      console.error('Error loading multi-step sequences example:', error);
    }
  },

  loadKleeneStarExample: async () => {
    try {
      const result = await api.loadKleeneStarExample();
      set({ currentMachine: result.machine || null });
      const sequences = await api.getSequences();
      set({ sequences });
    } catch (error) {
      console.error('Error loading Kleene star example:', error);
    }
  },

  // WebSocket — used by MachineAdministrationView and MachineInterconnectionView
  connectWebSocket: () => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.hostname}:3001/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        // Schema guard: reject malformed messages before touching state.
        if (typeof message !== 'object' || message === null || typeof message.type !== 'string') return;

        switch (message.type) {
          case 'perceptual-simulation-stepped': {
            const step = (message as any).step;
            // Validate required step fields before applying to state.
            if (
              typeof step !== 'object' || step === null ||
              typeof step.stepNumber !== 'number' ||
              typeof step.machineResults !== 'object' || step.machineResults === null
            ) break;

            // Apply node activation state directly from the step payload.
            // This eliminates the GET /api/viz/sequences round-trip that previously
            // happened on every simulated step.

            type SeqDelta = {
              matched: Set<string>;
              activated: Set<string>;
              outputs: OutputVector[];
            };
            const deltas = new Map<string, SeqDelta>();
            const newOutputs: OutputVector[] = [];

            for (const mr of Object.values(step.machineResults as Record<string, any>)) {
              const seqResults: Record<string, any> = (mr as any).transitionResult?.sequenceResults ?? {};
              for (const [seqId, sr] of Object.entries(seqResults)) {
                const outputs: OutputVector[] = (sr as any).assertedOutputs ?? [];
                deltas.set(seqId, {
                  matched:   new Set<string>((sr as any).matchedVectors   ?? []),
                  activated: new Set<string>((sr as any).activatedVectors ?? []),
                  outputs,
                });
                newOutputs.push(...outputs);
              }
            }

            // Skip the sequences map entirely if no sequences changed this step.
            if (deltas.size === 0) {
              if (newOutputs.length > 0) set({ currentOutputVectors: newOutputs });
              break;
            }

            let changed = false;
            const updatedSeqs = get().sequences.map(seq => {
              const d = deltas.get(seq.sequenceId);
              if (!d) return seq; // same reference — no re-render for this sequence
              changed = true;
              const updatedNodes = seq.nodes.map(node => {
                const wasJustMatched = d.matched.has(node.id) && node.hasOutput;
                // Transitional vectors (matched, not initial, no output) are deactivated.
                const isDeactivated  = d.matched.has(node.id) && !node.isInitial && !node.hasOutput;
                const isActivated    = d.activated.has(node.id);
                return {
                  ...node,
                  wasJustMatched,
                  lastOutputVector: wasJustMatched ? (d.outputs[0] ?? null) : null,
                  isActive: isDeactivated ? false : isActivated ? true : node.isActive,
                };
              });
              return {
                ...seq,
                nodes: updatedNodes,
                stats: { ...seq.stats, activeVectors: updatedNodes.filter(n => n.isActive).length },
              };
            });

            const updates: { sequences?: SequenceGraph[]; currentOutputVectors?: OutputVector[] } = {};
            if (changed) updates.sequences = updatedSeqs;
            if (newOutputs.length > 0) updates.currentOutputVectors = newOutputs;
            if (updates.sequences !== undefined || updates.currentOutputVectors !== undefined) set(updates);
            break;
          }

          case 'perceptual-simulation-reset':
            set({ currentOutputVectors: [] });
            break;

          case 'mqtt-ingest': {
            // Per-message MQTT ingest forwarded by VB from the PE WS.
            // Append to the ring buffer and drop the oldest if we're over cap.
            const payload = (message as any).payload;
            if (
              payload && typeof payload.sensorId === 'string' &&
              typeof payload.mappingId === 'string' &&
              Array.isArray(payload.values)
            ) {
              const event: MqttIngestEvent = {
                sensorId:  payload.sensorId,
                mappingId: payload.mappingId,
                topic:     typeof payload.topic === 'string' ? payload.topic : '',
                offset:    Number(payload.offset) || 0,
                length:    Number(payload.length) || payload.values.length,
                values:    payload.values.map((v: unknown) => Number(v) || 0),
                ttlMs:     Number(payload.ttlMs) || 0,
                timestamp: Number(payload.timestamp) || Date.now(),
              };
              const next = [event, ...get().recentMqttIngests];
              if (next.length > MQTT_INGEST_CAP) next.length = MQTT_INGEST_CAP;
              set({ recentMqttIngests: next });
            }
            break;
          }
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

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

  // Output stream actions
  setCurrentOutputVectors: (outputs: OutputVector[]) => set({ currentOutputVectors: outputs }),
  setHighlightedOutputId: (outputId: string | null) => set({ highlightedOutputId: outputId }),

  setHoveredDomainId: (id: DomainId | null) => set({ hoveredDomainId: id }),
  setGraphZoomState: (state) => set({ graphZoomState: state }),

  toggleDomain: (id) => set(state => {
    const cur = state.selectedDomains;
    return {
      selectedDomains: cur.includes(id) ? cur.filter(d => d !== id) : [...cur, id],
    };
  }),
  setAllDomains: (selected) => set({ selectedDomains: selected ? [...DOMAIN_ORDER] : [] }),
}));
