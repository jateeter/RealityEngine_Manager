import { useState, useEffect, useCallback, useRef } from 'react';
import { api, perceptionEngineApi } from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorNodeLite {
  id: string;
  label: string;
  isInitial: boolean;
  hasOutput: boolean;
  isActive?: boolean;               // node is currently queued / in pending-activations
  wasJustMatched?: boolean;         // terminal node matched (output emitted) this step
  wasJustInitialMatched?: boolean;  // initial node matched (A+ fired) this step
  elements: { value: number; comparatorType: string; threshold?: number }[];
}

export interface VisMachineEdge {
  source: string; // VectorNode id
  target: string; // VectorNode id
}

export interface VisMachineSequence {
  sequenceId: string;
  name: string;
  vectors: VectorNodeLite[];
  edges: VisMachineEdge[];
  metadata?: Record<string, any>;
}

export interface VisMachine {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, any>;
  isExample: boolean;
  sequences: VisMachineSequence[];
  status: 'idle' | 'processing' | 'active';
  position?: { x: number; y: number };
  // Perceptual mapping regions
  inputRegion?: { offset: number; length: number };
  outputRegion?: { offset: number; length: number };
  // Latest step values
  latestInputVector?: number[];
  latestOutputVector?: number[] | null;
  justFired: boolean;         // a terminal node emitted output this step
  hasInitialMatch: boolean;   // an initial node was matched this step (A+ fired)
}

export interface StepMachineResult {
  machineId: string;
  machineName: string;
  inputVector: number[];
  outputVector: number[] | null;
  inputRegion: { offset: number; length: number };
  outputRegion?: { offset: number; length: number } | null;
}

