/**
 * MqttPanel — MQTT bridge status monitor and runtime configuration surface.
 *
 * Mirrors MqttBridgePanel + MqttConfigModal from RealityEngine_AI/
 * perception-engine/frontend, adapted to route through the visualizer
 * backend proxy (/api/pe/mqtt/*) rather than hitting the PE directly.
 *
 * Panels:
 *   MqttPanel       — status badge, bridge stats, per-mapping table, opens modal
 *   MqttConfigModal — broker URL + mapping JSON editor, Enable/Disable with live
 *                     connection verification (500 ms poll, 10 s budget)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MqttBridgeStatus, MqttMappingRule, MqttMappingsResponse } from '../types';

// ── Design tokens (dark navy palette matching PerceptualEngineView) ──────────
const T_SURFACE = '#0f172a';
const T_BORDER  = '#1e293b';
const T_TEXT    = '#e2e8f0';
const T_DIM     = '#64748b';
const T_DIM2    = '#94a3b8';
const T_OK      = '#22c55e';
const T_ERR     = '#f87171';
const T_ACCENT  = '#38bdf8';
const T_WARN    = '#f59e0b';
const T_OFF     = '#475569';

const POLL_MS = 3_000;
const DEFAULT_BROKER = 'mqtt://yuma.lateraledge.cloud:1883';

const EXAMPLE_MAPPINGS = JSON.stringify({
  version: '1.0',
  defaults: { ttlMs: 30000, qos: 0, acceptRetained: true, pushMode: 'debounced', debounceMs: 250 },
  mappings: [
    {
      id: 'zone-temperature',
      topicFilter: 'sensors/zone/+/temp',
      sensorIdTemplate: 'zone.{1}.temp',
      region: { offset: 0, length: 1 },
      extract: { type: 'json', pointer: '/value' },
      normalize: { mode: 'minmax', min: -40, max: 80, clamp: true },
      ttlMs: 60000,
      pushMode: 'debounced',
      debounceMs: 500,
    },
    {
      id: 'humidity',
      topicFilter: 'sensors/+/humidity',
      sensorIdTemplate: 'humidity.{1}',
      region: { offset: 4, length: 1 },
      extract: { type: 'csv-float' },
      normalize: { mode: 'passthrough', clamp: true },
    },
    {
      id: 'alarm-state',
      topicFilter: 'alarms/+/state',
      sensorIdTemplate: 'alarm.{1}',
      region: { offset: 8, length: 1 },
      extract: { type: 'json', pointer: '/triggered' },
      normalize: { mode: 'passthrough', clamp: true },
      pushMode: 'immediate',
    },
  ],
}, null, 2);

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n?: number) => (n ?? 0).toLocaleString();

function fmtAge(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// ── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: MqttBridgeStatus }) {
  let label: string; let bg: string; let fg: string;
  if (!status.enabled)       { label = 'DISABLED';     bg = T_OFF;  fg = T_TEXT; }
  else if (status.connected) { label = 'CONNECTED';    bg = T_OK;   fg = '#0f172a'; }
  else                       { label = 'DISCONNECTED'; bg = T_ERR;  fg = '#0f172a'; }
  return (
    <span style={{
      display: 'inline-block', background: bg, color: fg,
      padding: '2px 9px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: 0.5, textTransform: 'uppercase',
    }}>{label}</span>
  );
}

// ── Stat ─────────────────────────────────────────────────────────────────────

const Stat: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = T_TEXT }) => (
  <div style={{ minWidth: 84 }}>
    <div style={{ fontSize: 9, color: T_DIM2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 18, color, fontFamily: 'monospace', marginTop: 2 }}>{value}</div>
  </div>
);

// ── MappingTable ─────────────────────────────────────────────────────────────

const MappingTable: React.FC<{ mappings: MqttMappingRule[] }> = ({ mappings }) => {
  const Th = ({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) => (
    <th style={{
      padding: '6px 10px', textAlign: align, color: T_DIM2, fontSize: 9,
      fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      borderBottom: `1px solid ${T_BORDER}`, whiteSpace: 'nowrap',
    }}>{children}</th>
  );

  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${T_BORDER}`, borderRadius: 4, marginTop: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: '#050a12' }}>
            <Th>ID</Th>
            <Th>Topic Filter</Th>
            <Th>Region</Th>
            <Th>Extract</Th>
            <Th>Normalize</Th>
            <Th>Push</Th>
            <Th align="right">Rcvd</Th>
            <Th align="right">OK</Th>
            <Th align="right">Rej</Th>
            <Th>Last Seen</Th>
            <Th>Last Error</Th>
          </tr>
        </thead>
        <tbody>
          {mappings.map(rule => {
            const c = rule.counters;
            const hasErr = !!c.lastError;
            const age = c.lastMessageAtMs > 0 ? fmtAge(Date.now() - c.lastMessageAtMs) : '—';
            return (
              <tr
                key={rule.id}
                style={{
                  borderBottom: `1px solid ${T_BORDER}`,
                  background: hasErr ? 'rgba(239,68,68,0.08)' : 'transparent',
                }}
              >
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 11, color: T_ACCENT, whiteSpace: 'nowrap' }}>{rule.id}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 10, color: T_DIM2, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.topicFilter}</td>
                <td style={{ padding: '7px 10px', fontSize: 11, color: T_DIM2, whiteSpace: 'nowrap' }}>
                  [{rule.region.offset}–{rule.region.offset + rule.region.length - 1}]
                </td>
                <td style={{ padding: '7px 10px', fontSize: 10, color: T_DIM2, whiteSpace: 'nowrap' }}>
                  {rule.extract.type}{rule.extract.pointer ? ` ${rule.extract.pointer}` : ''}
                </td>
                <td style={{ padding: '7px 10px', fontSize: 10, color: T_DIM2, whiteSpace: 'nowrap' }}>
                  {rule.normalize.mode}
                </td>
                <td style={{ padding: '7px 10px', fontSize: 10, color: T_DIM2, whiteSpace: 'nowrap' }}>
                  {rule.pushMode}{rule.pushMode === 'debounced' ? ` ${rule.debounceMs}ms` : ''}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 11, color: T_TEXT }}>{fmt(c.received)}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 11, color: c.mapped > 0 ? T_OK : T_DIM }}>{fmt(c.mapped)}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 11, color: c.rejected > 0 ? T_ERR : T_DIM }}>{fmt(c.rejected)}</td>
                <td style={{ padding: '7px 10px', fontSize: 10, color: T_DIM2, whiteSpace: 'nowrap' }}>{age}</td>
                <td style={{ padding: '7px 10px', fontSize: 10, color: T_ERR, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {hasErr ? c.lastError : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ── MqttConfigModal ───────────────────────────────────────────────────────────

type Stage =
  | { kind: 'idle' }
  | { kind: 'enabling' }
  | { kind: 'verifying'; elapsedMs: number }
  | { kind: 'success'; brokerUrl: string; mappings: number; warnings?: string[] }
  | { kind: 'failure'; message: string }
  | { kind: 'disabling' }
  | { kind: 'disabled' };

interface MqttConfigModalProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

const MqttConfigModal: React.FC<MqttConfigModalProps> = ({ open, onClose, onChanged }) => {
  const [brokerUrl, setBrokerUrl] = useState(DEFAULT_BROKER);
  const [mappingsText, setMappingsText] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const verifyRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (verifyRef.current) clearInterval(verifyRef.current); }, []);

  useEffect(() => {
    if (open && !mappingsText) loadExample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadExample = useCallback(() => {
    setMappingsText(EXAMPLE_MAPPINGS);
    setStage({ kind: 'idle' });
  }, []);

  const parseMappings = (): object | null => {
    try {
      return JSON.parse(mappingsText);
    } catch (e: any) {
      setStage({ kind: 'failure', message: `Mappings JSON error: ${e?.message ?? e}` });
      return null;
    }
  };

  const startVerifyPoll = (): Promise<void> => {
    const budget = 10_000;
    const started = Date.now();
    return new Promise(resolve => {
      if (verifyRef.current) clearInterval(verifyRef.current);
      verifyRef.current = setInterval(async () => {
        const elapsed = Date.now() - started;
        setStage({ kind: 'verifying', elapsedMs: elapsed });
        try {
          const s = await api.getMqttStatus();
          if (s.enabled && s.connected) {
            clearInterval(verifyRef.current!); verifyRef.current = null;
            setStage({ kind: 'success', brokerUrl: s.brokerUrl ?? brokerUrl, mappings: s.mappings ?? 0 });
            onChanged(); resolve(); return;
          }
        } catch { /* keep polling */ }
        if (elapsed >= budget) {
          clearInterval(verifyRef.current!); verifyRef.current = null;
          setStage({ kind: 'failure', message: `Bridge accepted config but did not connect within ${budget / 1000}s — check broker URL and credentials.` });
          resolve();
        }
      }, 500);
    });
  };

  const onEnable = async () => {
    const mappings = parseMappings();
    if (!mappings) return;
    if (!brokerUrl.trim()) { setStage({ kind: 'failure', message: 'Broker URL is required.' }); return; }
    setStage({ kind: 'enabling' });
    try {
      const r = await api.mqttEnable(brokerUrl.trim(), mappings);
      setStage({ kind: 'verifying', elapsedMs: 0 });
      await startVerifyPoll();
      setStage(prev => {
        if (prev.kind === 'success' && prev.mappings === 0) return { ...prev, mappings: r.mappings ?? 0, warnings: r.warnings };
        return prev;
      });
    } catch (e: any) {
      setStage({ kind: 'failure', message: e?.response?.data?.error ?? e?.message ?? String(e) });
    }
  };

  const onDisable = async () => {
    setStage({ kind: 'disabling' });
    try {
      await api.mqttDisable();
      setStage({ kind: 'disabled' });
      onChanged();
    } catch (e: any) {
      setStage({ kind: 'failure', message: e?.response?.data?.error ?? e?.message ?? String(e) });
    }
  };

  if (!open) return null;
  const busy = stage.kind === 'enabling' || stage.kind === 'verifying' || stage.kind === 'disabling';

  const inp: React.CSSProperties = {
    background: '#050a12', color: T_TEXT, border: `1px solid ${T_BORDER}`,
    borderRadius: 4, padding: '8px 10px', fontFamily: 'monospace', fontSize: 12,
    width: '100%', boxSizing: 'border-box',
  };
  const primaryBtn = (disabled: boolean): React.CSSProperties => ({
    background: disabled ? T_OFF : T_ACCENT, color: disabled ? T_DIM2 : '#0b1220',
    border: 'none', borderRadius: 4, padding: '8px 16px', fontSize: 12,
    fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
    cursor: disabled ? 'not-allowed' : 'pointer',
  });
  const secondaryBtn = (disabled: boolean): React.CSSProperties => ({
    background: 'transparent', color: disabled ? T_DIM : T_TEXT,
    border: `1px solid ${disabled ? T_OFF : T_BORDER}`, borderRadius: 4,
    padding: '8px 14px', fontSize: 12, fontWeight: 700,
    letterSpacing: 0.5, textTransform: 'uppercase',
    cursor: disabled ? 'not-allowed' : 'pointer',
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={busy ? undefined : onClose}
    >
      <div
        style={{ background: T_SURFACE, border: `1px solid ${T_BORDER}`, borderRadius: 8, width: 740, maxWidth: '94vw', boxShadow: '0 24px 56px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${T_BORDER}` }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: T_ACCENT, letterSpacing: 0.5, textTransform: 'uppercase' }}>Configure MQTT Bridge</span>
          <button onClick={onClose} disabled={busy} style={{ background: 'transparent', border: 'none', color: T_DIM2, fontSize: 22, lineHeight: 1, cursor: busy ? 'not-allowed' : 'pointer', padding: '0 4px' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: T_DIM2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Broker URL
            <input type="text" value={brokerUrl} onChange={e => setBrokerUrl(e.target.value)} placeholder={DEFAULT_BROKER} disabled={busy} style={inp} />
          </label>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: T_DIM2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Mapping Registry JSON</span>
            <button onClick={loadExample} disabled={busy} style={secondaryBtn(busy)}>
              Load Example
            </button>
          </div>
          <textarea
            value={mappingsText}
            onChange={e => setMappingsText(e.target.value)}
            disabled={busy}
            spellCheck={false}
            rows={14}
            style={{ ...inp, resize: 'vertical', lineHeight: 1.5, fontSize: 11 }}
            placeholder='{ "defaults": { ... }, "mappings": [ ... ] }'
          />

          {/* Stage banner */}
          {stage.kind !== 'idle' && (
            <StageBanner stage={stage} />
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: `1px solid ${T_BORDER}`, alignItems: 'center' }}>
          <button onClick={onDisable} disabled={busy} style={secondaryBtn(busy)}>
            {stage.kind === 'disabling' ? 'Disabling…' : 'Disable'}
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={busy} style={secondaryBtn(busy)}>Close</button>
          <button onClick={onEnable} disabled={busy} style={primaryBtn(busy)}>
            {stage.kind === 'enabling'  ? 'Enabling…'
            : stage.kind === 'verifying' ? `Verifying… (${(stage.elapsedMs / 1000).toFixed(1)}s)`
            : 'Enable & Verify'}
          </button>
        </div>
      </div>
    </div>
  );
};

function StageBanner({ stage }: { stage: Stage }) {
  let color = T_DIM2; let bg = 'rgba(100,116,139,0.10)'; let icon = '•'; let text = '';
  switch (stage.kind) {
    case 'enabling':  text = 'Sending configuration to PE…'; break;
    case 'verifying':
      text  = `Accepted — verifying connection (${(stage.elapsedMs / 1000).toFixed(1)}s)…`;
      color = T_ACCENT; bg = 'rgba(56,189,248,0.08)'; icon = '→'; break;
    case 'success':
      text  = `Connected to ${stage.brokerUrl} — ${stage.mappings} mapping${stage.mappings === 1 ? '' : 's'} active.`;
      color = T_OK; bg = 'rgba(34,197,94,0.08)'; icon = '✓'; break;
    case 'failure':
      text  = stage.message;
      color = T_ERR; bg = 'rgba(239,68,68,0.10)'; icon = '✗'; break;
    case 'disabling': text = 'Stopping bridge…'; break;
    case 'disabled':  text = 'Bridge stopped.'; color = T_OFF; bg = 'rgba(71,85,105,0.12)'; icon = '◼'; break;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: bg, border: `1px solid ${color}`, borderRadius: 4 }}>
      <span style={{ color, fontWeight: 700 }}>{icon}</span>
      <span style={{ color, fontSize: 12, lineHeight: 1.4 }}>{text}</span>
      {'warnings' in stage && stage.warnings && stage.warnings.length > 0 && (
        <span style={{ color: T_DIM2, fontSize: 11, marginLeft: 6 }}>
          ({stage.warnings.length} region-overlap warning{stage.warnings.length > 1 ? 's' : ''} — check PE logs)
        </span>
      )}
    </div>
  );
}

// ── MqttPanel ─────────────────────────────────────────────────────────────────

export const MqttPanel: React.FC = () => {
  const [status,   setStatus]   = useState<MqttBridgeStatus | null>(null);
  const [mappings, setMappings] = useState<MqttMappingsResponse | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        api.getMqttStatus(),
        api.getMqttMappings().catch(() => null),
      ]);
      setStatus(s);
      setMappings(m);
      setFetchErr(null);
    } catch (e: any) {
      if (e?.response?.status === 404) {
        setStatus({ enabled: false });
        setMappings(null);
        setFetchErr(null);
      } else {
        setFetchErr(e?.message ?? String(e));
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (fetchErr) {
    return (
      <div style={{ padding: 20, color: T_ERR, fontFamily: 'monospace', fontSize: 12 }}>
        MQTT bridge unavailable: {fetchErr}
      </div>
    );
  }

  if (!status) {
    return <div style={{ padding: 20, color: T_DIM, fontSize: 12 }}>Loading MQTT bridge…</div>;
  }

  const bridge = status.bridge ?? {};
  const hasMappings = (mappings?.mappings?.length ?? 0) > 0;

  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: T_TEXT, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          MQTT Bridge
        </span>
        <StatusBadge status={status} />
        {status.enabled && status.brokerUrl && (
          <span style={{ fontSize: 11, color: T_DIM2, fontFamily: 'monospace' }}>{status.brokerUrl}</span>
        )}
        {status.enabled && status.clientId && (
          <span style={{ fontSize: 10, color: T_DIM, fontFamily: 'monospace' }}>id: {status.clientId}</span>
        )}
        <button
          onClick={() => setConfigOpen(true)}
          style={{
            marginLeft: 'auto',
            background: status.enabled ? 'transparent' : T_ACCENT,
            color: status.enabled ? T_DIM2 : '#0b1220',
            border: `1px solid ${status.enabled ? T_BORDER : T_ACCENT}`,
            borderRadius: 4, padding: '5px 12px', fontSize: 11, fontWeight: 700,
            letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer',
          }}
        >
          {status.enabled ? 'Reconfigure' : 'Configure MQTT'}
        </button>
      </div>

      {/* ── Stats row (when enabled) ────────────────────────────────────── */}
      {status.enabled && (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px', background: T_SURFACE, border: `1px solid ${T_BORDER}`, borderRadius: 6 }}>
          <Stat label="Mappings"  value={fmt(status.mappings ?? mappings?.mappings?.length)} />
          <Stat label="Received"  value={fmt(bridge.messagesReceived)} />
          <Stat label="Mapped"    value={fmt(bridge.messagesMapped)}    color={bridge.messagesMapped ? T_OK   : T_TEXT} />
          <Stat label="Rejected"  value={fmt(bridge.messagesRejected)}  color={bridge.messagesRejected ? T_ERR : T_DIM} />
          <Stat label="Unmatched" value={fmt(bridge.messagesUnmatched)} color={bridge.messagesUnmatched ? T_WARN : T_DIM} />
          <Stat label="Pushes"    value={fmt(bridge.pushesTriggered)} />
        </div>
      )}

      {/* ── Mapping registry table ─────────────────────────────────────── */}
      {status.enabled && hasMappings && (
        <>
          <div style={{ fontSize: 10, color: T_DIM2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Mapping Registry — {mappings!.mappings.length} rule{mappings!.mappings.length !== 1 ? 's' : ''}
          </div>
          <MappingTable mappings={mappings!.mappings} />
        </>
      )}

      {/* ── Disabled state ─────────────────────────────────────────────── */}
      {!status.enabled && (
        <div style={{ padding: '14px 16px', background: T_SURFACE, border: `1px solid ${T_BORDER}`, borderRadius: 6, fontSize: 12, color: T_DIM2, lineHeight: 1.6 }}>
          MQTT ingest is disabled. Click <strong style={{ color: T_TEXT }}>Configure MQTT</strong> to
          set a broker URL and mapping registry at runtime — no PE restart needed.
          The default demo broker is{' '}
          <code style={{ color: T_ACCENT, fontFamily: 'monospace' }}>{DEFAULT_BROKER}</code>; click{' '}
          <strong style={{ color: T_TEXT }}>Load Example</strong> in the dialog to prefill a
          compatible mapping registry.
        </div>
      )}

      {/* ── Enabled but no mappings yet ──────────────────────────────── */}
      {status.enabled && !hasMappings && (
        <div style={{ padding: '12px 16px', background: T_SURFACE, border: `1px solid ${T_BORDER}`, borderRadius: 6, fontSize: 12, color: T_DIM2 }}>
          Bridge is {status.connected ? 'connected' : 'connecting'} but no mappings are registered.
          Use <strong style={{ color: T_TEXT }}>Reconfigure</strong> to load a mapping registry.
        </div>
      )}

      <MqttConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onChanged={refresh}
      />
    </div>
  );
};
