import { useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * MqttConfigModal — runtime MQTT bridge configuration.  Operator types
 * a broker URL + a mapping registry JSON, hits Enable, and the PE boots
 * the bridge against the supplied config.  After Enable, the modal
 * polls /api/mqtt/status (500 ms cadence, 10 s budget) and reports
 * connected/disconnected so the operator sees end-to-end verification
 * before closing.
 *
 * Backed by three PE routes:
 *   POST /api/mqtt/enable  — boot bridge with body { brokerUrl, mappings }
 *   POST /api/mqtt/disable — clean shutdown
 *   GET  /api/mqtt/example — bundled yuma-agriculture registry (Load Example)
 */

const C_PANEL_BG = 'rgba(15, 23, 42, 0.98)';
const C_BORDER   = '#1e293b';
const C_TEXT     = '#e2e8f0';
const C_TEXT_DIM = '#94a3b8';
const C_OK       = '#22c55e';
const C_REJECT   = '#f87171';
const C_ACCENT   = '#3b82f6';
const C_DISABLED = '#475569';

const DEFAULT_BROKER_URL = 'mqtt://yuma.lateraledge.cloud:1883';

type Stage =
  | { kind: 'idle' }
  | { kind: 'enabling' }
  | { kind: 'verifying'; elapsedMs: number }
  | { kind: 'success'; brokerUrl: string; mappings: number; warnings?: string[] }
  | { kind: 'failure'; message: string }
  | { kind: 'disabling' }
  | { kind: 'disabled' };

interface MqttStatus {
  enabled: boolean;
  connected?: boolean;
  brokerUrl?: string;
  mappings?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function MqttConfigModal({ open, onClose }: Props) {
  const [brokerUrl, setBrokerUrl] = useState(DEFAULT_BROKER_URL);
  const [mappingsText, setMappingsText] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [loadingExample, setLoadingExample] = useState(false);
  const verifyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (verifyTimerRef.current) {
        clearInterval(verifyTimerRef.current);
        verifyTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (open && !mappingsText) {
      void loadExample();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  async function loadExample() {
    setLoadingExample(true);
    try {
      const r = await axios.get('/api/mqtt/example');
      setMappingsText(JSON.stringify(r.data, null, 2));
    } catch (e: any) {
      setStage({ kind: 'failure', message: `Could not load example: ${e?.message ?? e}` });
    } finally {
      setLoadingExample(false);
    }
  }

  function parseMappings(): object | null {
    try {
      const parsed = JSON.parse(mappingsText);
      return parsed;
    } catch (e: any) {
      setStage({ kind: 'failure', message: `Mappings JSON parse error: ${e?.message ?? e}` });
      return null;
    }
  }

  async function startVerificationPoll(): Promise<void> {
    const startedAt = Date.now();
    const budgetMs = 10_000;
    return new Promise(resolve => {
      if (verifyTimerRef.current) clearInterval(verifyTimerRef.current);
      verifyTimerRef.current = setInterval(async () => {
        const elapsed = Date.now() - startedAt;
        setStage({ kind: 'verifying', elapsedMs: elapsed });
        try {
          const r = await axios.get<MqttStatus>('/api/mqtt/status');
          const s = r.data;
          if (s.enabled && s.connected) {
            if (verifyTimerRef.current) { clearInterval(verifyTimerRef.current); verifyTimerRef.current = null; }
            setStage({
              kind: 'success',
              brokerUrl: s.brokerUrl ?? brokerUrl,
              mappings: s.mappings ?? 0,
            });
            resolve();
            return;
          }
        } catch {
          /* keep polling — bridge boot is async */
        }
        if (elapsed >= budgetMs) {
          if (verifyTimerRef.current) { clearInterval(verifyTimerRef.current); verifyTimerRef.current = null; }
          setStage({
            kind: 'failure',
            message: `Bridge accepted config but did not connect within ${budgetMs / 1000}s — check broker reachability and credentials.`,
          });
          resolve();
        }
      }, 500);
    });
  }

  async function onEnable() {
    const mappings = parseMappings();
    if (!mappings) return;
    if (!brokerUrl.trim()) {
      setStage({ kind: 'failure', message: 'Broker URL is required (e.g. mqtt://host:1883).' });
      return;
    }
    setStage({ kind: 'enabling' });
    try {
      const r = await axios.post('/api/mqtt/enable', {
        brokerUrl: brokerUrl.trim(),
        mappings,
      });
      const data = r.data ?? {};
      // PE accepted the config — now verify connection by polling status.
      setStage({ kind: 'verifying', elapsedMs: 0 });
      await startVerificationPoll();
      // If poll succeeded, success state already set; otherwise failure was set.
      // Stash mapping count from enable response onto success state if missing.
      setStage(prev => {
        if (prev.kind === 'success' && (prev.mappings === 0 || prev.mappings == null)) {
          return { ...prev, mappings: data.mappings ?? prev.mappings, warnings: data.warnings };
        }
        if (prev.kind === 'success' && (!prev.warnings || prev.warnings.length === 0) && Array.isArray(data.warnings) && data.warnings.length > 0) {
          return { ...prev, warnings: data.warnings };
        }
        return prev;
      });
    } catch (e: any) {
      const apiError = e?.response?.data?.error;
      setStage({ kind: 'failure', message: apiError ?? e?.message ?? String(e) });
    }
  }

  async function onDisable() {
    setStage({ kind: 'disabling' });
    try {
      await axios.post('/api/mqtt/disable');
      setStage({ kind: 'disabled' });
    } catch (e: any) {
      const apiError = e?.response?.data?.error;
      setStage({ kind: 'failure', message: apiError ?? e?.message ?? String(e) });
    }
  }

  const busy = stage.kind === 'enabling' || stage.kind === 'verifying' || stage.kind === 'disabling';

  return (
    <div style={overlayStyle} onClick={busy ? undefined : onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, color: C_TEXT, fontSize: 14, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Configure MQTT Bridge
          </h3>
          <button onClick={onClose} disabled={busy} style={closeBtnStyle(busy)}>×</button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          <label style={labelStyle}>
            Broker URL
            <input
              type="text"
              value={brokerUrl}
              onChange={e => setBrokerUrl(e.target.value)}
              placeholder={DEFAULT_BROKER_URL}
              disabled={busy}
              style={inputStyle}
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={labelStyle as any}>Mappings JSON</span>
            <button onClick={loadExample} disabled={busy || loadingExample} style={secondaryBtnStyle(busy || loadingExample)}>
              {loadingExample ? 'Loading…' : 'Load Example'}
            </button>
          </div>
          <textarea
            value={mappingsText}
            onChange={e => setMappingsText(e.target.value)}
            disabled={busy}
            spellCheck={false}
            rows={14}
            style={textareaStyle}
            placeholder='{ "defaults": { ... }, "mappings": [ ... ] }'
          />

          <StageBanner stage={stage} />
        </div>

        <div style={footerStyle}>
          <button onClick={onDisable} disabled={busy} style={secondaryBtnStyle(busy)}>
            {stage.kind === 'disabling' ? 'Disabling…' : 'Disable'}
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={busy} style={secondaryBtnStyle(busy)}>Close</button>
          <button onClick={onEnable} disabled={busy} style={primaryBtnStyle(busy)}>
            {stage.kind === 'enabling'  ? 'Enabling…'
            : stage.kind === 'verifying' ? `Verifying… (${Math.round(stage.elapsedMs / 100) / 10}s)`
            : 'Enable & Verify'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StageBanner({ stage }: { stage: Stage }) {
  if (stage.kind === 'idle') return null;
  let color = C_TEXT_DIM; let bg = 'rgba(148, 163, 184, 0.10)'; let icon = '•'; let text = '';
  switch (stage.kind) {
    case 'enabling':
      text = 'Sending configuration to PE…'; break;
    case 'verifying':
      text = `Bridge accepted — verifying connection (${Math.round(stage.elapsedMs / 100) / 10}s)…`;
      color = C_ACCENT; bg = 'rgba(59, 130, 246, 0.10)'; icon = '→';
      break;
    case 'success':
      text = `Connected to ${stage.brokerUrl} — ${stage.mappings} mapping${stage.mappings === 1 ? '' : 's'} active.`;
      color = C_OK; bg = 'rgba(34, 197, 94, 0.10)'; icon = '✓';
      break;
    case 'failure':
      text = stage.message;
      color = C_REJECT; bg = 'rgba(239, 68, 68, 0.12)'; icon = '✗';
      break;
    case 'disabling':
      text = 'Stopping bridge…'; break;
    case 'disabled':
      text = 'Bridge disabled.'; color = C_DISABLED; bg = 'rgba(71, 85, 105, 0.15)'; icon = '◼';
      break;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: bg, border: `1px solid ${color}`, borderRadius: 4 }}>
      <span style={{ color, fontWeight: 700 }}>{icon}</span>
      <span style={{ color, fontSize: 12, lineHeight: 1.4 }}>{text}</span>
      {stage.kind === 'success' && stage.warnings && stage.warnings.length > 0 && (
        <span style={{ color: C_TEXT_DIM, fontSize: 11, marginLeft: 8 }}>
          ({stage.warnings.length} warning{stage.warnings.length === 1 ? '' : 's'} — check PE logs)
        </span>
      )}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
  background: C_PANEL_BG, border: `1px solid ${C_BORDER}`, borderRadius: 8,
  width: 720, maxWidth: '92vw', boxShadow: '0 20px 50px rgba(0, 0, 0, 0.4)',
  display: 'flex', flexDirection: 'column',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '12px 16px', borderBottom: `1px solid ${C_BORDER}`,
};
const footerStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: '12px 16px', borderTop: `1px solid ${C_BORDER}`,
};
const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: C_TEXT_DIM,
  fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
};
const inputStyle: React.CSSProperties = {
  background: '#0b1220', color: C_TEXT, border: `1px solid ${C_BORDER}`,
  borderRadius: 4, padding: '8px 10px', fontFamily: 'monospace', fontSize: 12,
};
const textareaStyle: React.CSSProperties = {
  background: '#0b1220', color: C_TEXT, border: `1px solid ${C_BORDER}`,
  borderRadius: 4, padding: '10px 12px', fontFamily: 'monospace', fontSize: 11,
  lineHeight: 1.5, resize: 'vertical',
};
function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? C_DISABLED : C_ACCENT,
    color: '#fff', border: 'none', borderRadius: 4,
    padding: '8px 16px', fontSize: 12, fontWeight: 700,
    letterSpacing: 0.5, textTransform: 'uppercase',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
function secondaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: 'transparent', color: disabled ? C_DISABLED : C_TEXT,
    border: `1px solid ${disabled ? C_DISABLED : C_BORDER}`, borderRadius: 4,
    padding: '8px 14px', fontSize: 12, fontWeight: 700,
    letterSpacing: 0.5, textTransform: 'uppercase',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
function closeBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: 'transparent', color: disabled ? C_DISABLED : C_TEXT_DIM,
    border: 'none', fontSize: 22, lineHeight: 1, cursor: disabled ? 'not-allowed' : 'pointer',
    padding: '0 4px',
  };
}
