import { useEffect, useState } from 'react';

/**
 * MqttIngestStream — rolling live feed of recent MQTT ingests pushed via
 * the PE's own WebSocket.  Subscribes to /ws on this PE host, listens for
 * mqtt-ingest events, maintains a ring buffer.
 *
 * No polling — every accepted PUBLISH appears within the WS round-trip.
 */

const C_PANEL_BG = 'rgba(15, 23, 42, 0.95)';
const C_BORDER   = '#1e293b';
const C_TEXT     = '#e2e8f0';
const C_DIM      = '#94a3b8';
const C_FRESH    = '#22c55e';

interface IngestEvent {
  sensorId: string;
  mappingId: string;
  topic: string;
  offset: number;
  length: number;
  values: number[];
  ttlMs: number;
  timestamp: number;
}

const MQTT_INGEST_CAP = 120;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
         '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function fmtValues(v: number[]): string {
  if (v.length === 0) return '—';
  return '[' + v.slice(0, 4).map(x => x.toFixed(3)).join(', ') + (v.length > 4 ? '…' : '') + ']';
}

export default function MqttIngestStream({ limit = 30 }: { limit?: number }) {
  const [events, setEvents] = useState<IngestEvent[]>([]);

  useEffect(() => {
    // Subscribe to a dedicated WS for mqtt-ingest events.  The PE's
    // existing ws connection in App.tsx already exists, but we keep this
    // one self-contained so the panel can be dropped in / out without
    // touching the parent component.  PE backend broadcasts both
    // state-update and mqtt-ingest on /ws; we ignore the former.
    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    function connect() {
      if (destroyed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;
      ws = new WebSocket(url);

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type: string; payload?: IngestEvent };
          if (msg.type !== 'mqtt-ingest' || !msg.payload) return;
          setEvents(prev => {
            const next = [msg.payload!, ...prev];
            if (next.length > MQTT_INGEST_CAP) next.length = MQTT_INGEST_CAP;
            return next;
          });
        } catch { /* ignore parse errors */ }
      };
      ws.onclose = () => { if (!destroyed) reconnectTimer = setTimeout(connect, 2000); };
    }
    connect();
    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  const rows = events.slice(0, limit);

  return (
    <div style={{ background: C_PANEL_BG, border: `1px solid ${C_BORDER}`, borderRadius: 6, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: C_TEXT, fontSize: 14, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          Live MQTT Ingest
        </h3>
        <span style={{ fontSize: 10, color: C_DIM, fontFamily: 'monospace' }}>
          last {rows.length} of {events.length} · WebSocket
        </span>
      </div>
      {rows.length === 0 && (
        <div style={{ color: C_DIM, fontSize: 12 }}>
          Waiting for MQTT ingest events…  Configure a broker + mappings file on this PE to populate the stream.
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ maxHeight: 320, overflowY: 'auto', borderTop: `1px solid ${C_BORDER}` }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <tbody>
              {rows.map((r, i) => {
                const fade = 1 - (i / Math.max(rows.length - 1, 1)) * 0.45;
                return (
                  <tr key={`${r.timestamp}-${r.sensorId}-${i}`}
                      style={{ borderBottom: `1px solid ${C_BORDER}`, opacity: fade }}>
                    <td style={{ padding: '5px 8px', color: C_DIM, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{fmtTime(r.timestamp)}</td>
                    <td style={{ padding: '5px 8px', color: C_FRESH, fontFamily: 'monospace' }}>{r.sensorId}</td>
                    <td style={{ padding: '5px 8px', color: C_DIM, fontFamily: 'monospace', fontSize: 10 }}>{r.topic}</td>
                    <td style={{ padding: '5px 8px', color: C_DIM, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      [{r.offset}–{r.offset + r.length - 1}]
                    </td>
                    <td style={{ padding: '5px 8px', color: C_TEXT, fontFamily: 'monospace' }}>{fmtValues(r.values)}</td>
                    <td style={{ padding: '5px 8px', color: C_DIM, fontFamily: 'monospace', fontSize: 10 }}>via {r.mappingId}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
