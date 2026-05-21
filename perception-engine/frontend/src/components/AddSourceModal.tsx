import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SourceConfig, SimPattern } from '../types.js';
import { getMachines } from '../api.js';
import { classifyMachine, DOMAIN_ORDER, DOMAINS, type DomainId } from './machineDomains.js';

interface Props {
  onAdd: (config: Omit<SourceConfig, 'id'>) => void;
  onClose: () => void;
  vectorSize?: number;
}

type Tab = 'test' | 'simulated' | 'sensor';
type DomainFilter = DomainId | 'all';

const SIM_PATTERNS: SimPattern[] = ['binary', 'sine', 'sawtooth', 'square', 'linear-ramp', 'random-walk', 'constant', 'gaussian-noise'];

interface MachineInfo {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, any> & {
    inputSequences?: Array<{ name: string; vectors: number[][] }>;
    perceptualMapping?: { input: { offset: number; length: number } };
  };
  perceptualMapping?: { input: { offset: number; length: number } };
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};

const modal: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 8,
  width: 480,
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
};

const label: React.CSSProperties = {
  display: 'block', fontSize: 12, color: '#94a3b8',
  marginBottom: 4, fontWeight: 600,
};

const input: React.CSSProperties = {
  width: '100%', padding: '6px 8px',
  background: '#1e293b', border: '1px solid #334155',
  borderRadius: 4, color: '#e2e8f0', fontSize: 13,
};

function Field({ label: lbl, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={label}>{lbl}</label>
      {children}
    </div>
  );
}

