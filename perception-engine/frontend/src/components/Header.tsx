import React from 'react';
import type { MatchAlgorithm } from '../types.js';

interface Props {
  step: number;
  isAutoRunning: boolean;
  autoIntervalMs: number;
  matchAlgorithm: MatchAlgorithm;
  onPush: () => void;
  onAutoStart: () => void;
  onAutoStop: () => void;
  onReset: () => void;
  onIntervalChange: (ms: number) => void;
  onMatchAlgorithmChange: (algo: MatchAlgorithm) => void;
}

// Slider bounds for the Auto Push flow-rate control.  0 ms deliberately
// allowed so operators can exercise fully-asynchronous PE push behaviour
// (timer fires with no delay between iterations).  100 ms step gives 0.1 s
// resolution across the 0–10 s range.
const INTERVAL_MIN_MS = 0;
const INTERVAL_MAX_MS = 10_000;
const INTERVAL_STEP_MS = 100;

const MATCH_OPTIONS: { label: string; value: MatchAlgorithm; description: string }[] = [
  { label: '≥ GTE', value: 'gte', description: 'Greater-than-or-equal threshold state' },
  { label: '= Equal', value: 'equals', description: 'Strict equality' },
];

const btn: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 4,
  border: '1px solid #334155',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  background: '#1e293b',
  color: '#e2e8f0',
};

export default function Header({
  step, isAutoRunning, autoIntervalMs, matchAlgorithm,
  onPush, onAutoStart, onAutoStop, onReset, onIntervalChange, onMatchAlgorithmChange,
}: Props) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '8px 16px', background: '#0f172a',
      borderBottom: '1px solid #1e293b', flexShrink: 0,
    }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#7dd3fc' }}>PERCEPTION ENGINE</div>
        <div style={{ fontSize: 11, color: '#64748b' }}>Reality source for Reality Engine</div>
      </div>
      <div style={{ marginLeft: 8, color: '#94a3b8', fontSize: 13 }}>
        Step: <strong style={{ color: '#e2e8f0' }}>{step}</strong>
      </div>

      {/* Match algorithm selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Match
        </span>
        <div style={{ display: 'flex', borderRadius: 4, border: '1px solid #334155', overflow: 'hidden' }}>
          {MATCH_OPTIONS.map(opt => (
            <button
              key={opt.value}
              title={opt.description}
              onClick={() => onMatchAlgorithmChange(opt.value)}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                border: 'none',
                borderRight: '1px solid #334155',
                background: matchAlgorithm === opt.value ? '#1d4ed8' : '#1e293b',
                color: matchAlgorithm === opt.value ? '#bfdbfe' : '#64748b',
                transition: 'background 0.1s',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button style={btn} onClick={onPush}>▶ Push Once</button>

        {/* Auto Push flow-rate slider — replaces the old dropdown.  Sits
            between Push Once and Auto Push so the rate is visible next to
            the button that consumes it.  0 s = fully async PE pushes. */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '3px 10px',
            borderRadius: 4,
            border: '1px solid #334155',
            background: '#0f172a',
          }}
          title={
            autoIntervalMs === 0
              ? 'No delay between Auto Push iterations (fully asynchronous)'
              : `${(autoIntervalMs / 1000).toFixed(1)} s between Auto Push iterations`
          }
        >
          <span style={{
            fontSize: 10, color: '#64748b', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}>Delay</span>
          <input
            type="range"
            min={INTERVAL_MIN_MS}
            max={INTERVAL_MAX_MS}
            step={INTERVAL_STEP_MS}
            value={autoIntervalMs}
            onChange={e => onIntervalChange(Number(e.target.value))}
            style={{ width: 120, accentColor: '#38bdf8', cursor: 'pointer' }}
          />
          <span style={{
            fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
            color: '#7dd3fc', minWidth: 42, textAlign: 'right',
          }}>
            {(autoIntervalMs / 1000).toFixed(1)} s
          </span>
        </div>

        {isAutoRunning ? (
          <button style={{ ...btn, background: '#7f1d1d', borderColor: '#991b1b', color: '#fca5a5' }} onClick={onAutoStop}>
            ■ Stop Auto
          </button>
        ) : (
          <button style={{ ...btn, background: '#14532d', borderColor: '#166534', color: '#86efac' }} onClick={onAutoStart}>
            ⏱ Auto Push
          </button>
        )}

        <button style={{ ...btn, color: '#94a3b8' }} onClick={onReset}>↺ Reset</button>
      </div>
    </div>
  );
}
