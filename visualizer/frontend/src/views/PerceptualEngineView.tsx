import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVisualizerStore } from '../store';
import { api } from '../api';
import type {
  PESource, PESimulatedSource, PESensorSource, PETestSource,
  PEFullState, PEPushLogEntry, PEMatchAlgorithm, PEBootstrapResult,
  Machine,
} from '../types';
import { classifyMachine, DOMAINS, DOMAIN_ORDER } from '../components/machineDomains';
import type { DomainId } from '../components/machineDomains';
import { MqttPanel } from '../components/MqttPanel';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_LOG = 20;
const POLL_IDLE_MS = 5_000;
const POLL_AUTO_MS = 1_500;

type SimPattern = 'sine' | 'sawtooth' | 'square' | 'linear-ramp' | 'random-walk' | 'constant' | 'gaussian-noise' | 'binary';
const SIM_PATTERNS: SimPattern[] = ['binary', 'sine', 'sawtooth', 'square', 'linear-ramp', 'random-walk', 'constant', 'gaussian-noise'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// ── Vector Heat Map ───────────────────────────────────────────────────────────

interface VectorHeatMapProps {
  vector: number[];
  sources: PESource[];
  hoveredSourceId: string | null;
}

const VectorHeatMap: React.FC<VectorHeatMapProps> = ({ vector, sources, hoveredSourceId }) => {
  const cellSize = 10;
  const cols = 64;
  const rows = Math.ceil(vector.length / cols);

  const hoveredRegion = useMemo(() => {
    if (!hoveredSourceId) return null;
    const src = sources.find(s => s.id === hoveredSourceId);
    return src ? src.region : null;
  }, [hoveredSourceId, sources]);

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{
        fontSize: 10, color: '#64748b', textTransform: 'uppercase',
        letterSpacing: '0.08em', fontWeight: 700, marginBottom: 8,
      }}>
        Assembled Vector — {vector.length} elements
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
        gap: 1,
        fontFamily: 'monospace',
      }}>
        {vector.map((v, i) => {
          const inHover = hoveredRegion
            ? i >= hoveredRegion.offset && i < hoveredRegion.offset + hoveredRegion.length
            : false;
          const intensity = Math.max(0, Math.min(1, v));
          const r = inHover ? Math.round(intensity * 160) : Math.round(intensity * 30);
          const g = inHover ? Math.round(100 + intensity * 155) : Math.round(intensity * 100);
          const b = inHover ? Math.round(100 + intensity * 155) : Math.round(100 + intensity * 155);
          return (
            <div
              key={i}
              title={`[${i}] = ${v.toFixed(3)}`}
              style={{
                width: cellSize, height: cellSize,
                background: `rgb(${r},${g},${b})`,
                borderRadius: 1,
                outline: inHover ? '1px solid rgba(125,211,252,0.6)' : 'none',
              }}
            />
          );
        })}
      </div>
      {rows > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          marginTop: 6, fontSize: 9, color: '#475569', fontFamily: 'monospace',
        }}>
          <span>0</span>
          <span>{Math.round(vector.length / 2)}</span>
          <span>{vector.length - 1}</span>
        </div>
      )}
    </div>
  );
};

// ── Push Log ──────────────────────────────────────────────────────────────────