export default function AddSourceModal({ onAdd, onClose, vectorSize = 256 }: Props) {
  const [tab, setTab] = useState<Tab>('test');
  const [name, setName] = useState('');

  // Test tab state
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [machinesLoading, setMachinesLoading] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const [selectedSeqName, setSelectedSeqName] = useState('');
  const [testLoop, setTestLoop] = useState(true);
  const [testOffset, setTestOffset] = useState(0);
  const [domainFilter, setDomainFilter] = useState<DomainFilter>('all');
  const [machineQuery, setMachineQuery] = useState('');
  const [machineListOpen, setMachineListOpen] = useState(false);
  const [machineHighlight, setMachineHighlight] = useState(0);
  const machineBoxRef = useRef<HTMLDivElement | null>(null);

  // Simulated tab state
  const [simPattern, setSimPattern] = useState<SimPattern>('sine');
  const [simFreq, setSimFreq] = useState(0.1);
  const [simAmplitude, setSimAmplitude] = useState(0.5);
  const [simDcOffset, setSimDcOffset] = useState(0.5);
  const [simOffset, setSimOffset] = useState(0);
  const [simLength, setSimLength] = useState(4);

  // Sensor tab state
  const [sensorId, setSensorId] = useState('sensor-1');
  const [sensorOffset, setSensorOffset] = useState(0);
  const [sensorLength, setSensorLength] = useState(4);
  const [sensorTtl, setSensorTtl] = useState(5000);

  useEffect(() => {
    if (tab === 'test') {
      setMachinesLoading(true);
      getMachines()
        .then(data => setMachines(data as unknown as MachineInfo[]))
        .catch(() => setMachines([]))
        .finally(() => setMachinesLoading(false));
    }
  }, [tab]);

  const selectedMachine = machines.find(m => m.id === selectedMachineId);
  const sequences = (selectedMachine?.metadata?.inputSequences ?? []) as Array<{ name: string; vectors: number[][] }>;
  const selectedSeq = sequences.find(s => s.name === selectedSeqName);

  // Pre-classify machines once per machine list update; used by filter + counts.
  const classified = useMemo(
    () => machines.map(m => ({ machine: m, domain: classifyMachine(m) })),
    [machines],
  );

  // Domain counts (for the filter dropdown labels).
  const domainCounts = useMemo(() => {
    const counts: Partial<Record<DomainId, number>> = {};
    for (const { domain } of classified) counts[domain] = (counts[domain] ?? 0) + 1;
    return counts;
  }, [classified]);

  // Filtered + sorted machine list driven by the domain selector and the
  // incremental-search text. Sort is case-insensitive by name.
  const filteredMachines = useMemo(() => {
    const q = machineQuery.trim().toLowerCase();
    return classified
      .filter(({ domain }) => domainFilter === 'all' || domain === domainFilter)
      .filter(({ machine }) => !q || machine.name.toLowerCase().includes(q) || machine.id.toLowerCase().includes(q))
      .sort((a, b) => a.machine.name.localeCompare(b.machine.name, undefined, { sensitivity: 'base' }));
  }, [classified, domainFilter, machineQuery]);

  // Close the machine dropdown when clicking outside its container.
  useEffect(() => {
    if (!machineListOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (machineBoxRef.current && !machineBoxRef.current.contains(e.target as Node)) {
        setMachineListOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [machineListOpen]);

  // Keep highlight in range when the filtered list shrinks.
  useEffect(() => {
    if (machineHighlight >= filteredMachines.length) setMachineHighlight(0);
  }, [filteredMachines.length, machineHighlight]);

  function pickMachine(m: MachineInfo) {
    setSelectedMachineId(m.id);
    setSelectedSeqName('');
    setMachineQuery(m.name);
    setMachineListOpen(false);
  }

  function handleMachineKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMachineListOpen(true);
      setMachineHighlight(h => Math.min(h + 1, Math.max(0, filteredMachines.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMachineHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (machineListOpen && filteredMachines[machineHighlight]) {
        e.preventDefault();
        pickMachine(filteredMachines[machineHighlight].machine);
      }
    } else if (e.key === 'Escape') {
      setMachineListOpen(false);
    }
  }

  function handleSubmit() {
    if (!name.trim()) {
      alert('Please enter a name for the source.');
      return;
    }

    if (tab === 'test') {
      if (!selectedMachine || !selectedSeq) {
        alert('Please select a machine and sequence.');
        return;
      }
      const mapping = selectedMachine.perceptualMapping?.input ?? { offset: testOffset, length: selectedSeq.vectors[0]?.length ?? 4 };
      onAdd({
        type: 'test',
        name: name.trim(),
        region: { offset: mapping.offset, length: mapping.length },
        active: true,
        machineId: selectedMachineId,
        machineName: selectedMachine.name,
        sequenceName: selectedSeq.name,
        inputs: selectedSeq.vectors,
        loop: testLoop,
      } as Omit<SourceConfig, 'id'>);
      return;
    }

    if (tab === 'simulated') {
      onAdd({
        type: 'simulated',
        name: name.trim(),
        region: { offset: simOffset, length: simLength },
        active: true,
        pattern: simPattern,
        frequency: simFreq,
        amplitude: simAmplitude,
        dcOffset: simDcOffset,
      } as Omit<SourceConfig, 'id'>);
      return;
    }

    if (tab === 'sensor') {
      onAdd({
        type: 'sensor',
        name: name.trim(),
        region: { offset: sensorOffset, length: sensorLength },
        active: true,
        sensorId,
        lastValue: [],
        lastUpdated: null,
        ttlMs: sensorTtl,
      } as Omit<SourceConfig, 'id'>);
    }
  }

  const TAB_STYLE = (active: boolean): React.CSSProperties => ({
    padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
    color: active ? '#7dd3fc' : '#64748b',
    background: 'none', border: 'none',
    borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
  });

  const endpoint = `${window.location.protocol}//${window.location.hostname}:3004/api/sensors/${sensorId}`;

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        {/* Header */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Add Source</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Name field */}
        <div style={{ padding: '12px 16px 0' }}>
          <Field label="Source Name">
            <input style={input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DC Thermal Sensor" />
          </Field>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', padding: '0 16px', borderBottom: '1px solid #1e293b' }}>
          {(['test', 'simulated', 'sensor'] as Tab[]).map(t => (
            <button key={t} style={TAB_STYLE(tab === t)} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: '14px 16px', overflowY: 'auto', flex: 1 }}>

          {/* TEST TAB */}
          {tab === 'test' && (
            <>
              <Field label="Filter by Domain">
                <select
                  style={input}
                  value={domainFilter}
                  onChange={e => {
                    setDomainFilter(e.target.value as DomainFilter);
                    setMachineHighlight(0);
                  }}
                >
                  <option value="all">All domains ({classified.length})</option>
                  {DOMAIN_ORDER
                    .filter(d => (domainCounts[d] ?? 0) > 0)
                    .map(d => (
                      <option key={d} value={d}>
                        {DOMAINS[d].label} ({domainCounts[d]})
                      </option>
                    ))}
                </select>
              </Field>

              <Field label="Machine">
                {machinesLoading ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>Loading machines…</div>
                ) : (
                  <div ref={machineBoxRef} style={{ position: 'relative' }}>
                    <input
                      style={input}
                      value={machineQuery}
                      placeholder={`Type to search… (${filteredMachines.length} machine${filteredMachines.length === 1 ? '' : 's'})`}
                      onChange={e => {
                        setMachineQuery(e.target.value);
                        setMachineListOpen(true);
                        setMachineHighlight(0);
                        if (selectedMachineId) {
                          setSelectedMachineId('');
                          setSelectedSeqName('');
                        }
                      }}
                      onFocus={() => setMachineListOpen(true)}
                      onKeyDown={handleMachineKeyDown}
                      autoComplete="off"
                    />
                    {machineListOpen && filteredMachines.length > 0 && (
                      <div
                        style={{
                          position: 'absolute', top: '100%', left: 0, right: 0,
                          marginTop: 2, maxHeight: 220, overflowY: 'auto',
                          background: '#1e293b', border: '1px solid #334155',
                          borderRadius: 4, zIndex: 10,
                          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
                        }}
                      >
                        {filteredMachines.map(({ machine, domain }, idx) => {
                          const active = idx === machineHighlight;
                          return (
                            <div
                              key={machine.id}
                              onMouseDown={e => { e.preventDefault(); pickMachine(machine); }}
                              onMouseEnter={() => setMachineHighlight(idx)}
                              style={{
                                padding: '6px 8px', fontSize: 13, cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: 8,
                                background: active ? '#334155' : 'transparent',
                                color: '#e2e8f0',
                              }}
                            >
                              <span
                                title={DOMAINS[domain].label}
                                style={{
                                  flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%',
                                  background: DOMAINS[domain].color,
                                }}
                              />
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {machine.name}
                              </span>
                              <span style={{ flex: '0 0 auto', fontSize: 10, color: '#64748b' }}>
                                {DOMAINS[domain].short}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {machineListOpen && filteredMachines.length === 0 && (
                      <div
                        style={{
                          position: 'absolute', top: '100%', left: 0, right: 0,
                          marginTop: 2, padding: '8px 10px', fontSize: 12,
                          background: '#1e293b', border: '1px solid #334155',
                          borderRadius: 4, color: '#64748b', zIndex: 10,
                        }}
                      >
                        No machines match.
                      </div>
                    )}
                  </div>
                )}
              </Field>

              {selectedMachine && (
                <Field label="Input Sequence">
                  <select style={input} value={selectedSeqName} onChange={e => setSelectedSeqName(e.target.value)}>
                    <option value="">— select sequence —</option>
                    {sequences.map(s => <option key={s.name} value={s.name}>{s.name} ({s.vectors.length} steps)</option>)}
                  </select>
                </Field>
              )}

              {!selectedMachine?.perceptualMapping && (
                <Field label="Region Offset (no perceptual mapping detected)">
                  <input type="number" style={input} value={testOffset} onChange={e => setTestOffset(Number(e.target.value))} min={0} max={vectorSize - 1} />
                </Field>
              )}

              <Field label="Loop">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={testLoop} onChange={e => setTestLoop(e.target.checked)} />
                  <span style={{ fontSize: 13 }}>Repeat sequence when exhausted</span>
                </label>
              </Field>
            </>
          )}

          {/* SIMULATED TAB */}
          {tab === 'simulated' && (
            <>
              <Field label="Pattern">
                <select style={input} value={simPattern} onChange={e => setSimPattern(e.target.value as SimPattern)}>
                  {SIM_PATTERNS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label={`Frequency: ${simFreq} Hz`}>
                <input type="range" style={{ width: '100%' }} min={0.01} max={2} step={0.01} value={simFreq} onChange={e => setSimFreq(Number(e.target.value))} />
              </Field>
              <Field label={`Amplitude: ${simAmplitude.toFixed(2)}`}>
                <input type="range" style={{ width: '100%' }} min={0} max={0.5} step={0.01} value={simAmplitude} onChange={e => setSimAmplitude(Number(e.target.value))} />
              </Field>
              <Field label={`DC Offset: ${simDcOffset.toFixed(2)}`}>
                <input type="range" style={{ width: '100%' }} min={0} max={1} step={0.01} value={simDcOffset} onChange={e => setSimDcOffset(Number(e.target.value))} />
              </Field>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Region Offset">
                    <input type="number" style={input} value={simOffset} onChange={e => setSimOffset(Number(e.target.value))} min={0} max={vectorSize - 1} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Region Length">
                    <input type="number" style={input} value={simLength} onChange={e => setSimLength(Number(e.target.value))} min={1} max={vectorSize} />
                  </Field>
                </div>
              </div>
            </>
          )}

          {/* SENSOR TAB */}
          {tab === 'sensor' && (
            <>
              <Field label="Sensor ID">
                <input style={input} value={sensorId} onChange={e => setSensorId(e.target.value)} placeholder="e.g. thermal-sensor-1" />
              </Field>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Region Offset">
                    <input type="number" style={input} value={sensorOffset} onChange={e => setSensorOffset(Number(e.target.value))} min={0} max={vectorSize - 1} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Region Length">
                    <input type="number" style={input} value={sensorLength} onChange={e => setSensorLength(Number(e.target.value))} min={1} max={vectorSize} />
                  </Field>
                </div>
              </div>
              <Field label={`TTL: ${sensorTtl / 1000}s (zero value if no data within TTL)`}>
                <input type="range" style={{ width: '100%' }} min={1000} max={60000} step={1000} value={sensorTtl} onChange={e => setSensorTtl(Number(e.target.value))} />
              </Field>
              <div style={{ marginTop: 8, padding: 10, background: '#0a0a14', borderRadius: 4, border: '1px solid #1e293b' }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Push sensor values to:</div>
                <div style={{ fontSize: 12, color: '#7dd3fc', wordBreak: 'break-all' }}>{endpoint}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Body: {`{ "values": [0.0, 0.5, ...] }`}</div>
                <button
                  style={{ marginTop: 6, fontSize: 11, padding: '2px 8px', borderRadius: 3, border: '1px solid #334155', background: '#1e293b', color: '#94a3b8', cursor: 'pointer' }}
                  onClick={() => navigator.clipboard.writeText(endpoint)}
                >
                  Copy endpoint
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #1e293b', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid #334155', background: '#1e293b', color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} style={{ padding: '6px 14px', borderRadius: 4, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Add Source
          </button>
        </div>
      </div>
    </div>
  );
}