export interface StepRecord {
  stepNumber: number;
  timestamp: number;
  perceptualSpace: number[];
  machineResults: Record<string, StepMachineResult>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_HISTORY = 24;
const AUTO_PLAY_INTERVAL_MS = 600; // ms between pushes when auto-play is active

export const useMachineSimulation = () => {
  const [machines, setMachines] = useState<VisMachine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [isSimulationRunning, setIsSimulationRunning] = useState(false);
  const [stepHistory, setStepHistory] = useState<StepRecord[]>([]);
  const [isDemoLoading, setIsDemoLoading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  // O(1) deduplication — replaces the O(n) .some() scan on every step.
  // Cleared on reset and kept in sync with stepHistory trimming.
  const seenStepNumbers = useRef<Set<number>>(new Set());

  // ── Machine loading ────────────────────────────────────────────────────────
  // Single expanded call replaces the previous N+(N×M) waterfall:
  //   getMachines() → getMachine() × N → getSequence() × N×M

  const loadMachines = useCallback(async () => {
    try {
      const expanded = await api.getMachinesExpanded();

      const detailedMachines: VisMachine[] = expanded.map((machine: any) => ({
        id: machine.id,
        name: machine.name,
        description: machine.description,
        metadata: machine.metadata,
        isExample: machine.isExample || false,
        sequences: (machine.sequences || []).map((seq: any): VisMachineSequence => ({
          sequenceId: seq.sequenceId,
          name: seq.sequenceName,
          vectors: (seq.nodes || []).map((n: any): VectorNodeLite => ({
            id: n.id,
            // Prefer semantic name from metadata, fall back to truncated UUID
            label: n.metadata?.name || n.metadata?.role || (n.label && !n.label.startsWith('V-') ? n.label : '') || n.id.slice(-8),
            isInitial: n.isInitial ?? false,
            hasOutput: n.hasOutput ?? (n.outputVectors?.length > 0),
            isActive: n.isActive ?? false,
            elements: n.elements ?? [],
          })),
          edges: (seq.edges || []).map((e: any): VisMachineEdge => ({
            source: e.source,
            target: e.target,
          })),
          metadata: seq.metadata,
        })),
        status: 'idle' as const,
        justFired: false,
        hasInitialMatch: false,
        inputRegion: machine.perceptualMapping?.input,
        outputRegion: machine.perceptualMapping?.output,
      }));

      setMachines(detailedMachines);
    } catch (error) {
      console.error('Failed to load machines:', error);
    }
  }, []);

  // ── Demo loading ───────────────────────────────────────────────────────────

  const loadDataCenterDemo = useCallback(async () => {
    setIsDemoLoading(true);
    try {
      await api.loadDataCenterExample();
      await loadMachines();
    } catch (error) {
      console.error('Failed to load data center demo:', error);
    } finally {
      setIsDemoLoading(false);
    }
  }, [loadMachines]);

  // ── Shared step-result applicator ─────────────────────────────────────────
  // Used by both the WebSocket handler and the REST stepSimulation() call so
  // that the step counter and history advance regardless of WebSocket state.

  const applyStepResult = useCallback((step: any) => {
    if (!step) return;
    const activeIds: string[] = Object.keys(step.machineResults ?? {});
    const machineResults: Record<string, StepMachineResult> = step.machineResults ?? {};
    const perceptualSpace: number[] = step.perceptualSpace ?? [];
    const stepNumber: number = step.stepNumber ?? 0;

    const record: StepRecord = {
      stepNumber,
      timestamp: step.timestamp ?? Date.now(),
      perceptualSpace,
      machineResults,
    };

    setStepHistory((prev) => {
      // O(1) deduplication via Set — avoids O(n) .some() scan on every step.
      if (seenStepNumbers.current.has(record.stepNumber)) return prev;
      seenStepNumbers.current.add(record.stepNumber);
      const next = [...prev, record];
      if (next.length > MAX_HISTORY) {
        const trimmed = next.slice(next.length - MAX_HISTORY);
        // Rebuild Set to match trimmed history so it stays bounded at MAX_HISTORY entries.
        seenStepNumbers.current.clear();
        for (const r of trimmed) seenStepNumbers.current.add(r.stepNumber);
        return trimmed;
      }
      return next;
    });

    // Apply machine status + per-node activation state in one pass.
    // Activation deltas are read directly from step.machineResults.transitionResult
    // so no GET /api/viz/sequences round-trip is needed on every step.
    setMachines((prev) =>
      prev.map((m) => {
        const fired  = activeIds.includes(m.id);
        const result = machineResults[m.id];

        // Build per-sequence delta from the raw step payload (typed as any since
        // StepMachineResult omits transitionResult, which is present in the JSON).
        type SeqDelta = { matched: Set<string>; activated: Set<string> };
        const rawMr: any = (step.machineResults ?? {})[m.id];
        const seqResults: Record<string, any> = rawMr?.transitionResult?.sequenceResults ?? {};
        const seqDeltas = new Map<string, SeqDelta>();
        for (const [seqId, sr] of Object.entries(seqResults)) {
          seqDeltas.set(seqId, {
            matched:   new Set<string>((sr as any).matchedVectors   ?? []),
            activated: new Set<string>((sr as any).activatedVectors ?? []),
          });
        }

        // Determine card-level event flags from the per-node deltas.
        let hasOutputFired = false;
        let hasInitialMatch = false;
        if (fired) {
          for (const seq of m.sequences) {
            const d = seqDeltas.get(seq.sequenceId);
            if (!d) continue;
            for (const v of seq.vectors) {
              if (d.matched.has(v.id)) {
                if (v.hasOutput)  hasOutputFired  = true;
                if (v.isInitial)  hasInitialMatch = true;
              }
            }
          }
        }

        return {
          ...m,
          status: fired ? ('processing' as const) : ('idle' as const),
          justFired: hasOutputFired,
          hasInitialMatch,
          latestInputVector:  result?.inputVector  ?? m.latestInputVector,
          latestOutputVector: hasOutputFired
            ? (result?.outputVector ?? m.latestOutputVector)
            : m.latestOutputVector,
          sequences: m.sequences.map((seq) => {
            const d = seqDeltas.get(seq.sequenceId);
            if (!d) return seq;
            return {
              ...seq,
              vectors: seq.vectors.map((v) => {
                const wasJustMatched        = d.matched.has(v.id) && v.hasOutput;
                const wasJustInitialMatched = d.matched.has(v.id) && v.isInitial;
                const isDeactivated         = d.matched.has(v.id) && !v.isInitial && !v.hasOutput;
                const isActivated           = d.activated.has(v.id);
                return {
                  ...v,
                  wasJustMatched,
                  wasJustInitialMatched,
                  isActive: isDeactivated ? false : isActivated ? true : (v.isActive ?? false),
                };
              }),
            };
          }),
        };
      })
    );
  }, []);

  // ── WebSocket ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const connect = () => {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProto}//${window.location.hostname}:3001/ws`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'perceptual-simulation-stepped') {
            // Step data is in msg.step; msg.data only carries activeMachineIds
            applyStepResult(msg.step);
          } else if (msg.type === 'perceptual-simulation-reset') {
            seenStepNumbers.current.clear();
            setStepHistory([]);
            setMachines((prev) =>
              prev.map((m) => ({
                ...m,
                status: 'idle' as const,
                justFired: false,
                hasInitialMatch: false,
                latestInputVector: undefined,
                latestOutputVector: undefined,
              }))
            );
          } else if (msg.type === 'demo-loaded') {
            // Refresh machine list when a demo is loaded externally
            loadMachines();
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => setTimeout(connect, 3000);
      wsRef.current = ws;
    };

    connect();
    return () => wsRef.current?.close();
  }, [loadMachines, applyStepResult]);

  useEffect(() => {
    loadMachines();
  }, [loadMachines]);

  // Sync isSimulationRunning with the Perception Engine's actual auto-push state on mount
  useEffect(() => {
    perceptionEngineApi.getState().then((state) => {
      setIsSimulationRunning(state.auto?.running === true);
    }).catch(() => { /* PE may not be reachable — leave default false */ });
  }, []);

  // ── Simulation controls — backed by the Perception Engine ─────────────────
  //
  // Play  → PE auto/start: PE assembles & pushes vectors on its own timer
  // Pause → PE auto/stop:  PE stops its timer; no more pushes
  // Step  → PE push:       PE assembles & pushes one vector immediately
  // Reset → PE reset + RE reset: PE step counter cleared, RE sim state cleared

  const stepSimulation = useCallback(async () => {
    try {
      const result = await perceptionEngineApi.push();
      // Apply immediately from the REST response for snappy feedback; the
      // matching WS perceptual-simulation-stepped message is deduplicated.
      if (result.success && result.step) {
        applyStepResult(result.step);
      }
    } catch (error) {
      console.error('Failed to push perception vector:', error);
    }
  }, [applyStepResult]);

  const selectMachine  = useCallback((id: string | null) => setSelectedMachineId(id), []);

  const playSimulation = useCallback(async () => {
    try {
      await perceptionEngineApi.autoStart(AUTO_PLAY_INTERVAL_MS);
      setIsSimulationRunning(true);
    } catch (error) {
      console.error('Failed to start perception engine auto-push:', error);
    }
  }, []);

  const pauseSimulation = useCallback(async () => {
    try {
      await perceptionEngineApi.autoStop();
    } catch (error) {
      console.error('Failed to stop perception engine auto-push:', error);
    } finally {
      setIsSimulationRunning(false);
    }
  }, []);

  const resetSimulation = useCallback(async () => {
    try {
      await Promise.all([
        perceptionEngineApi.autoStop(),
        perceptionEngineApi.reset(),
        api.resetPerceptualSimulation(),
      ]);
      setIsSimulationRunning(false);
      seenStepNumbers.current.clear();
      setStepHistory([]);
      setMachines((prev) =>
        prev.map((m) => ({
          ...m,
          status: 'idle' as const,
          justFired: false,
          latestInputVector: undefined,
          latestOutputVector: undefined,
        }))
      );
    } catch (error) {
      console.error('Failed to reset simulation:', error);
    }
  }, []);

  return {
    machines,
    selectedMachineId,
    isSimulationRunning,
    stepHistory,
    isDemoLoading,
    selectMachine,
    stepSimulation,
    playSimulation,
    pauseSimulation,
    resetSimulation,
    loadDataCenterDemo,
    refreshMachines: loadMachines,
  };
};
