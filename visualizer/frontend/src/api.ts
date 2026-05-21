import axios from 'axios';
import {
  SequenceGraph,
  Machine,
  MachineCreateRequest,
  MachineUpdateRequest,
  MqttBridgeStatus,
  MqttMappingsResponse,
  PagingDecisionsResponse,
} from './types';

const API_BASE_URL = '/api/viz';
const PE_BASE_URL  = '/api/perception';

// Shared axios instance — enforces a 10 s request timeout across all API calls.
const http = axios.create({ timeout: 10_000 });

// Perception Engine API — controls the flow of inputs pushed into the Reality Engine
export const perceptionEngineApi = {
  async getState(): Promise<any> {
    const response = await http.get(`${PE_BASE_URL}/state`);
    return response.data;
  },

  async push(): Promise<{ success: boolean; step?: any; globalStep: number; timestamp: number; error?: string }> {
    const response = await http.post(`${PE_BASE_URL}/push`);
    return response.data;
  },

  async autoStart(intervalMs: number): Promise<{ success: boolean; intervalMs: number }> {
    const response = await http.post(`${PE_BASE_URL}/auto/start`, { intervalMs });
    return response.data;
  },

  async autoStop(): Promise<{ success: boolean }> {
    const response = await http.post(`${PE_BASE_URL}/auto/stop`);
    return response.data;
  },

  async reset(): Promise<{ success: boolean }> {
    const response = await http.post(`${PE_BASE_URL}/reset`);
    return response.data;
  },

  // Source management
  async getSources(): Promise<any[]> {
    const response = await http.get(`${PE_BASE_URL}/sources`);
    return response.data.sources ?? [];
  },

  async addSource(config: object): Promise<any> {
    const response = await http.post(`${PE_BASE_URL}/sources`, config);
    return response.data.source;
  },

  async updateSource(id: string, patch: object): Promise<any> {
    const response = await http.patch(`${PE_BASE_URL}/sources/${id}`, patch);
    return response.data.source;
  },

  async deleteSource(id: string): Promise<void> {
    await http.delete(`${PE_BASE_URL}/sources/${id}`);
  },

  // ── MQTT bridge surface ──────────────────────────────────────────────────

  async getMqttStatus(): Promise<MqttBridgeStatus> {
    const response = await http.get(`${PE_BASE_URL}/mqtt/status`);
    return response.data;
  },

  async getMqttMappings(): Promise<MqttMappingsResponse> {
    const response = await http.get(`${PE_BASE_URL}/mqtt/mappings`);
    return response.data;
  },

  /** Replace the in-memory MQTT mapping registry on the PE and restart
   *  the bridge with the new rules.  Body shape: `{ defaults?, mappings }`.
   *  Returns warnings (e.g. overlapping regions) on success; throws with
   *  an error body on schema / validation / broker failure. */
  async putMqttMappings(body: object): Promise<{ success: boolean; enabled: boolean; mappings: number; warnings: string[] }> {
    const response = await http.put(`${PE_BASE_URL}/mqtt/mappings`, body);
    return response.data;
  },
};

