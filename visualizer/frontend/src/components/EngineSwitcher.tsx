import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EngineInstance } from '../types';

const RUNTIME_COLOURS: Record<string, string> = {
  scala: '#dc4f2b',
  cpp:   '#5b8dd9',
  lsp:   '#7ab648',
};

function runtimeBadge(runtime: string) {
  const bg = RUNTIME_COLOURS[runtime] ?? '#888';
  return (
    <span style={{
      background: bg, color: '#fff',
      fontSize: '0.65rem', fontWeight: 700,
      padding: '1px 5px', borderRadius: 3,
      textTransform: 'uppercase', letterSpacing: '0.04em',
      marginLeft: 4,
    }}>
      {runtime}
    </span>
  );
}

// proxyPath is a same-origin path on the visualizer backend (e.g.
// /api/engines/default/health).  All engine health checks route through
// the backend proxy so the browser never makes cross-origin requests to
// arbitrary engine host:port addresses, avoiding CORS blocks.
function StatusDot({ proxyPath }: { proxyPath: string }) {
  const [healthy, setHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(proxyPath, { signal: AbortSignal.timeout(3000) });
        if (!cancelled) setHealthy(res.ok);
      } catch {
        if (!cancelled) setHealthy(false);
      }
    };
    void check();
    const t = setInterval(check, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [proxyPath]);

  const colour = healthy === null ? '#888' : healthy ? '#4caf50' : '#f44336';
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8,
      borderRadius: '50%', background: colour,
      marginRight: 6, flexShrink: 0,
    }} title={healthy === null ? 'checking…' : healthy ? 'healthy' : 'unreachable'} />
  );
}

interface Props {
  onSwitch?: (instance: EngineInstance) => void;
}

export function EngineSwitcher({ onSwitch }: Props) {
  const [instances, setInstances] = useState<EngineInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const reg = await api.getEngines();
      setInstances(reg.instances);
      setActiveId(reg.activeId);
    } catch { /* backend offline */ }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (instances.length === 0) return null;

  const active = instances.find(i => i.id === activeId) ?? instances[0];

  const handleSelect = async (inst: EngineInstance) => {
    if (inst.id === activeId || switching) return;
    setSwitching(true);
    setOpen(false);
    try {
      await api.setActiveEngine(inst.id);
      setActiveId(inst.id);
      window.dispatchEvent(new CustomEvent('re:engine-switched', { detail: { id: inst.id } }));
      onSwitch?.(inst);
    } catch (e) {
      console.error('Engine switch failed', e);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={switching}
        title="Switch active engine instance"
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
          color: '#fff', borderRadius: 6, padding: '4px 10px',
          cursor: switching ? 'wait' : 'pointer', fontSize: '0.8rem',
          opacity: switching ? 0.7 : 1,
        }}
      >
        <StatusDot proxyPath={`/api/engines/${active.id}/health`} />
        {active.id}
        {runtimeBadge(active.runtime)}
        <span style={{ marginLeft: 4, opacity: 0.7, fontSize: '0.7rem' }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, zIndex: 1000,
          background: '#1e2127', border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 8, minWidth: 280, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '6px 12px', fontSize: '0.7rem', color: '#888',
            borderBottom: '1px solid rgba(255,255,255,0.08)', textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            Engine Instances
          </div>
          {instances.map(inst => {
            const isActive = inst.id === activeId;
            return (
              <button
                key={inst.id}
                onClick={() => { void handleSelect(inst); }}
                style={{
                  display: 'flex', alignItems: 'flex-start', width: '100%',
                  background: isActive ? 'rgba(255,255,255,0.07)' : 'transparent',
                  border: 'none', color: '#fff', padding: '8px 12px',
                  cursor: isActive ? 'default' : 'pointer', textAlign: 'left',
                  flexDirection: 'column', gap: 2,
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <StatusDot proxyPath={`/api/engines/${inst.id}/health`} />
                  <span style={{ fontWeight: isActive ? 700 : 400, fontSize: '0.85rem' }}>
                    {inst.id}
                  </span>
                  {runtimeBadge(inst.runtime)}
                  {isActive && (
                    <span style={{ fontSize: '0.65rem', color: '#4caf50', marginLeft: 'auto' }}>
                      active
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.7rem', color: '#888', paddingLeft: 14 }}>
                  RE {inst.re_url} · PE {inst.pe_url}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
