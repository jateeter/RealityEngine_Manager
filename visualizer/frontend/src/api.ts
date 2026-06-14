import axios from 'axios';
import {
  Machine,
  EngineStats,
  SimulationState,
  PESource,
  HealthStatus,
  EngineActive,
  PEState,
  PEIntegrationsStatus,
  EngineRegistry,
  PEFullState,
  PEPushResult,
  PEMatchAlgorithm,
  PEBootstrapResult,
} from './types';

const http = axios.create({ timeout: 10_000 });

export const api = {
  // ── Machines (RE) ─────────────────────────────────────────────────────────
  async getMachines(): Promise<Machine[]> {
    const response = await http.get('/api/machines');
    return response.data.machines;
  },

  async getMachine(id: string): Promise<Machine> {
    const response = await http.get(`/api/machines/${id}`);
    return response.data.machine;
  },

  // ── RE health & status ────────────────────────────────────────────────────
  async getREHealth(): Promise<HealthStatus> {
    const response = await http.get('/api/health');
    return response.data;
  },

  async getEngineStats(): Promise<EngineStats> {
    const response = await http.get('/api/engine/stats');
    return response.data;
  },

  async getEngineActive(): Promise<EngineActive> {
    const response = await http.get('/api/engine/active');
    return response.data;
  },

  async getSimulationState(): Promise<SimulationState> {
    const response = await http.get('/api/perceptual-simulation/state');
    return response.data;
  },

  async getRuntimeMetrics(): Promise<Record<string, any>> {
    const response = await http.get('/api/runtime/metrics');
    return response.data;
  },

  // ── PE health & status ────────────────────────────────────────────────────
  async getPEHealth(): Promise<HealthStatus> {
    const response = await http.get('/api/pe/health');
    return response.data;
  },

  async getPEState(): Promise<PEState> {
    const response = await http.get('/api/pe/state');
    return response.data;
  },

  async getPESources(): Promise<PESource[]> {
    const response = await http.get('/api/pe/sources');
    return response.data.sources ?? response.data;
  },

  async getPEIntegrationsStatus(): Promise<PEIntegrationsStatus> {
    const response = await http.get('/api/pe/integrations/status');
    return response.data;
  },

  // ── Multi-engine registry ─────────────────────────────────────────────────
  async getEngines(): Promise<EngineRegistry> {
    const response = await http.get('/api/engines');
    return response.data;
  },

  async setActiveEngine(id: string): Promise<{ activeId: string; re_url: string; pe_url: string }> {
    const response = await http.post('/api/engines/active', { id });
    return response.data;
  },

  // ── PE management (full state + mutations) ────────────────────────────────
  async getPEFullState(): Promise<PEFullState> {
    const response = await http.get('/api/pe/state');
    return response.data;
  },

  async pePush(): Promise<PEPushResult> {
    const response = await http.post('/api/pe/push');
    return response.data;
  },

  async peStartAuto(intervalMs: number): Promise<void> {
    await http.post('/api/pe/auto/start', { intervalMs });
  },

  async peStopAuto(): Promise<void> {
    await http.post('/api/pe/auto/stop');
  },

  async peReset(): Promise<void> {
    await http.post('/api/pe/reset');
  },

  async peSetMatchAlgorithm(algo: PEMatchAlgorithm): Promise<void> {
    await http.patch('/api/pe/config', { matchAlgorithm: algo });
  },

  async peAddSource(config: Omit<PESource, 'id'>): Promise<PESource> {
    const response = await http.post('/api/pe/sources', config);
    return response.data.source ?? response.data;
  },

  async peUpdateSource(id: string, patch: Partial<PESource>): Promise<PESource> {
    const response = await http.patch(`/api/pe/sources/${id}`, patch);
    return response.data.source ?? response.data;
  },

  async peDeleteSource(id: string): Promise<void> {
    await http.delete(`/api/pe/sources/${id}`);
  },

  async peBootstrapFromMachines(opts?: { machineIds?: string[] }): Promise<PEBootstrapResult> {
    const body = opts?.machineIds !== undefined ? { machineIds: opts.machineIds } : {};
    const response = await http.post('/api/pe/sources/bootstrap-from-machines', body);
    return response.data;
  },

  // ── MQTT bridge ────────────────────────────────────────────────────────────
  async getMqttStatus(): Promise<import('./types').MqttBridgeStatus> {
    const r = await http.get('/api/pe/mqtt/status');
    return r.data;
  },

  async getMqttMappings(): Promise<import('./types').MqttMappingsResponse> {
    const r = await http.get('/api/pe/mqtt/mappings');
    return r.data;
  },

  async getMqttExample(): Promise<object> {
    const r = await http.get('/api/pe/mqtt/example');
    return r.data;
  },

  async mqttEnable(brokerUrl: string, mappings: object): Promise<{ mappings?: number; warnings?: string[] }> {
    const r = await http.post('/api/pe/mqtt/enable', { brokerUrl, mappings });
    return r.data;
  },

  async mqttDisable(): Promise<void> {
    await http.post('/api/pe/mqtt/disable');
  },

  async mqttUpdateMappings(mappings: object): Promise<{ mappings?: number; warnings?: string[] }> {
    const r = await http.put('/api/pe/mqtt/mappings', mappings);
    return r.data;
  },
};
