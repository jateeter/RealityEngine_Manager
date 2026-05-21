import { useEffect, useState } from 'react';
import axios from 'axios';
import MqttConfigModal from './MqttConfigModal';

/**
 * MqttBridgePanel — live monitor surface for the MQTT bridge owned by
 * THIS Perception Engine.  Lives in the PE visualizer (not the RE
 * visualizer) because MQTT ingest is a PE concern — the PE owns the
 * broker subscription, the mapping registry, the sensor source TTLs.
 *
 * Hits PE endpoints directly (no visualizer-backend hop):
 *   GET /api/mqtt/status   — connection state + bridge counters
 *   GET /api/mqtt/mappings — loaded registry + per-mapping counters
 *
 * 2 s poll cadence — fast enough to feel live without straining the PE.
 */

const C_CONNECTED    = '#10b981';
const C_DISCONNECTED = '#ef4444';
const C_DISABLED     = '#475569';
const C_PANEL_BG     = 'rgba(15, 23, 42, 0.95)';
const C_BORDER       = '#1e293b';
const C_TEXT         = '#e2e8f0';
const C_TEXT_DIM     = '#94a3b8';
const C_OK           = '#22c55e';
const C_REJECT       = '#f87171';
const C_ERROR_BG     = 'rgba(239, 68, 68, 0.12)';

interface BridgeStatus {
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

interface MappingRule {
  id: string;
  topicFilter: string;
  sensorIdTemplate: string;
  region: { offset: number; length: number };
  extract: { type: string; pointer?: string; index?: number };
  normalize: { mode: string; min: number; max: number; scale: number; offset: number; clamp: boolean };
  ttlMs: number;
  pushMode: string;
  counters: {
    received: number;
    mapped: number;
    rejected: number;
    lastError: string;
    lastErrorAtMs: number;
  };
}

interface MappingsResponse {
  enabled: boolean;
  mappings: MappingRule[];
}

function StatusBadge({ status }: { status: BridgeStatus }) {
  let label: string; let color: string;
  if (!status.enabled)      { label = 'DISABLED';     color = C_DISABLED; }
  else if (status.connected){ label = 'CONNECTED';    color = C_CONNECTED; }
  else                      { label = 'DISCONNECTED'; color = C_DISCONNECTED; }
  return (
    <span style={{
      display: 'inline-block', background: color, color: status.enabled ? '#0f172a' : '#e2e8f0',
      padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: 0.5, textTransform: 'uppercase',
    }}>{label}</span>
  );
}

const fmt = (n?: number) => (n ?? 0).toLocaleString();

function MappingRow({ rule }: { rule: MappingRule }) {
  const c = rule.counters ?? { received: 0, mapped: 0, rejected: 0, lastError: '', lastErrorAtMs: 0 };
  const hasError = c.lastError && c.lastError.length > 0;
  return (
    <tr style={{ borderBottom: `1px solid ${C_BORDER}`, background: hasError ? C_ERROR_BG : 'transparent' }}>
      <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 11, color: C_TEXT }}>{rule.id}</td>
      <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 11, color: C_TEXT_DIM }}>{rule.topicFilter}</td>
      <td style={{ padding: '8px 10px', fontSize: 11, color: C_TEXT_DIM, whiteSpace: 'nowrap' }}>
        [{rule.region.offset}–{rule.region.offset + rule.region.length - 1}]
      </td>
      <td style={{ padding: '8px 10px', fontSize: 11, color: C_TEXT_DIM }}>{rule.extract.type}{rule.extract.pointer ? ` ${rule.extract.pointer}` : ''}</td>
      <td style={{ padding: '8px 10px', fontSize: 11, color: C_TEXT_DIM }}>{rule.normalize.mode}</td>
      <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: C_TEXT }}>{fmt(c.received)}</td>
      <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: C_OK }}>{fmt(c.mapped)}</td>
      <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: c.rejected > 0 ? C_REJECT : C_TEXT_DIM }}>{fmt(c.rejected)}</td>
      <td style={{ padding: '8px 10px', fontSize: 10, color: C_REJECT, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {hasError ? c.lastError : ''}
      </td>
    </tr>
  );
}

