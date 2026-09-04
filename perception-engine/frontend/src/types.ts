export type SourceType = 'test' | 'simulated' | 'sensor';

export type SimPattern =
  | 'sine'
  | 'sawtooth'
  | 'square'
  | 'linear-ramp'
  | 'random-walk'
  | 'constant'
  | 'gaussian-noise'
  | 'binary';

export interface Region {
  offset: number;
  length: number;
}

export interface TestSourceConfig {
  type: 'test';
  id: string;
  name: string;
  region: Region;
  active: boolean;
  machineId: string;
  machineName: string;
  sequenceName: string;
  inputs: number[][];
  loop: boolean;
}

export interface SimulatedSourceConfig {
  type: 'simulated';
  id: string;
  name: string;
  region: Region;
  active: boolean;
  pattern: SimPattern;
  frequency: number;
  amplitude: number;
  dcOffset: number;
}

export interface SensorSourceConfig {
  type: 'sensor';
  id: string;
  name: string;
  region: Region;
  active: boolean;
  sensorId: string;
  lastValue: number[];
  lastUpdated: number | null;
  ttlMs: number;
}

export type SourceConfig = TestSourceConfig | SimulatedSourceConfig | SensorSourceConfig;

export type MatchAlgorithm = 'gte' | 'equals';

export interface AutoConfig {
  running: boolean;
  intervalMs: number;
}

export interface EngineState {
  sources: SourceConfig[];
  assembledVector: number[];
  globalStep: number;
  auto: AutoConfig;
  lastPush: number | null;
  matchAlgorithm: MatchAlgorithm;
  perceptionDimension: number;
}

export interface PushResult {
  success: boolean;
  step?: Record<string, unknown>;
  timestamp: number;
  globalStep: number;
  error?: string;
}

export interface PushLogEntry extends PushResult {
  id: string;
}

// A machine input sequence as it arrives on `machine.metadata.inputSequences`.
//
// That field is corpus data passed through verbatim by every engine, so its
// spelling follows the corpus file rather than the engine: `events` since
// RealityEngine_CI#220 layer 1b, `vectors` in anything not yet rewritten. Both
// are declared so the compiler can see the question, and read through
// `sequenceEvents` so layer 1c has one place to collapse them.
export interface InputSequenceShaped {
  name: string;
  events?: number[][];
  vectors?: number[][];
}

/** The rows of an input sequence, canonical spelling first. */
export function sequenceEvents(seq: InputSequenceShaped | null | undefined): number[][] {
  if (Array.isArray(seq?.events)) return seq.events;
  if (Array.isArray(seq?.vectors)) return seq.vectors;
  return [];
}
