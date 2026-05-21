export interface VectorNode {
  id: string;
  label: string;
  isInitial: boolean;
  isActive: boolean;
  hasOutput: boolean;
  wasJustMatched?: boolean; // True when a final event was active and just matched by input
  lastOutputVector?: OutputVector | null; // The last output produced, visible until next input
  elements: VectorElement[];
  metadata: Record<string, any>;
  outputVectors: OutputVector[];
}

export interface VectorElement {
  value: number;
  comparatorType: string;
  threshold?: number;
}

export interface OutputVector {
  id: string;
  vector: number[];
  timestamp: number;
  metadata?: string | Record<string, any>;
  // Ordered chain of vector ids whose matches led to this output firing —
  // populated by the engine.  Surface in the CES tooltip so an operator
  // sees not just "RED fall" but the evidence chain that justified it.
  provenance?: string[];
}

export interface Edge {
  id: string;
  source: string;
  target: string;
}

export interface SequenceGraph {
  sequenceId: string;
  sequenceName: string;
  metadata: Record<string, any>;
  nodes: VectorNode[];
  edges: Edge[];
  stats: {
    totalVectors: number;
    activeVectors: number;
    initialVectors: number;
    outputVectors: number;
  };
}

export interface Machine {
  id: string;
  name: string;
  description: string;
  sequenceCount: number;
  totalVectors: number;
  sequenceIds: string[];
  sequences: Array<{
    id: string;
    name: string;
  }>;
  metadata: Record<string, any>;
  perceptualMapping?: {
    input: { offset: number; length: number };
    output: { offset: number; length: number };
    bitsPerElement?: number;
  };
  // Top-level life-safety / severity tag (life-safety machines drive STA-strict
  // loading + a tooltip badge in the visualizer).
  severity?: 'life-safety' | string;
  isExample: boolean;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
}

export interface MachineCreateRequest {
  name: string;
  description: string;
  sequenceIds?: string[];
  metadata?: Record<string, any>;
}

export interface MachineUpdateRequest {
  name?: string;
  description?: string;
  sequenceIds?: string[];
  metadata?: Record<string, any>;
}

export interface EngineStats {
  totalSequences: number;
  totalVectors: number;
  totalActiveVectors: number;
  sequenceStats: Array<{
    id: string;
    name: string;
    stats: any;
  }>;
}

// ===== Simulation Types =====

export type SimulationStatus = 'stopped' | 'playing' | 'paused';

export interface SimulationState {
  status: SimulationStatus;
  currentIndex: number;
  totalVectors: number;
  startTime: number | null;
  lastStepTime: number | null;
}

export interface ActivityEvent {
  id: string;
  type: 'vector-processed' | 'sequence-matched' | 'output-asserted' | 'transition' | 'error' | 'info';
  message: string;
  timestamp: number;
  severity: 'info' | 'success' | 'warning' | 'error';
  metadata?: Record<string, any>;
}

export interface WebSocketMessage {
  type: string;
  timestamp: number;
  [key: string]: any;
}

export interface TransitionResult {
  inputVector: number[];
  timestamp: number;
  sequenceResults: Record<string, {
    matched: boolean;
    matchedVectors: string[];
    transitions: Array<{
      fromVectorId: string;
      toVectorId: string;
      timestamp: number;
    }>;
    outputsAsserted: OutputVector[];
  }>;
  totalOutputs: OutputVector[];
}

// ===== Perceptual Input Sequence Types =====

export interface VectorSequenceItem {
  id: string;
  vector: number[];
  timestamp: number;
  source: 'algorithmic' | 'random' | 'manual' | 'override';
  metadata?: any;
}

// ===== Perception Engine Source Types =====

export interface PERegion {
  offset: number;
  length: number;
}

export interface PETestSource {
  type: 'test';
  id: string;
  name: string;
  region: PERegion;
  active: boolean;
  machineId: string;
  machineName: string;
  sequenceName: string;
  inputs: number[][];
  loop: boolean;
}

export interface PESimulatedSource {
  type: 'simulated';
  id: string;
  name: string;
  region: PERegion;
  active: boolean;
  pattern: string;
  frequency: number;
  amplitude: number;
  dcOffset: number;
}

export interface PESensorSource {
  type: 'sensor';
  id: string;
  name: string;
  region: PERegion;
  active: boolean;
  sensorId: string;
  lastValue: number[];
  lastUpdated: number | null;
  ttlMs: number;
  // Derived freshness — set by /api/sources at the PE backend.  ageMs is
  // (now - lastUpdated) in milliseconds; stale = ageMs > ttlMs.  Lets the
  // visualizer render a freshness badge per sensor without doing the math
  // client-side.
  ageMs?: number;
  stale?: boolean;
}

// ── MQTT bridge surfaces ────────────────────────────────────────────────────

export interface MqttBridgeStatus {
  enabled: boolean;
  connected?: boolean;
  brokerUrl?: string;
  clientId?: string;
  mappings?: number;
  bridge?: {
    messagesReceived?: number;
    messagesMapped?: number;
    messagesRejected?: number;
    messagesUnmatched?: number;
    pushesTriggered?: number;
  };
}

export interface MqttMappingRule {
  id: string;
  topicFilter: string;
  sensorIdTemplate: string;
  region: { offset: number; length: number };
  extract: { type: string; pointer?: string; index?: number };
  normalize: { mode: string; min: number; max: number; scale: number; offset: number; clamp: boolean };
  ttlMs: number;
  qos: number;
  acceptRetained: boolean;
  pushMode: string;
  debounceMs: number;
  counters: {
    received: number;
    mapped: number;
    rejected: number;
    stale: number;
    lastMessageAtMs: number;
    lastError: string;
    lastErrorAtMs: number;
  };
}

export interface MqttMappingsResponse {
  enabled: boolean;
  mappings: MqttMappingRule[];
}

// ── Paging decisions (derived from /api/metrics) ────────────────────────────

export interface PagingDecision {
  runtime: string;
  ownerTeam: string;
  processStatus: string;
  ragStatusCode: string;
  machineId: string;
  count: number;
}

export interface PagingDecisionsResponse {
  decisions: PagingDecision[];
  total: number;
}

export type PESource = PETestSource | PESimulatedSource | PESensorSource;
