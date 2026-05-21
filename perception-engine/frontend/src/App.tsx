import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { EngineState, PushLogEntry, SourceConfig, MatchAlgorithm } from './types.js';
import {
  getState, push, startAuto, stopAuto, resetEngine, addSource, deleteSource, updateSource,
  setMatchAlgorithm, bootstrapFromMachines, getMachines,
} from './api.js';
import type { MachineSummary } from './api.js';
import { classifyMachine } from './components/machineDomains.js';
import type { DomainId } from './components/machineDomains.js';
import Header from './components/Header.js';
import SourcesPanel from './components/SourcesPanel.js';
import VectorDisplay from './components/VectorDisplay.js';
import PushLog from './components/PushLog.js';
import AddSourceModal from './components/AddSourceModal.js';
import MqttBridgePanel from './components/MqttBridgePanel.js';
import MqttIngestStream from './components/MqttIngestStream.js';

const MAX_LOG = 20;

export default function App() {
  const [state, setState] = useState<EngineState | null>(null);
  const [pushLog, setPushLog] = useState<PushLogEntry[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const autoIntervalRef = useRef<number>(1000);

  const refreshMachines = useCallback(async () => {
    try { setMachines(await getMachines()); }
    catch (err) { console.error('Failed to load machines:', err); }
  }, []);

  // Load initial state + machine catalog.  Machines drive the domain filter
  // / domain-targeted import.  Failure to fetch is non-fatal — the UI just
  // omits domain affordances until the next refresh.
  useEffect(() => {
    getState().then(setState).catch(console.error);
    void refreshMachines();
  }, [refreshMachines]);

  // machineId → domain table; built once per machine list change.  Sources
  // live in PE state but carry only machineId — the domain decoration is
  // computed here so the source pipeline never needs to mirror the
  // classifier.
  const machineDomain = useMemo<ReadonlyMap<string, DomainId>>(() => {
    const m = new Map<string, DomainId>();
    for (const machine of machines) m.set(machine.id, classifyMachine(machine));
    return m;
  }, [machines]);

  // WebSocket connection with reconnect
  useEffect(() => {
    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (destroyed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; [key: string]: unknown };

          if (msg.type === 'state-update') {
            setState(msg.state as EngineState);
          } else if (msg.type === 'push-result') {
            const entry: PushLogEntry = {
              id: `${Date.now()}-${Math.random()}`,
              success: msg.success as boolean,
              step: msg.step as Record<string, unknown> | undefined,
              timestamp: msg.timestamp as number,
              globalStep: msg.globalStep as number,
              error: msg.error as string | undefined,
            };
            setPushLog(prev => [entry, ...prev].slice(0, MAX_LOG));
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handlePush = useCallback(async () => {
    await push();
    // State update comes via WebSocket
  }, []);

  const handleAutoStart = useCallback(async () => {
    await startAuto(autoIntervalRef.current);
  }, []);

  const handleAutoStop = useCallback(async () => {
    await stopAuto();
  }, []);

  const handleReset = useCallback(async () => {
    await resetEngine();
  }, []);

  const handleIntervalChange = useCallback((ms: number) => {
    autoIntervalRef.current = ms;
    if (state?.auto.running) {
      startAuto(ms).catch(console.error);
    }
  }, [state?.auto.running]);

  const handleAddSource = useCallback(async (config: Omit<SourceConfig, 'id'>) => {
    try {
      await addSource(config);
      // Explicitly refresh state — the WS broadcast may lose the race with the
      // modal close animation, leaving the panel momentarily stale.
      const updated = await getState();
      setState(updated);
    } catch (err) {
      console.error('Failed to add source:', err);
    } finally {
      setShowAddModal(false);
    }
  }, []);

  const handleDeleteSource = useCallback(async (id: string) => {
    await deleteSource(id);
  }, []);

  const handleToggleSource = useCallback(async (id: string, active: boolean) => {
    await updateSource(id, { active });
  }, []);

  const handleToggleAllSources = useCallback(async (active: boolean) => {
    const current = state?.sources ?? [];
    const targets = current.filter(s => s.active !== active);
    if (targets.length === 0) return;
    // Optimistic update so the checkbox flips immediately; the WS state-update
    // broadcast will reconcile with the server's authoritative state when each
    // PATCH lands.
    setState(prev => prev ? {
      ...prev,
      sources: prev.sources.map(s => s.active === active ? s : { ...s, active }),
    } : prev);
    await Promise.all(targets.map(s => updateSource(s.id, { active }).catch(err => {
      console.error(`Failed to toggle source ${s.id}:`, err);
    })));
  }, [state?.sources]);

  const handleMatchAlgorithmChange = useCallback(async (algo: MatchAlgorithm) => {
    await setMatchAlgorithm(algo);
    // State will update via WebSocket state-update broadcast
  }, []);

  const handleBootstrap = useCallback(async (opts?: { machineIds?: string[] }) => {
    const result = await bootstrapFromMachines(opts);
    // Server broadcasts state-update after saving; refresh explicitly in
    // case the WS message arrives after the button's status pill renders.
    if (result.created > 0) {
      const updated = await getState();
      setState(updated);
    }
    return result;
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header
        step={state?.globalStep ?? 0}
        isAutoRunning={state?.auto.running ?? false}
        autoIntervalMs={state?.auto.intervalMs ?? 1000}
        matchAlgorithm={state?.matchAlgorithm ?? 'gte'}
        onPush={handlePush}
        onAutoStart={handleAutoStart}
        onAutoStop={handleAutoStop}
        onReset={handleReset}
        onMatchAlgorithmChange={handleMatchAlgorithmChange}
        onIntervalChange={handleIntervalChange}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <SourcesPanel
          sources={state?.sources ?? []}
          machines={machines}
          machineDomain={machineDomain}
          onAdd={() => setShowAddModal(true)}
          onBootstrap={handleBootstrap}
          onRefreshMachines={refreshMachines}
          onDelete={handleDeleteSource}
          onToggle={handleToggleSource}
          onToggleAll={handleToggleAllSources}
          onHover={setHoveredSourceId}
          hoveredSourceId={hoveredSourceId}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto', padding: '12px', gap: '12px' }}>
          <VectorDisplay
            vector={state?.assembledVector ?? new Array(state?.vectorSize ?? 256).fill(0)}
            sources={state?.sources ?? []}
            hoveredSourceId={hoveredSourceId}
          />
          <PushLog entries={pushLog} />
          {/* Universe Monitor — MQTT-side of the PE.  Self-contained
              panels that hit /api/mqtt/* on this PE directly.  Moved
              from the RE visualizer because the bridge is fundamentally
              a PE concern (it owns the broker subscription and the
              sensor source TTLs). */}
          <MqttBridgePanel />
          <MqttIngestStream />
        </div>
      </div>
      {showAddModal && (
        <AddSourceModal
          onAdd={handleAddSource}
          onClose={() => setShowAddModal(false)}
          vectorSize={state?.vectorSize ?? 256}
        />
      )}
    </div>
  );
}
