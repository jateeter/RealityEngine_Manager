import React from 'react';
import { useVisualizerStore } from '../store';
import { PETestSource } from '../types';

interface MachinePESourcesPanelProps {
  machineId: string;
}

export const MachinePESourcesPanel: React.FC<MachinePESourcesPanelProps> = ({ machineId }) => {
  const { peSources, togglePeSource, setAllPeSourcesActive } = useVisualizerStore();

  const sources = peSources.filter(
    (s): s is PETestSource => s.type === 'test' && s.machineId === machineId
  );

  if (sources.length === 0) return null;

  const allOn  = sources.every(s => s.active);
  const allOff = sources.every(s => !s.active);
  const anyOn  = sources.some(s => s.active);

  return (
    <div style={{
      padding: '8px 16px',
      background: 'rgba(15, 23, 42, 0.9)',
      borderBottom: '1px solid #1e293b',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      flexWrap: 'wrap',
      minHeight: '36px',
    }}>
      {/* Label */}
      <span style={{
        fontSize: '10px',
        fontWeight: 700,
        color: '#64748b',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        PE Sources
      </span>

      {/* Bulk controls */}
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
        <button
          onClick={() => setAllPeSourcesActive(true)}
          disabled={allOn}
          title="Enable all test sources"
          style={{
            padding: '2px 8px',
            fontSize: '10px',
            fontWeight: 600,
            background: allOn ? '#1e293b' : '#166534',
            color: allOn ? '#475569' : '#4ade80',
            border: `1px solid ${allOn ? '#334155' : '#166534'}`,
            borderRadius: '4px',
            cursor: allOn ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          All On
        </button>
        <button
          onClick={() => setAllPeSourcesActive(false)}
          disabled={allOff}
          title="Disable all test sources"
          style={{
            padding: '2px 8px',
            fontSize: '10px',
            fontWeight: 600,
            background: allOff ? '#1e293b' : '#3b1f1f',
            color: allOff ? '#475569' : '#f87171',
            border: `1px solid ${allOff ? '#334155' : '#7f1d1d'}`,
            borderRadius: '4px',
            cursor: allOff ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          All Off
        </button>
      </div>

      {/* Divider */}
      <div style={{ width: '1px', height: '20px', background: '#1e293b', flexShrink: 0 }} />

      {/* Per-source toggles */}
      <div style={{
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
        flex: 1,
        alignItems: 'center',
      }}>
        {sources.map(src => (
          <button
            key={src.id}
            onClick={() => togglePeSource(src.id, !src.active)}
            title={`${src.active ? 'Disable' : 'Enable'}: ${src.name}`}
            style={{
              padding: '2px 8px',
              fontSize: '10px',
              fontWeight: 500,
              background: src.active ? 'rgba(22, 101, 52, 0.5)' : 'rgba(30, 41, 59, 0.6)',
              color: src.active ? '#4ade80' : '#64748b',
              border: `1px solid ${src.active ? '#166534' : '#334155'}`,
              borderRadius: '10px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              maxWidth: '160px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              transition: 'background 0.15s, color 0.15s, border-color 0.15s',
            }}
          >
            <span style={{
              display: 'inline-block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: src.active ? '#4ade80' : '#475569',
              marginRight: '5px',
              verticalAlign: 'middle',
              boxShadow: src.active ? '0 0 4px rgba(74, 222, 128, 0.7)' : 'none',
              transition: 'background 0.15s, box-shadow 0.15s',
            }} />
            {src.name}
          </button>
        ))}
      </div>

      {/* Active count indicator */}
      <span style={{
        fontSize: '10px',
        color: anyOn ? '#4ade80' : '#475569',
        fontFamily: 'monospace',
        flexShrink: 0,
      }}>
        {sources.filter(s => s.active).length}/{sources.length}
      </span>
    </div>
  );
};
