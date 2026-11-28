// The K-line panel's client: the Visualizer backend's /api/kline-panel routes
// (RealityEngine_Manager#372). The backend reaches each engine; this never does.
import axios from 'axios';

const http = axios.create({ timeout: 120_000, validateStatus: s => s < 500 });

export type Counts = Record<string, number>;
export interface ReHalf { supported: boolean; capture?: boolean; feedbackHops?: number; storeMaxBytes?: number; open?: number; commit?: number;
  stats?: { segments: number; bytes: number; budget: number; warnings: string[] }; error?: string }
export interface PeHalf { supported: boolean; capture?: boolean; storeMaxBytes?: number; taxonomy?: string | null;
  stats?: { segments: number; bytes: number; budget: number; warnings: string[]; records: number }; error?: string }
export interface InstanceStatus { id: string; runtime: string; role: 'voter' | 'follower'; re: ReHalf; pe: PeHalf }
export interface PanelState { instances: InstanceStatus[]; bootCapture: boolean | null; archive: string;
  knobs: { re: Record<string, { min: number; max: number; default: number }>; pe: Record<string, { min: number; max: number; default: number }> } }
export interface KlineAnalysis { klines: number; commits: [number, number] | null; byOutcome: Counts; byMachine: Record<string, Counts>;
  bySequence: Record<string, Counts>; closedPerStep: Counts; pathLengths: Counts; nearMiss: Counts; nearMissNoThreshold: number }
export interface CompositionAnalysis { records: number; commits: [number, number] | null; taxonomy: string[]; cellsByEntry: Counts; recordsByEntry: Counts; causedByRecords: number }
export interface AnalysisReply { source: 'store' | 'archive'; from: number; to: number; errors: string[];
  perInstance: Record<string, { klines: KlineAnalysis; compositions: CompositionAnalysis | null }>;
  sideBySide: { agree: string[]; differ: string[]; missing: string[] } }
export interface CatalogEntry { kind: 'klines' | 'isre'; instanceId: string; runtime: string; participant: string; file: string;
  bytes: number; records: number; firstCommit: number; lastCommit: number; archivedAt: string }
export interface Schedule { id: string; kind: 'capture' | 'rerun'; label?: string; targets: 'all' | string[]; status: string;
  startAt?: number; startCommit?: number; durationMs?: number; steps?: number; repeatEveryMs?: number; archiveAtEnd?: boolean;
  windows?: { startedAt: number; endedAt?: number; commits: Record<string, { start?: number; end?: number }>; errors: string[] }[];
  source?: 'store' | 'archive'; window?: { captureId: string } | { lastCommits: number }; everyMs?: number; nextRunAt?: number;
  results?: { at: number; windows: Record<string, { start?: number; end?: number }>; perInstance: Record<string, any>;
    sideBySide?: { agree: string[]; differ: string[]; missing: string[] }; errors: string[] }[] }

const body = <T>(r: { status: number; data: any }): T => {
  if (r.status >= 400) throw new Error(r.data?.error ?? `HTTP ${r.status}`);
  return r.data as T;
};

export const klineApi = {
  state: async () => body<PanelState>(await http.get('/api/kline-panel')),
  capture: async (on: boolean, instances?: string[]) =>
    body<{ results: { id: string; ok: boolean; errors: string[] }[] }>(await http.post('/api/kline-panel/capture', { on, instances })),
  setKnob: async (id: string, knob: string, value: number) =>
    body<{ ok: boolean; errors: string[] }>(await http.put(`/api/kline-panel/knobs/${encodeURIComponent(id)}/${knob}`, { value })),
  resetKnob: async (id: string, knob: string) =>
    body<{ ok: boolean; errors: string[] }>(await http.delete(`/api/kline-panel/knobs/${encodeURIComponent(id)}/${knob}`)),
  analysis: async (source: 'store' | 'archive', from?: number, to?: number) =>
    body<AnalysisReply>(await http.get('/api/kline-panel/analysis', { params: { source, from, to } })),
  archive: async (instances?: string[]) =>
    body<{ root: string; results: { instance: string; kind: string; result: string; records?: number }[] }>(
      await http.post('/api/kline-panel/archive', { instances })),
  catalog: async () => body<{ root: string; catalog: CatalogEntry[] }>(await http.get('/api/kline-panel/archive')),
  schedules: async () => body<{ schedules: Schedule[] }>(await http.get('/api/kline-panel/schedules')),
  addSchedule: async (s: Record<string, unknown>) => body<Schedule>(await http.post('/api/kline-panel/schedules', s)),
  removeSchedule: async (id: string) => body<{ removed: string }>(await http.delete(`/api/kline-panel/schedules/${id}`)),
  runSchedule: async (id: string) => body<unknown>(await http.post(`/api/kline-panel/schedules/${id}/run`)),
};
