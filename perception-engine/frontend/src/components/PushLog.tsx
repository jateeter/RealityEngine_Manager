import { useState } from 'react';
import type { PushLogEntry } from '../types.js';

interface Props {
  entries: PushLogEntry[];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function summarize(step: Record<string, unknown> | undefined): string {
  if (!step) return 'no step data';
  const machineResults = step['machineResults'] as Record<string, { outputVector: number[] | null; machineName?: string }> | undefined;
  if (!machineResults) return 'processed';

  const fired = Object.values(machineResults)
    .filter(r => r.outputVector !== null)
    .map(r => r.machineName ?? 'machine');

  if (fired.length === 0) return 'no outputs';
  return fired.slice(0, 4).join(', ') + (fired.length > 4 ? ` +${fired.length - 4} more` : '');
}

function EntryRow({ entry }: { entry: PushLogEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      padding: '5px 8px',
      borderBottom: '1px solid #1e293b',
      fontSize: 12,
      cursor: 'pointer',
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: entry.success ? '#22c55e' : '#ef4444',
        }} />
        <span style={{ color: '#64748b' }}>{formatTime(entry.timestamp)}</span>
        <span style={{ color: '#94a3b8' }}>step {entry.globalStep}</span>
        <span style={{ flex: 1, color: entry.success ? '#e2e8f0' : '#f87171' }}>
          {entry.error ?? summarize(entry.step)}
        </span>
        <span style={{ color: '#475569' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && entry.step && (
        <pre style={{
          marginTop: 6, padding: 6, borderRadius: 4,
          background: '#0a0a14', color: '#94a3b8',
          fontSize: 10, overflowX: 'auto', whiteSpace: 'pre-wrap',
        }}>
          {JSON.stringify(entry.step, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function PushLog({ entries }: Props) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      border: '1px solid #1e293b', borderRadius: 6, overflow: 'hidden',
      background: '#050a14',
    }}>
      <div style={{
        padding: '6px 10px', borderBottom: '1px solid #1e293b',
        fontSize: 11, color: '#64748b', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: 1, flexShrink: 0,
      }}>
        Push Log (last {entries.length})
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {entries.length === 0 && (
          <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
            No pushes yet
          </div>
        )}
        {entries.map(entry => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