export const api = {
  // Get all sequences with graph data
  async getSequences(): Promise<SequenceGraph[]> {
    const response = await http.get(`${API_BASE_URL}/sequences`);
    return response.data.sequences;
  },

  // Get specific sequence graph
  async getSequence(id: string): Promise<SequenceGraph> {
    const response = await http.get(`${API_BASE_URL}/sequences/${id}`);
    return response.data;
  },

  // ===== Machine Methods =====

  // Get all machines
  async getMachines(): Promise<Machine[]> {
    const response = await http.get('/api/machines');
    return response.data.machines;
  },

  // Get all machines with full sequence graphs in one call.
  // Replaces the N+(N×M) waterfall: getMachines → getMachine × N → getSequence × N×M.
  async getMachinesExpanded(): Promise<any[]> {
    const response = await http.get('/api/machines?expand=sequences');
    return response.data.machines;
  },

  // Get specific machine
  async getMachine(id: string): Promise<Machine> {
    const response = await http.get(`/api/machines/${id}`);
    return response.data.machine;
  },

  // Create new machine
  async createMachine(request: MachineCreateRequest): Promise<Machine> {
    const response = await http.post('/api/machines', request);
    return response.data.machine;
  },

  // Partial update machine
  async updateMachine(id: string, request: MachineUpdateRequest): Promise<Machine> {
    const response = await http.patch(`/api/machines/${id}`, request);
    return response.data.machine;
  },

  // Delete machine
  async deleteMachine(id: string): Promise<{ success: boolean }> {
    const response = await http.delete(`/api/machines/${id}`);
    return response.data;
  },

  // ===== Machine JSON Methods =====

  // List available machine JSON files
  async listMachineJSONFiles(): Promise<{
    machines: Array<{
      filename: string;
      name: string;
      description: string;
      version: string;
      metadata: any;
      sequenceCount: number;
    }>;
  }> {
    const response = await http.get('/api/machines/json/list');
    return response.data;
  },

  // Load machine from JSON file
  async loadMachineFromJSON(name: string): Promise<{
    success: boolean;
    machine: Machine;
    message: string;
  }> {
    const response = await http.get(`/api/machines/json/${name}`);
    return response.data;
  },

  // Import machine from JSON string
  async importMachineJSON(jsonString: string): Promise<{
    success: boolean;
    machine: Machine;
    message: string;
  }> {
    const response = await http.post('/api/machines/json/import', { json: jsonString });
    return response.data;
  },

  // Export machine to JSON
  async exportMachineToJSON(id: string, pretty: boolean = true): Promise<string> {
    const response = await http.get(`/api/machines/${id}/export?pretty=${pretty}`, {
      responseType: 'text'
    });
    return response.data;
  },

  // ===== Perceptual Space Simulation Methods =====

  // Append a chunk of vectors to the server-side staging buffer.
  // Set reset:true on the first call to start a new sequence.
  async appendSequenceChunk(payload: {
    vectors: number[][];
    reset?: boolean;
    inputRegion?: { offset: number; length: number };
    stepDelayMs?: number;
    maxSteps?: number;
  }): Promise<{ success: boolean; buffered: number }> {
    const response = await http.post('/api/perceptual-simulation/configure/chunk', payload);
    return response.data;
  },

  // Commit the staged buffer into the PerceptualSpaceSimulator.
  async commitSequenceConfig(): Promise<{ success: boolean; committed: number; config: any }> {
    const response = await http.post('/api/perceptual-simulation/configure/commit');
    return response.data;
  },

  // Start perceptual simulation
  async startPerceptualSimulation(): Promise<{ success: boolean; state: any }> {
    const response = await http.post('/api/perceptual-simulation/start');
    return response.data;
  },

  // Stop perceptual simulation
  async stopPerceptualSimulation(): Promise<{ success: boolean }> {
    const response = await http.post('/api/perceptual-simulation/stop');
    return response.data;
  },

  // Step perceptual simulation
  async stepPerceptualSimulation(): Promise<{
    success: boolean;
    step: any;
    isComplete: boolean;
  }> {
    const response = await http.post('/api/perceptual-simulation/step');
    return response.data;
  },

  // Reset perceptual simulation
  async resetPerceptualSimulation(): Promise<{ success: boolean }> {
    const response = await http.post('/api/perceptual-simulation/reset');
    return response.data;
  },

  // Get perceptual simulation state
  async getPerceptualSimulationState(): Promise<{
    isRunning: boolean;
    currentStep: number;
    config: any;
    perceptualSpaceDimension: number;
  }> {
    const response = await http.get('/api/perceptual-simulation/state');
    return response.data;
  },

  // Load data center example
  async loadDataCenterExample(): Promise<{ success: boolean; metadata: any }> {
    const response = await http.get('/api/demo/data-center');
    return response.data;
  },

  // Load multi-step sequences example
  async loadMultiStepExample(): Promise<{ success: boolean; metadata: any; machine?: any }> {
    const response = await http.get('/api/demo/multi-step');
    return response.data;
  },

  // Load Kleene star example
  async loadKleeneStarExample(): Promise<{ success: boolean; metadata: any; machine?: any }> {
    const response = await http.get('/api/demo/kleene-star');
    return response.data;
  },

  // ── Live paging decisions derived from RE /api/metrics ─────────────────
  // The backend parses the Prometheus text and returns JSON so the
  // frontend can render a "what's been alerting" panel without re-deriving
  // from the machine corpus.
  async getPagingDecisions(): Promise<PagingDecisionsResponse> {
    const response = await http.get(`${API_BASE_URL}/paging-decisions`);
    return response.data;
  },

};