const PushLog: React.FC<{ entries: PEPushLogEntry[] }> = ({ entries }) => (
  <div style={{ padding: '12px 16px', borderTop: '1px solid #1e293b' }}>
    <div style={{
      fontSize: 10, color: '#64748b', textTransform: 'uppercase',
      letterSpacing: '0.08em', fontWeight: 700, marginBottom: 8,
    }}>
      Push Log — last {entries.length}
    </div>
    {entries.length === 0 ? (
      <div style={{ fontSize: 12, color: '#475569' }}>No pushes yet.</div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map(e => (
          <div key={e.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 11, fontFamily: 'monospace',
            padding: '4px 8px', borderRadius: 4,
            background: e.success ? 'rgba(20, 83, 45, 0.3)' : 'rgba(127, 29, 29, 0.3)',
            border: `1px solid ${e.success ? '#166534' : '#991b1b'}`,
          }}>
            <span style={{ color: e.success ? '#4ade80' : '#f87171', flexShrink: 0 }}>
              {e.success ? '✓' : '✗'}
            </span>
            <span style={{ color: '#94a3b8' }}>step {e.globalStep}</span>
            <span style={{ color: '#64748b', marginLeft: 'auto' }}>
              {fmtAge(Date.now() - e.timestamp)}
            </span>
            {e.error && (
              <span style={{ color: '#f87171', fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.error}
              </span>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
);

// ── Source Card ───────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  test: '#3b82f6',
  simulated: '#22c55e',
  sensor: '#f59e0b',
};

function sourceSubtitle(src: PESource): string {
  if (src.type === 'test') {
    const t = src as PETestSource;
    return `${t.sequenceName} · [${src.region.offset}:${src.region.offset + src.region.length}]`;
  }
  if (src.type === 'simulated') {
    const s = src as PESimulatedSource;
    return `${s.pattern} f=${s.frequency}Hz · [${src.region.offset}:${src.region.offset + src.region.length}]`;
  }
  const se = src as PESensorSource;
  const age = se.lastUpdated ? fmtAge(Date.now() - se.lastUpdated) : 'no data';
  return `${se.sensorId} (${age}) · [${src.region.offset}:${src.region.offset + src.region.length}]`;
}

interface SourceCardProps {
  source: PESource;
  domain: DomainId | 'other';
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
  onHover: (id: string | null) => void;
  hovered: boolean;
}

const SourceCard: React.FC<SourceCardProps> = ({ source, domain, onDelete, onToggle, onHover, hovered }) => {
  const typeColor = TYPE_COLOR[source.type] ?? '#94a3b8';
  const domainColor = domain === 'other' ? '#94a3b8' : DOMAINS[domain].color;

  return (
    <div
      onMouseEnter={() => onHover(source.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        padding: '7px 10px', borderRadius: 5,
        border: `1px solid ${hovered ? typeColor : '#1e293b'}`,
        borderLeft: `3px solid ${domainColor}`,
        background: hovered ? '#1e293b' : '#111827',
        marginBottom: 5, transition: 'border-color 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          onClick={() => onToggle(source.id, !source.active)}
          title={source.active ? 'Disable source' : 'Enable source'}
          style={{
            width: 28, height: 16, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
            background: source.active ? '#166534' : '#334155',
            border: `1px solid ${source.active ? '#22c55e' : '#475569'}`,
            position: 'relative', transition: 'background 0.15s',
          }}
        >
          <span style={{
            position: 'absolute', top: 1,
            left: source.active ? 13 : 2,
            width: 12, height: 12, borderRadius: '50%',
            background: source.active ? '#4ade80' : '#64748b',
            transition: 'left 0.15s',
          }} />
        </button>
        <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
          background: typeColor + '22', color: typeColor, textTransform: 'uppercase',
          letterSpacing: '0.05em', flexShrink: 0 }}>
          {source.type}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {source.name}
        </span>
        <button
          onClick={() => onDelete(source.id)}
          title="Delete source"
          style={{
            background: 'transparent', border: 'none', color: '#475569',
            cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 10, color: '#64748b', marginTop: 3, marginLeft: 34,
        fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {sourceSubtitle(source)}
      </div>
    </div>
  );
};

// ── Add Source Modal ──────────────────────────────────────────────────────────

type AddSourceTab = 'simulated' | 'sensor';

interface AddSourceModalProps {
  vectorSize: number;
  onAdd: (config: Omit<PESource, 'id'>) => Promise<void>;
  onClose: () => void;
}

const AddSourceModal: React.FC<AddSourceModalProps> = ({ vectorSize, onAdd, onClose }) => {
  const [tab, setTab] = useState<AddSourceTab>('simulated');
  const [name, setName] = useState('');
  const [offset, setOffset] = useState(0);
  const [length, setLength] = useState(1);
  const [active, setActive] = useState(true);

  // Simulated fields
  const [pattern, setPattern] = useState<SimPattern>('sine');
  const [frequency, setFrequency] = useState(0.1);
  const [amplitude, setAmplitude] = useState(0.5);
  const [dcOffset, setDcOffset] = useState(0.5);

  // Sensor fields
  const [sensorId, setSensorId] = useState('');
  const [ttlMs, setTtlMs] = useState(60_000);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (offset < 0 || offset >= vectorSize) { setError(`Offset must be 0–${vectorSize - 1}`); return; }
    if (length < 1 || offset + length > vectorSize) { setError(`Length must fit within vector size ${vectorSize}`); return; }
    if (tab === 'sensor' && !sensorId.trim()) { setError('Sensor ID is required'); return; }

    const region = { offset, length };
    let config: Omit<PESource, 'id'>;

    if (tab === 'simulated') {
      config = { type: 'simulated', name: name.trim(), region, active, pattern, frequency, amplitude, dcOffset } as Omit<PESimulatedSource, 'id'>;
    } else {
      config = { type: 'sensor', name: name.trim(), region, active, sensorId: sensorId.trim(), lastValue: [], lastUpdated: null, ttlMs } as Omit<PESensorSource, 'id'>;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onAdd(config);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to add source');
    } finally {
      setSubmitting(false);
    }
  };

  const inp: React.CSSProperties = {
    width: '100%', padding: '5px 8px',
    background: '#1e293b', border: '1px solid #334155',
    borderRadius: 4, color: '#e2e8f0', fontSize: 12, boxSizing: 'border-box',
  };
  const lbl: React.CSSProperties = {
    display: 'block', fontSize: 11, color: '#94a3b8', fontWeight: 600, marginBottom: 3,
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }} onClick={onClose}>
      <div style={{
        background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8,
        width: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>

        {/* Modal header */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #1e293b',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#7dd3fc' }}>Add Source</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #1e293b' }}>
          {(['simulated', 'sensor'] as AddSourceTab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1, padding: '8px 12px', border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
                background: tab === t ? '#1e293b' : 'transparent',
                color: tab === t ? '#7dd3fc' : '#64748b',
                borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '16px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>

          <div>
            <label style={lbl}>Name</label>
            <input style={inp} value={name} onChange={e => setName(e.target.value)} placeholder="Source name" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={lbl}>Offset (0–{vectorSize - 1})</label>
              <input style={inp} type="number" min={0} max={vectorSize - 1} value={offset} onChange={e => setOffset(Number(e.target.value))} />
            </div>
            <div>
              <label style={lbl}>Length</label>
              <input style={inp} type="number" min={1} max={vectorSize - offset} value={length} onChange={e => setLength(Number(e.target.value))} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" id="src-active" checked={active} onChange={e => setActive(e.target.checked)} style={{ accentColor: '#3b82f6' }} />
            <label htmlFor="src-active" style={{ fontSize: 12, color: '#94a3b8', cursor: 'pointer' }}>Active on creation</label>
          </div>

          {tab === 'simulated' && (
            <>
              <div>
                <label style={lbl}>Pattern</label>
                <select style={{ ...inp, cursor: 'pointer' }} value={pattern} onChange={e => setPattern(e.target.value as SimPattern)}>
                  {SIM_PATTERNS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div>
                  <label style={lbl}>Frequency (Hz)</label>
                  <input style={inp} type="number" step={0.01} min={0} value={frequency} onChange={e => setFrequency(Number(e.target.value))} />
                </div>
                <div>
                  <label style={lbl}>Amplitude</label>
                  <input style={inp} type="number" step={0.05} min={0} max={1} value={amplitude} onChange={e => setAmplitude(Number(e.target.value))} />
                </div>
                <div>
                  <label style={lbl}>DC Offset</label>
                  <input style={inp} type="number" step={0.05} min={0} max={1} value={dcOffset} onChange={e => setDcOffset(Number(e.target.value))} />
                </div>
              </div>
            </>
          )}

          {tab === 'sensor' && (
            <>
              <div>
                <label style={lbl}>Sensor ID</label>
                <input style={inp} value={sensorId} onChange={e => setSensorId(e.target.value)} placeholder="e.g. agx001.water.ph.ok" />
              </div>
              <div>
                <label style={lbl}>TTL (ms)</label>
                <input style={inp} type="number" min={1000} step={1000} value={ttlMs} onChange={e => setTtlMs(Number(e.target.value))} />
              </div>
            </>
          )}

          {error && (
            <div style={{ fontSize: 11, color: '#fca5a5', background: '#1f1010', borderRadius: 4, padding: '6px 10px', border: '1px solid #7f1d1d' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #1e293b', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid #3b82f6', background: '#1e3a5f', color: '#7dd3fc', fontSize: 12, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? 'Adding…' : 'Add Source'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Bootstrap Result Banner ───────────────────────────────────────────────────

const BootstrapBanner: React.FC<{ result: PEBootstrapResult; onDismiss: () => void }> = ({ result, onDismiss }) => {
  const outOfRange = (result.reasons?.outOfRange ?? 0) > 0;
  return (
    <div style={{
      padding: '8px 12px', fontSize: 11,
      background: outOfRange ? '#1c1407' : '#0f172a',
      border: `1px solid ${outOfRange ? '#7c4d0c' : '#1e3a5f'}`,
      borderRadius: 4, marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
          background: result.created > 0 ? '#14532d' : '#1e293b',
          color: result.created > 0 ? '#86efac' : '#7dd3fc',
          textTransform: 'uppercase',
        }}>
          {result.created > 0 ? `+${result.created} new` : 'no new sources'}
        </span>
        <span style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 10 }}>
          {result.machinesSeen} machines
        </span>
        <button onClick={onDismiss} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>
      {result.reasons && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, fontFamily: 'monospace', fontSize: 10, color: '#94a3b8' }}>
          {result.reasons.alreadyExisted > 0 && <span>{result.reasons.alreadyExisted} already imported</span>}
          {result.reasons.outOfRange > 0 && <span style={{ color: '#fbbf24' }}>{result.reasons.outOfRange} out of range</span>}
          {result.reasons.noSequences > 0 && <span>{result.reasons.noSequences} invalid</span>}
        </div>
      )}
      {outOfRange && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#fbbf24' }}>
          Raise PE <code>VECTOR_SIZE</code> to {result.vectorSize ?? 256} or higher and restart.
        </div>
      )}
    </div>
  );
};

// ── Sources Panel ─────────────────────────────────────────────────────────────

interface SourcesPanelProps {
  sources: PESource[];
  machines: Machine[];
  onAdd: () => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
  onToggleAll: (active: boolean) => void;
  onHover: (id: string | null) => void;
  onBootstrap: (opts?: { machineIds?: string[] }) => Promise<PEBootstrapResult>;
  hoveredSourceId: string | null;
}

const SourcesPanel: React.FC<SourcesPanelProps> = ({
  sources, machines, onAdd, onDelete, onToggle, onToggleAll, onHover, onBootstrap, hoveredSourceId,
}) => {
  const [bootstrapping, setBootstrapping] = useState(false);
  const [lastBootstrap, setLastBootstrap] = useState<PEBootstrapResult | null>(null);
  const [filter, setFilter] = useState<DomainId | null>(null);

  const machineDomain = useMemo(() => {
    const m = new Map<string, DomainId>();
    for (const machine of machines) m.set(machine.id, classifyMachine(machine).domain);
    return m;
  }, [machines]);

  const sourceDomain = (s: PESource): DomainId | 'other' => {
    if (s.type !== 'test') return 'other';
    return machineDomain.get((s as PETestSource).machineId) ?? 'other';
  };

  const visible = filter ? sources.filter(s => sourceDomain(s) === filter) : sources;
  const allOn = visible.length > 0 && visible.every(s => s.active);
  const allOff = visible.every(s => !s.active);

  const domainCounts = useMemo(() => {
    const m = new Map<DomainId, number>();
    for (const s of sources) {
      const d = sourceDomain(s);
      if (d !== 'other') m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, machineDomain]);

  const runBootstrap = async (opts?: { machineIds?: string[] }) => {
    setBootstrapping(true);
    setLastBootstrap(null);
    try {
      const r = await onBootstrap(opts);
      setLastBootstrap(r);
      setTimeout(() => setLastBootstrap(null), 12_000);
    } finally {
      setBootstrapping(false);
    }
  };

  return (
    <div style={{
      width: 280, flexShrink: 0, borderRight: '1px solid #1e293b',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0a0f1e',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '10px 12px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, flex: 1 }}>
          Sources ({filter ? `${visible.length}/` : ''}{sources.length})
        </span>
        <button
          onClick={() => runBootstrap()}
          disabled={bootstrapping}
          title="Import test sources from machine inputSequences"
          style={{
            padding: '3px 8px', borderRadius: 4, border: '1px solid #334155',
            background: '#1e293b', color: '#94a3b8', fontSize: 11, fontWeight: 600,
            cursor: bootstrapping ? 'wait' : 'pointer', opacity: bootstrapping ? 0.6 : 1,
          }}
        >
          {bootstrapping ? '…' : 'Import'}
        </button>
        <button
          onClick={onAdd}
          style={{
            padding: '3px 8px', borderRadius: 4, border: '1px solid #3b82f6',
            background: '#1e3a5f', color: '#7dd3fc', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + Add
        </button>
      </div>

      {/* Master toggle + filter chips */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <button
            onClick={() => onToggleAll(!allOn)}
            disabled={visible.length === 0}
            style={{
              padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
              border: `1px solid ${allOn ? '#166534' : allOff ? '#7f1d1d' : '#334155'}`,
              background: allOn ? 'rgba(22, 101, 52, 0.3)' : allOff ? 'rgba(127, 29, 29, 0.3)' : '#1e293b',
              color: allOn ? '#4ade80' : allOff ? '#f87171' : '#94a3b8',
              cursor: 'pointer',
            }}
          >
            {allOn ? 'All On' : allOff ? 'All Off' : 'Mixed'}
          </button>
          {filter && (
            <button
              onClick={() => setFilter(null)}
              style={{ background: 'transparent', border: 'none', color: '#7dd3fc', fontSize: 10, fontWeight: 600, cursor: 'pointer', padding: 0 }}
            >
              clear filter
            </button>
          )}
        </div>
        {/* Domain filter chips */}
        {domainCounts.size > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {DOMAIN_ORDER.filter(d => domainCounts.has(d)).map(d => {
              const active = filter === d;
              const color = DOMAINS[d].color;
              return (
                <button
                  key={d}
                  onClick={() => setFilter(active ? null : d)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '2px 6px', borderRadius: 10, fontSize: 9, fontWeight: 600,
                    border: `1px solid ${active ? color : '#1e293b'}`,
                    background: active ? color + '22' : '#0f172a',
                    color: active ? color : '#64748b', cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, opacity: active ? 1 : 0.55 }} />
                  {DOMAINS[d].short} {domainCounts.get(d)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Source list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        {lastBootstrap && <BootstrapBanner result={lastBootstrap} onDismiss={() => setLastBootstrap(null)} />}
        {visible.length === 0 ? (
          <div style={{ color: '#475569', fontSize: 12, textAlign: 'center', marginTop: 24 }}>
            {sources.length === 0
              ? <>No sources yet.<br />Click Import or + Add.</>
              : 'No sources match filter.'}
          </div>
        ) : (
          visible.map(src => (
            <SourceCard
              key={src.id}
              source={src}
              domain={sourceDomain(src)}
              onDelete={onDelete}
              onToggle={onToggle}
              onHover={onHover}
              hovered={hoveredSourceId === src.id}
            />
          ))
        )}
      </div>
    </div>
  );
};

// ── Main View ─────────────────────────────────────────────────────────────────

export const PerceptualEngineView: React.FC = () => {
  const { setCurrentView } = useVisualizerStore();

  const [state, setState] = useState<PEFullState | null>(null);
  const [pushLog, setPushLog] = useState<PEPushLogEntry[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [autoIntervalMs, setAutoIntervalMs] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'vector' | 'mqtt'>('vector');

  const isAutoRunning = state?.auto.running ?? false;
  const pollMs = isAutoRunning ? POLL_AUTO_MS : POLL_IDLE_MS;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load initial state ───────────────────────────────────────────────────
  useEffect(() => {
    api.getPEFullState().then(s => {
      setState(s);
      setAutoIntervalMs(s.auto.intervalMs ?? 1000);
    }).catch(e => setError(`Could not connect to PE: ${e.message}`));

    api.getMachines().then(setMachines).catch(() => {});
  }, []);

  // ── Polling ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const poll = () => {
      api.getPEFullState().then(s => {
        setState(s);
      }).catch(() => {});
    };

    pollRef.current = setInterval(poll, pollMs);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollMs]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handlePush = useCallback(async () => {
    try {
      const result = await api.pePush();
      const entry: PEPushLogEntry = { ...result, id: `${Date.now()}-${Math.random()}` };
      setPushLog(prev => [entry, ...prev].slice(0, MAX_LOG));
      api.getPEFullState().then(setState).catch(() => {});
    } catch (e: any) {
      const entry: PEPushLogEntry = {
        id: `${Date.now()}-${Math.random()}`, success: false,
        timestamp: Date.now(), globalStep: state?.globalStep ?? 0,
        error: e.message,
      };
      setPushLog(prev => [entry, ...prev].slice(0, MAX_LOG));
    }
  }, [state?.globalStep]);

  const handleAutoStart = useCallback(async () => {
    await api.peStartAuto(autoIntervalMs).catch(console.error);
    api.getPEFullState().then(setState).catch(() => {});
  }, [autoIntervalMs]);

  const handleAutoStop = useCallback(async () => {
    await api.peStopAuto().catch(console.error);
    api.getPEFullState().then(setState).catch(() => {});
  }, []);

  const handleReset = useCallback(async () => {
    await api.peReset().catch(console.error);
    setPushLog([]);
    api.getPEFullState().then(setState).catch(() => {});
  }, []);

  const handleMatchAlgorithm = useCallback(async (algo: PEMatchAlgorithm) => {
    await api.peSetMatchAlgorithm(algo).catch(console.error);
    api.getPEFullState().then(setState).catch(() => {});
  }, []);

  const handleIntervalChange = useCallback((ms: number) => {
    setAutoIntervalMs(ms);
    if (isAutoRunning) {
      api.peStartAuto(ms).catch(console.error);
    }
  }, [isAutoRunning]);

  const handleAddSource = useCallback(async (config: Omit<PESource, 'id'>) => {
    await api.peAddSource(config);
    const updated = await api.getPEFullState();
    setState(updated);
    setShowAddModal(false);
  }, []);

  const handleDeleteSource = useCallback(async (id: string) => {
    await api.peDeleteSource(id).catch(console.error);
    api.getPEFullState().then(setState).catch(() => {});
  }, []);

  const handleToggleSource = useCallback(async (id: string, active: boolean) => {
    setState(prev => prev ? { ...prev, sources: prev.sources.map(s => s.id === id ? { ...s, active } : s) } : prev);
    await api.peUpdateSource(id, { active } as Partial<PESource>).catch(console.error);
    api.getPEFullState().then(setState).catch(() => {});
  }, []);

  const handleToggleAll = useCallback(async (active: boolean) => {
    const sources = state?.sources ?? [];
    const targets = sources.filter(s => s.active !== active);
    if (targets.length === 0) return;
    setState(prev => prev ? { ...prev, sources: prev.sources.map(s => ({ ...s, active })) } : prev);
    await Promise.all(targets.map(s => api.peUpdateSource(s.id, { active } as Partial<PESource>).catch(console.error)));
    api.getPEFullState().then(setState).catch(() => {});
  }, [state?.sources]);

  const handleBootstrap = useCallback(async (opts?: { machineIds?: string[] }): Promise<PEBootstrapResult> => {
    const result = await api.peBootstrapFromMachines(opts);
    if (result.created > 0) {
      const updated = await api.getPEFullState();
      setState(updated);
    }
    return result;
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const btn: React.CSSProperties = {
    padding: '5px 12px', borderRadius: 4, border: '1px solid #334155',
    cursor: 'pointer', fontSize: 12, fontWeight: 600,
    background: '#1e293b', color: '#e2e8f0',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: '#080d18' }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 16px', background: '#0f172a',
        borderBottom: '1px solid #1e293b', flexShrink: 0,
      }}>
        <button
          onClick={() => setCurrentView('selection')}
          title="Back to Reality Engine"
          style={{ ...btn, color: '#64748b', padding: '5px 8px', fontSize: 14 }}
        >
          ‹
        </button>

        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#7dd3fc' }}>PERCEPTION ENGINE</div>
          <div style={{ fontSize: 10, color: '#64748b' }}>perceptual space management</div>
        </div>

        <div style={{ color: '#94a3b8', fontSize: 12, marginLeft: 4 }}>
          Step <strong style={{ color: '#e2e8f0' }}>{state?.globalStep ?? 0}</strong>
          <span style={{ color: '#334155', margin: '0 8px' }}>·</span>
          {state?.sources.filter(s => s.active).length ?? 0}/{state?.sources.length ?? 0} active
          <span style={{ color: '#334155', margin: '0 8px' }}>·</span>
          dim {state?.vectorSize ?? '–'}
        </div>

        {/* Match algorithm */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
          <span style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Match</span>
          <div style={{ display: 'flex', borderRadius: 4, border: '1px solid #334155', overflow: 'hidden' }}>
            {(['gte', 'equals'] as PEMatchAlgorithm[]).map(algo => (
              <button
                key={algo}
                onClick={() => handleMatchAlgorithm(algo)}
                title={algo === 'gte' ? 'Greater-than-or-equal' : 'Strict equality'}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 700,
                  cursor: 'pointer', border: 'none',
                  background: state?.matchAlgorithm === algo ? '#1d4ed8' : '#1e293b',
                  color: state?.matchAlgorithm === algo ? '#bfdbfe' : '#64748b',
                }}
              >
                {algo === 'gte' ? '≥ GTE' : '= Eq'}
              </button>
            ))}
          </div>
        </div>

        {/* Controls */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={btn} onClick={handlePush}>▶ Push Once</button>

          {/* Interval slider */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '3px 10px', borderRadius: 4,
            border: '1px solid #334155', background: '#0f172a',
          }}>
            <span style={{ fontSize: 9, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Delay</span>
            <input
              type="range" min={0} max={10000} step={100}
              value={autoIntervalMs}
              onChange={e => handleIntervalChange(Number(e.target.value))}
              style={{ width: 100, accentColor: '#38bdf8', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 600, color: '#7dd3fc', minWidth: 38, textAlign: 'right' }}>
              {(autoIntervalMs / 1000).toFixed(1)}s
            </span>
          </div>

          {isAutoRunning ? (
            <button style={{ ...btn, background: '#7f1d1d', borderColor: '#991b1b', color: '#fca5a5' }} onClick={handleAutoStop}>
              ■ Stop Auto
            </button>
          ) : (
            <button style={{ ...btn, background: '#14532d', borderColor: '#166534', color: '#86efac' }} onClick={handleAutoStart}>
              ⏱ Auto Push
            </button>
          )}

          <button style={{ ...btn, color: '#94a3b8' }} onClick={handleReset}>↺ Reset</button>
        </div>
      </div>

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          padding: '8px 16px', background: '#1f1010', borderBottom: '1px solid #7f1d1d',
          fontSize: 12, color: '#fca5a5', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Sources panel */}
        <SourcesPanel
          sources={state?.sources ?? []}
          machines={machines}
          onAdd={() => setShowAddModal(true)}
          onDelete={handleDeleteSource}
          onToggle={handleToggleSource}
          onToggleAll={handleToggleAll}
          onHover={setHoveredSourceId}
          onBootstrap={handleBootstrap}
          hoveredSourceId={hoveredSourceId}
        />

        {/* Right panel — tabbed: Vector / MQTT */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Tab bar */}
          <div style={{
            display: 'flex', gap: 0, flexShrink: 0,
            borderBottom: '1px solid #1e293b', background: '#0b1220',
          }}>
            {(['vector', 'mqtt'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setRightTab(tab)}
                style={{
                  padding: '7px 18px', fontSize: 11, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: 0.5,
                  border: 'none', borderBottom: rightTab === tab ? '2px solid #38bdf8' : '2px solid transparent',
                  background: 'transparent',
                  color: rightTab === tab ? '#38bdf8' : '#475569',
                  cursor: 'pointer', marginBottom: -1,
                }}
              >
                {tab === 'vector' ? '⊞ Vector' : '⚡ MQTT'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {rightTab === 'vector' ? (
              <>
                {state ? (
                  <VectorHeatMap
                    vector={state.assembledVector}
                    sources={state.sources}
                    hoveredSourceId={hoveredSourceId}
                  />
                ) : (
                  <div style={{ padding: 24, color: '#475569', fontSize: 13 }}>
                    {error ? 'Connection failed.' : 'Connecting to Perception Engine…'}
                  </div>
                )}
                <PushLog entries={pushLog} />
              </>
            ) : (
              <MqttPanel />
            )}
          </div>
        </div>
      </div>

      {showAddModal && (
        <AddSourceModal
          vectorSize={state?.vectorSize ?? 256}
          onAdd={handleAddSource}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
};

export default PerceptualEngineView;
