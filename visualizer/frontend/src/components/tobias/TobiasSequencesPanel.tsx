import React, { useState, useCallback, useMemo } from 'react';
import type { VisMachine, StepRecord } from '../../hooks/useMachineSimulation';
import { api } from '../../api';
import './TobiasSequencesPanel.css';
import { PERCEPTUAL_DIM } from '../../constants';

// ---------------------------------------------------------------------------
// Vector generation helpers
// ---------------------------------------------------------------------------

function generateVectors(
  mode: 'algorithmic' | 'random',
  pattern: string,
  count: number,
  region: { offset: number; length: number },
): number[][] {
  const DIM = PERCEPTUAL_DIM;
  const { offset, length } = region;
  const end = Math.min(offset + length, DIM);

  return Array.from({ length: count }, (_, step) => {
    const vec = new Array(DIM).fill(0);
    const t = step / Math.max(1, count - 1);

    for (let i = offset; i < end; i++) {
      const d = (i - offset) / Math.max(1, length - 1);
      if (mode === 'random') {
        vec[i] = Math.random();
      } else {
        switch (pattern) {
          case 'sine-wave':
            vec[i] = Math.sin(t * Math.PI * 6 + d * Math.PI * 2) * 0.5 + 0.5;
            break;
          case 'square-wave':
            vec[i] = (Math.floor(t * 8 + d * 2) % 2 === 0) ? 0.9 : 0.1;
            break;
          case 'sawtooth':
            vec[i] = (t * 4 + d * 0.5) % 1;
            break;
          case 'linear-ramp':
            vec[i] = t;
            break;
          case 'exponential':
            vec[i] = Math.min(1, Math.pow(t * 1.5, 1.5 + d));
            break;
          case 'perlin-noise':
            vec[i] = Math.abs(Math.sin(t * 11.3 + d * 6.7) * Math.cos(t * 7.1 - d * 4.3));
            break;
          case 'fibonacci':
            vec[i] = ((step % 13) / 13 + d * 0.4) % 1;
            break;
          default:
            vec[i] = Math.random();
        }
      }
    }
    return vec;
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TobiasSequencesPanelProps {
  isOpen: boolean;
  onClose: () => void;
  machines: VisMachine[];
  stepHistory: StepRecord[];
}

const PATTERNS = [
  { value: 'sine-wave',    label: 'Sine Wave'    },
  { value: 'square-wave',  label: 'Square Wave'  },
  { value: 'sawtooth',     label: 'Sawtooth'     },
  { value: 'perlin-noise', label: 'Perlin Noise' },
  { value: 'fibonacci',    label: 'Fibonacci'    },
  { value: 'linear-ramp',  label: 'Linear Ramp'  },
  { value: 'exponential',  label: 'Exponential'  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TobiasSequencesPanel: React.FC<TobiasSequencesPanelProps> = ({
  isOpen, onClose, machines, stepHistory,
}) => {
  const [tab, setTab] = useState<'input' | 'output'>('input');

  // Input/generate state
  const [genMode, setGenMode]       = useState<'algorithmic' | 'random'>('algorithmic');
  const [pattern, setPattern]       = useState('sine-wave');
  const [vecCount, setVecCount]     = useState(100);
  const [regOffset, setRegOffset]   = useState(0);
  const [regLength, setRegLength]   = useState(PERCEPTUAL_DIM);
  const [isLoading, setIsLoading]   = useState(false);
  const [loadStatus, setLoadStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  // Output filter
  const [outputMachineId, setOutputMachineId] = useState<string>('');

  const effectiveLength = Math.min(regLength, PERCEPTUAL_DIM - regOffset);

  const handleGenerate = useCallback(async () => {
    setIsLoading(true);
    setLoadStatus(null);
    try {
      const region  = { offset: regOffset, length: effectiveLength };
      const vectors = generateVectors(genMode, pattern, vecCount, region);
      const CHUNK   = 50;
      for (let i = 0; i < vectors.length; i += CHUNK) {
        await api.appendSequenceChunk({
          vectors:     vectors.slice(i, i + CHUNK),
          reset:       i === 0,
          inputRegion: region,
        });
      }
      await api.commitSequenceConfig();
      setLoadStatus({ ok: true, msg: `✓ ${vectors.length} vectors loaded (region [${region.offset}:${region.offset + region.length - 1}])` });
    } catch (err) {
      console.error('Failed to load sequence:', err);
      setLoadStatus({ ok: false, msg: '✗ Failed to load sequence — see console for details' });
    } finally {
      setIsLoading(false);
    }
  }, [genMode, pattern, vecCount, regOffset, effectiveLength]);

  const displayOutputMachines = useMemo(
    () => outputMachineId ? machines.filter(m => m.id === outputMachineId) : machines,
    [machines, outputMachineId],
  );

  // Last 20 steps for output tab
  const recentSteps = useMemo(() => stepHistory.slice(-20), [stepHistory]);

  if (!isOpen) return null;

  return (
    <div className="tsp-overlay" onClick={onClose}>
      <div className="tsp-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="tsp-header">
          <div className="tsp-title">
            <span className="tsp-title-icon">📑</span>
            <div>
              <div className="tsp-title-main">Sequences</div>
              <div className="tsp-title-sub">
                Manage input perception stream · Review machine output streams
              </div>
            </div>
          </div>
          <button className="tsp-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* Tabs */}
        <div className="tsp-tabs">
          <button
            className={`tsp-tab${tab === 'input' ? ' active' : ''}`}
            onClick={() => setTab('input')}
          >
            Input Stream
          </button>
          <button
            className={`tsp-tab${tab === 'output' ? ' active' : ''}`}
            onClick={() => setTab('output')}
          >
            Output Streams
            {stepHistory.length > 0 && (
              <span className="tsp-tab-badge">{stepHistory.length}</span>
            )}
          </button>
        </div>

        {/* Body */}
        <div className="tsp-body">

          {/* ── Input Stream ──────────────────────────────────────── */}
          {tab === 'input' && (
            <div className="tsp-content">
              <p className="tsp-desc">
                Generate a vector sequence and load it into the perceptual space simulator.
                The sequence drives all machine inputs via the perceptual region specified.
              </p>

              {/* Mode toggle */}
              <div className="tsp-mode-row">
                <button
                  className={`tsp-mode-btn${genMode === 'algorithmic' ? ' active' : ''}`}
                  onClick={() => setGenMode('algorithmic')}
                >
                  🔢 Algorithmic
                </button>
                <button
                  className={`tsp-mode-btn${genMode === 'random' ? ' active' : ''}`}
                  onClick={() => setGenMode('random')}
                >
                  🎲 Random
                </button>
              </div>

              {/* Pattern selector (algorithmic only) */}
              {genMode === 'algorithmic' && (
                <div className="tsp-field">
                  <label className="tsp-label">Pattern</label>
                  <select
                    className="tsp-select"
                    value={pattern}
                    onChange={e => setPattern(e.target.value)}
                  >
                    {PATTERNS.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Count */}
              <div className="tsp-field">
                <label className="tsp-label">Vector Count</label>
                <input
                  className="tsp-input"
                  type="number"
                  min={1}
                  max={1000}
                  value={vecCount}
                  onChange={e => setVecCount(Number(e.target.value))}
                />
              </div>

              {/* Region */}
              <div className="tsp-field-row">
                <div className="tsp-field">
                  <label className="tsp-label">Region Offset</label>
                  <input
                    className="tsp-input"
                    type="number"
                    min={0}
                    max={255}
                    value={regOffset}
                    onChange={e => setRegOffset(Number(e.target.value))}
                  />
                </div>
                <div className="tsp-field">
                  <label className="tsp-label">Region Length</label>
                  <input
                    className="tsp-input"
                    type="number"
                    min={1}
                    max={PERCEPTUAL_DIM - regOffset}
                    value={regLength}
                    onChange={e => setRegLength(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="tsp-region-note">
                Target region: <code>[{regOffset}:{regOffset + effectiveLength}]</code>
                {' — '}{effectiveLength} of {PERCEPTUAL_DIM} dimensions
              </div>

              {/* Quick-select machine input region */}
              {machines.some(m => m.inputRegion) && (
                <div className="tsp-quick">
                  <span className="tsp-quick-label">Machine regions:</span>
                  {machines.filter(m => m.inputRegion).map(m => (
                    <button
                      key={m.id}
                      className="tsp-quick-btn"
                      title={`${m.name}: [${m.inputRegion!.offset}:${m.inputRegion!.offset + m.inputRegion!.length}]`}
                      onClick={() => {
                        setRegOffset(m.inputRegion!.offset);
                        setRegLength(m.inputRegion!.length);
                      }}
                    >
                      {m.name.replace(/^DC/, '').slice(0, 12)}
                    </button>
                  ))}
                </div>
              )}

              {/* Generate */}
              <button
                className="tsp-generate-btn"
                onClick={handleGenerate}
                disabled={isLoading}
              >
                {isLoading ? '⟳ Loading…' : '▶ Generate & Load into Simulation'}
              </button>

              {loadStatus && (
                <div className={`tsp-status${loadStatus.ok ? ' ok' : ' err'}`}>
                  {loadStatus.msg}
                </div>
              )}
            </div>
          )}

          {/* ── Output Streams ────────────────────────────────────── */}
          {tab === 'output' && (
            <div className="tsp-content">
              <div className="tsp-output-controls">
                <span className="tsp-desc tsp-desc-inline">
                  Last {recentSteps.length} steps
                </span>
                <select
                  className="tsp-select"
                  value={outputMachineId}
                  onChange={e => setOutputMachineId(e.target.value)}
                >
                  <option value="">All machines</option>
                  {machines.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>

              {recentSteps.length === 0 ? (
                <div className="tsp-empty">
                  <div className="tsp-empty-icon">📊</div>
                  <div>No output history yet. Step the simulation to generate data.</div>
                </div>
              ) : (
                <div className="tsp-output-grid">
                  {displayOutputMachines.map(m => (
                    <div key={m.id} className="tsp-output-row">
                      <div className="tsp-output-mname" title={m.name}>
                        <span className="tsp-output-mname-text">{m.name}</span>
                        {m.outputRegion && (
                          <span className="tsp-output-region">
                            [{m.outputRegion.offset}:{m.outputRegion.offset + m.outputRegion.length}]
                          </span>
                        )}
                      </div>
                      <div className="tsp-output-steps">
                        {recentSteps.map(step => {
                          const result = step.machineResults[m.id];
                          const ov     = result?.outputVector;
                          return (
                            <div key={step.stepNumber} className="tsp-output-step">
                              <div className="tsp-output-stepnum">{step.stepNumber}</div>
                              <div className="tsp-output-dots">
                                {ov && ov.length > 0
                                  ? ov.slice(0, 4).map((v, i) => (
                                      <div
                                        key={i}
                                        className="tsp-output-dot"
                                        style={{
                                          background: `rgba(168,85,247,${Math.max(0.08, Math.min(1, v))})`,
                                        }}
                                        title={`${m.name}[out${i}] = ${v.toFixed(3)} @ step ${step.stepNumber}`}
                                      />
                                    ))
                                  : <div className="tsp-output-dot tsp-output-dot-nil" />
                                }
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
