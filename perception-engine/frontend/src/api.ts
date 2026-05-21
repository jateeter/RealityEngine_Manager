import axios from 'axios';
import type { EngineState, SourceConfig, PushResult, MatchAlgorithm } from './types.js';

const api = axios.create({ baseURL: '/api' });

export async function getState(): Promise<EngineState> {
  const { data } = await api.get<EngineState>('/state');
  return data;
}

export async function push(): Promise<PushResult> {
  const { data } = await api.post<PushResult>('/push');
  return data;
}

export async function startAuto(intervalMs: number): Promise<void> {
  await api.post('/auto/start', { intervalMs });
}

export async function stopAuto(): Promise<void> {
  await api.post('/auto/stop');
}

export async function resetEngine(): Promise<void> {
  await api.post('/reset');
}

export async function getSources(): Promise<SourceConfig[]> {
  const { data } = await api.get<{ sources: SourceConfig[] }>('/sources');
  return data.sources;
}

export async function addSource(config: Omit<SourceConfig, 'id'>): Promise<SourceConfig> {
  const { data } = await api.post<{ source: SourceConfig }>('/sources', config);
  return data.source;
}

export async function updateSource(id: string, patch: Partial<SourceConfig>): Promise<SourceConfig> {
  const { data } = await api.patch<{ source: SourceConfig }>(`/sources/${id}`, patch);
  return data.source;
}

export async function deleteSource(id: string): Promise<void> {
  await api.delete(`/sources/${id}`);
}

/**
 * Subset of the Reality Engine machine record the PE frontend needs.  We
 * deliberately only declare the fields used by the domain-filter UI; the
 * RE endpoint returns more but those extras are ignored.
 */
export interface MachineSummary {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  perceptualMapping?: { input?: { offset: number; length: number } };
  // Lifted up so the bootstrap menu can count test sequences per machine
  // without re-fetching the full inputSequences vectors payload.
  inputSequenceCount?: number;
}

export async function getMachines(): Promise<MachineSummary[]> {
  const { data } = await api.get<{ machines: Array<MachineSummary & { metadata?: { inputSequences?: unknown[] } }> }>('/machines');
  const list = data.machines ?? [];
  return list.map(m => ({
    ...m,
    inputSequenceCount: Array.isArray(m.metadata?.inputSequences) ? m.metadata!.inputSequences!.length : 0,
  }));
}

export async function setMatchAlgorithm(algo: MatchAlgorithm): Promise<void> {
  await api.patch('/config', { matchAlgorithm: algo });
}

export interface BootstrapResult {
  created: number;
  skipped: number;
  machinesSeen: number;
  errors: string[];
  // Typed breakdown — present on responses from the updated backend; older
  // backends omit it.  Treat as optional and fall back to the legacy single
  // `skipped` total in the UI when missing.
  reasons?: {
    alreadyExisted: number;
    outOfRange:     number;
    noSequences:    number;
    outsideFilter:  number;
  };
  // The PE's configured vector size — surfaced so the UI can hint at the
  // VECTOR_SIZE env var when outOfRange dominates.
  vectorSize?: number;
}

export async function bootstrapFromMachines(
  opts?: { machineIds?: string[] },
): Promise<BootstrapResult> {
  // No body => global "import every machine" path.  An empty array DOES
  // post a body so the backend filters to zero, which the caller can use
  // to validate the response shape; the SourcesPanel UI never sends one.
  const body = opts?.machineIds !== undefined ? { machineIds: opts.machineIds } : {};
  const { data } = await api.post<BootstrapResult>('/sources/bootstrap-from-machines', body);
  return data;
}
