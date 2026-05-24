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
};