const Th = ({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) => (
  <th style={{
    padding: '6px 10px', textAlign: align, color: C_TEXT_DIM, fontSize: 10,
    fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
    borderBottom: `1px solid ${C_BORDER}`,
  }}>{children}</th>
);

const Stat = ({ label, value, color = C_TEXT }: { label: string; value: string; color?: string }) => (
  <div style={{ minWidth: 90 }}>
    <div style={{ fontSize: 10, color: C_TEXT_DIM, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 18, color, fontFamily: 'monospace', marginTop: 2 }}>{value}</div>
  </div>
);

export default function MqttBridgePanel() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [mappings, setMappings] = useState<MappingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [s, m] = await Promise.all([
          axios.get<BridgeStatus>('/api/mqtt/status').then(r => r.data),
          axios.get<MappingsResponse>('/api/mqtt/mappings').then(r => r.data),
        ]);
        if (cancelled) return;
        setStatus(s); setMappings(m); setError(null);
      } catch (e: any) {
        if (cancelled) return;
        if (e?.response?.status === 404) {
          setStatus({ enabled: false });
          setMappings(null);
          setError(null);
        } else {
          setError(e?.message ?? String(e));
        }
      }
    }
    refresh();
    const id = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const configureBtnStyle: React.CSSProperties = {
    marginLeft: 'auto',
    background: status?.enabled ? 'transparent' : '#3b82f6',
    color: status?.enabled ? C_TEXT : '#fff',
    border: `1px solid ${status?.enabled ? C_BORDER : '#3b82f6'}`,
    borderRadius: 4, padding: '6px 12px', fontSize: 11, fontWeight: 700,
    letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer',
  };

  if (error) {
    return (
      <div style={{ padding: 16, background: C_PANEL_BG, color: C_REJECT, fontFamily: 'monospace', fontSize: 12, border: `1px solid ${C_BORDER}`, borderRadius: 6 }}>
        MQTT bridge: {error}
      </div>
    );
  }
  if (!status) {
    return <div style={{ padding: 16, background: C_PANEL_BG, color: C_TEXT_DIM, border: `1px solid ${C_BORDER}`, borderRadius: 6 }}>Loading MQTT bridge…</div>;
  }

  return (
    <div style={{ background: C_PANEL_BG, border: `1px solid ${C_BORDER}`, borderRadius: 6, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: C_TEXT, fontSize: 14, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          MQTT Bridge
        </h3>
        <StatusBadge status={status} />
        {status.enabled && status.brokerUrl && (
          <span style={{ fontSize: 11, color: C_TEXT_DIM, fontFamily: 'monospace' }}>{status.brokerUrl}</span>
        )}
        <button onClick={() => setConfigOpen(true)} style={configureBtnStyle}>
          {status.enabled ? 'Reconfigure' : 'Configure MQTT'}
        </button>
      </div>

      {status.enabled && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <Stat label="Mappings"  value={fmt(status.mappings ?? mappings?.mappings?.length)} />
            <Stat label="Received"  value={fmt(status.bridge?.messagesReceived)} />
            <Stat label="Mapped"    value={fmt(status.bridge?.messagesMapped)}   color={C_OK} />
            <Stat label="Rejected"  value={fmt(status.bridge?.messagesRejected)} color={status.bridge?.messagesRejected ? C_REJECT : C_TEXT_DIM} />
            <Stat label="Unmatched" value={fmt(status.bridge?.messagesUnmatched)} />
            <Stat label="Pushes"    value={fmt(status.bridge?.pushesTriggered)} />
          </div>

          {mappings && mappings.mappings?.length > 0 && (
            <div style={{ overflowX: 'auto', border: `1px solid ${C_BORDER}`, borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#0b1220' }}>
                    <Th>Mapping</Th><Th>Topic Filter</Th><Th>Region</Th>
                    <Th>Extract</Th><Th>Normalize</Th>
                    <Th align="right">Received</Th><Th align="right">Mapped</Th><Th align="right">Rejected</Th>
                    <Th>Last Error</Th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.mappings.map(m => <MappingRow key={m.id} rule={m} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!status.enabled && (
        <div style={{ color: C_TEXT_DIM, fontSize: 12, lineHeight: 1.5 }}>
          MQTT ingest is disabled.  Click <strong style={{ color: C_TEXT }}>Configure MQTT</strong> to
          set a broker URL and mapping registry at runtime — no restart needed.  Default broker is{' '}
          <code style={{ color: C_TEXT, fontFamily: 'monospace' }}>mqtt://yuma.lateraledge.cloud:1883</code>.
        </div>
      )}

      <MqttConfigModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </div>
  );
}
