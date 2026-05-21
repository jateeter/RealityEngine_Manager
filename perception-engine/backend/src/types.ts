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
  // Concatenated step vectors across one or more named sequences.  The
  // runtime advances through `inputs` sequentially; `segments` (when
  // present) describes the sub-sequence boundaries so the UI can label
  // progress as "TC-02 step 3 of 5" instead of a flat step index.
  segments?: TestSegment[];
  inputs: number[][];
  loop: boolean;
}

export interface TestSegment {
  name: string;
  length: number;
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

export interface AutoConfig {
  running: boolean;
  intervalMs: number;
}

export type MatchAlgorithm = 'gte' | 'equals';

export interface EngineState {
  sources: SourceConfig[];
  assembledVector: number[];
  globalStep: number;
  auto: AutoConfig;
  lastPush: number | null;
  matchAlgorithm: MatchAlgorithm;
  vectorSize: number;
}

export interface PushResult {
  success: boolean;
  step?: any;
  timestamp: number;
  globalStep: number;
  error?: string;
}

export interface TestProgress {
  current: number;
  total: number;
}
