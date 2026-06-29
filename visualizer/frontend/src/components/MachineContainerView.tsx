import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useVisualizerStore } from '../store';
import { PERCEPTUAL_DIM } from '../constants';
import OutputStreamVisualization from './OutputStreamVisualization';
import { MachineInterconnectionGraph } from './MachineInterconnectionGraph';
import { PerceptualLogViewer } from './PerceptualLogViewer';
import { MachinePESourcesPanel } from './MachinePESourcesPanel';
import { api } from '../api';
import { Machine } from '../types';
import {
  classifyMachine,
  DOMAINS,
  DOMAIN_ORDER,
  DomainId,
} from './machineDomains';

interface MachineContainerViewProps {
  selectedSequenceId: string | null;
}

// ─── Compact per-machine input/output strip ───────────────────────────────────

interface MachineInputsStripProps {
  machines: Machine[];
  universalVector: number[];
  currentMachineId: string | null;
  step: number;
}

const MachineInputsStrip: React.FC<MachineInputsStripProps> = ({
  machines,
  universalVector,
  currentMachineId,
  step,
}) => {
  const [expanded, setExpanded] = useState(false);
  const mapped = machines.filter(m => m.perceptualMapping);

  // Group machines by domain for rendering and counts.
  const byDomain = useMemo(() => {
    const groups = Object.fromEntries(DOMAIN_ORDER.map(d => [d, [] as { machine: Machine; isExternal: boolean }[]])) as Record<DomainId, { machine: Machine; isExternal: boolean }[]>;
    for (const m of mapped) {
      const cls = classifyMachine(m);
      groups[cls.domain].push({ machine: m, isExternal: cls.isExternal });
    }
    return groups;
  }, [mapped]);

  if (mapped.length === 0) return null;

  const activeCount = mapped.filter(m => {
    const { input } = m.perceptualMapping!;
    return universalVector.slice(input.offset, input.offset + input.length).some(v => v > 0);
  }).length;

  return (
    <div style={{
      background: 'rgba(15, 23, 42, 0.85)',
      borderBottom: '1px solid #334155',
      padding: '6px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
    }}>
      {/* Strip header (clickable to expand/collapse) */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '2px',
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
          width: '100%',
        }}
      >
        <span style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>
          Machine Inputs
        </span>
        <span style={{ fontSize: '9px', color: '#334155', fontFamily: 'monospace' }}>
          step {step}
        </span>
        <span style={{ fontSize: '9px', color: '#475569', fontFamily: 'monospace' }}>
          {mapped.length} machines{activeCount > 0 ? ` · ${activeCount} active` : ''}
        </span>
        <span style={{ fontSize: '9px', color: '#64748b', marginLeft: 'auto' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
      <div style={{
        maxHeight: '220px',
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        paddingRight: '4px',
        scrollbarWidth: 'thin',
        scrollbarColor: '#475569 #1e293b',
      }}>
      {/* Rows grouped by domain.  Empty groups skipped. */}
      {DOMAIN_ORDER.flatMap(domainId => {
        const group = byDomain[domainId];
        if (group.length === 0) return [];
        const def = DOMAINS[domainId];
        return [
          <div
            key={`hdr-${domainId}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 6px 2px 6px',
              marginTop: '4px',
              borderTop: `1px solid ${def.color}33`,
              borderBottom: `1px solid ${def.color}22`,
              background: def.fill,
            }}
          >
            <span style={{
              width: '8px', height: '8px', borderRadius: '2px',
              background: def.color, flexShrink: 0,
            }} />
            <span style={{
              fontSize: '9px',
              fontWeight: 700,
              color: def.color,
              textTransform: 'uppercase',
              letterSpacing: '1px',
            }}>{def.label}</span>
            <span style={{
              fontSize: '9px',
              color: '#475569',
              fontFamily: 'monospace',
            }}>{group.length}</span>
          </div>,
          ...group.map(({ machine: m, isExternal }) => {
        const { input, output } = m.perceptualMapping!;
        const inputVals = universalVector.slice(input.offset, input.offset + input.length);
        const outputVals = universalVector.slice(output.offset, output.offset + output.length);
        const isCurrent = m.id === currentMachineId;
        const hasSignal = inputVals.some(v => v > 0);
        const hasOutput = outputVals.some(v => v > 0);

        return (
          <div
            key={m.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: isCurrent ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
              borderLeft: isCurrent
                ? '2px solid #3b82f6'
                : `2px solid ${def.color}55`,
            }}
          >
            {/* External chip */}
            {isExternal && (
              <span
                title="External bridge (localAIStack)"
                style={{
                  fontSize: '8px',
                  fontWeight: 700,
                  color: '#fff',
                  background: '#a855f7',
                  padding: '1px 4px',
                  borderRadius: '2px',
                  flexShrink: 0,
                  fontFamily: 'monospace',
                  letterSpacing: '0.5px',
                }}
              >
                EXT
              </span>
            )}

            {/* Machine name */}
            <span style={{
              fontSize: '10px',
              fontWeight: isCurrent ? 700 : 400,
              color: isCurrent ? '#93c5fd' : '#64748b',
              width: isExternal ? '150px' : '180px',
              flexShrink: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'monospace',
            }}>
              {m.name}
            </span>

            {/* Input region tag */}
            <span style={{
              fontSize: '9px',
              color: '#475569',
              fontFamily: 'monospace',
              width: '58px',
              flexShrink: 0,
            }}>
              in[{input.offset}:{input.offset + input.length - 1}]
            </span>

            {/* Input value bars */}
            <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
              {inputVals.map((v, i) => (
                <div
                  key={i}
                  title={`[${input.offset + i}] = ${v.toFixed(3)}`}
                  style={{
                    width: '7px',
                    height: `${Math.max(2, Math.round(v * 14))}px`,
                    background: v > 0
                      ? `rgba(59, 130, 246, ${0.4 + v * 0.6})`
                      : '#1e293b',
                    borderRadius: '1px',
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>

            {/* Output region + bars (if any signal) */}
            {hasOutput && (
              <>
                <span style={{
                  fontSize: '9px',
                  color: '#334155',
                  fontFamily: 'monospace',
                  flexShrink: 0,
                }}>→</span>
                <span style={{
                  fontSize: '9px',
                  color: '#475569',
                  fontFamily: 'monospace',
                  width: '58px',
                  flexShrink: 0,
                }}>
                  out[{output.offset}:{output.offset + output.length - 1}]
                </span>
                <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
                  {outputVals.map((v, i) => (
                    <div
                      key={i}
                      title={`[${output.offset + i}] = ${v.toFixed(3)}`}
                      style={{
                        width: '7px',
                        height: `${Math.max(2, Math.round(v * 14))}px`,
                        background: v > 0
                          ? `rgba(244, 114, 182, ${0.4 + v * 0.6})`
                          : '#1e293b',
                        borderRadius: '1px',
                        flexShrink: 0,
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Signal indicator dot */}
            {hasSignal && (
              <div style={{
                width: '5px',
                height: '5px',
                borderRadius: '50%',
                background: '#3b82f6',
                boxShadow: '0 0 4px rgba(59, 130, 246, 0.8)',
                flexShrink: 0,
                marginLeft: 'auto',
              }} />
            )}
          </div>
        );
      })
        ];
      })}
      </div>
      )}
    </div>
  );
};

// ─── Main component ────────────────────────────────────────────────────────────

const MachineContainerView: React.FC<MachineContainerViewProps> = () => {
  const {
    currentOutputVectors,
    currentMachine,
    highlightedOutputId,
    machines,
    ws,
  } = useVisualizerStore();

  const [allMachines, setAllMachines] = useState(machines);

  // Universal Perceptual Space state — updated passively via WebSocket
  const [currentUniversalVector, setCurrentUniversalVector] = useState<number[]>(new Array(PERCEPTUAL_DIM).fill(0));
  const [currentStep, setCurrentStep] = useState(0);

  // Log viewer modal state
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);

  const fetchAllMachines = useCallback(async () => {
    try {
      const machinesData = await api.getMachines();
      setAllMachines(machinesData);
    } catch (error) {
      console.error('Error fetching machines:', error);
    }
  }, []);

  useEffect(() => { fetchAllMachines(); }, [fetchAllMachines]);

  useEffect(() => {
    window.addEventListener('re:engine-switched', fetchAllMachines);
    return () => window.removeEventListener('re:engine-switched', fetchAllMachines);
  }, [fetchAllMachines]);

  // Listen for perceptual space updates via WebSocket.
  // Depend on `ws` so we re-subscribe whenever the connection is (re)established.
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'perceptual-simulation-stepped') {
          const step = data.step;
          if (step?.perceptualSpace) {
            setCurrentUniversalVector(step.perceptualSpace);
            setCurrentStep(prev => prev + 1);
          }
        } else if (data.type === 'perceptual-simulation-reset') {
          setCurrentUniversalVector(new Array(PERCEPTUAL_DIM).fill(0));
          setCurrentStep(0);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws]);

  // Filter outputs to show only those from current machine's sequences
  const machineSequenceIds = currentMachine?.sequenceIds || [];
  const filteredOutputs = currentOutputVectors.filter(output => {
    if (output.metadata && typeof output.metadata === 'object' && 'sequenceId' in output.metadata) {
      return machineSequenceIds.includes(output.metadata.sequenceId as string);
    }
    return true;
  });

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#0a0a0a',
      position: 'relative'
    }}>
      {/* Main Content Row */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        overflow: 'hidden'
      }}>
        {/* Machine Container - Center */}
        <div style={{
          flex: 1,
          position: 'relative',
          background: '#0f0f0f',
          border: '3px solid #475569',
          borderRadius: '12px',
          margin: '10px',
          boxShadow: '0 0 30px rgba(59, 130, 246, 0.15), inset 0 0 50px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* Machine Header */}
          <div style={{
            padding: '12px 20px',
            background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
            borderBottom: '2px solid #475569',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <div style={{
                fontSize: '16px',
                fontWeight: '700',
                color: '#e2e8f0',
                marginBottom: '3px'
              }}>
                {currentMachine?.name || 'Critical Event Sequence Machine'}
              </div>
              <div style={{
                fontSize: '11px',
                color: '#64748b',
                fontFamily: 'monospace',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                Machine Interconnections
              </div>
            </div>

            {/* Logs */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={() => setIsLogViewerOpen(true)}
                style={{
                  padding: '6px 12px',
                  background: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  color: '#64748b',
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
                title="View perceptual logs"
              >
                📋 Logs
              </button>
            </div>
          </div>

          {/* PE Test Sources Panel */}
          {currentMachine && (
            <MachinePESourcesPanel machineId={currentMachine.id} />
          )}

          {/* Machine Inputs Strip */}
          <MachineInputsStrip
            machines={allMachines}
            universalVector={currentUniversalVector}
            currentMachineId={currentMachine?.id ?? null}
            step={currentStep}
          />

          {/* Content area */}
          <div style={{
            flex: 1,
            position: 'relative',
            background: 'radial-gradient(circle at center, #0f0f0f 0%, #000 100%)',
            overflow: 'hidden'
          }}>
            {/* Decorative grid */}
            <div style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `
                linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px)
              `,
              backgroundSize: '50px 50px',
              pointerEvents: 'none',
              zIndex: 0
            }} />

            <div style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              padding: '20px',
              overflowY: 'auto'
            }}>
              {currentMachine && (
                <div style={{ flex: 1, minHeight: '500px' }}>
                  <MachineInterconnectionGraph
                    currentMachineId={currentMachine.id}
                    machines={allMachines}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Output Stream - Right Side */}
        <OutputStreamVisualization
          outputVectors={filteredOutputs}
          maxVisible={10}
          highlightedOutputId={highlightedOutputId}
        />
      </div>

      {/* Perceptual Log Viewer */}
      <PerceptualLogViewer
        isOpen={isLogViewerOpen}
        onClose={() => setIsLogViewerOpen(false)}
      />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(0.9); }
        }
      `}</style>
    </div>
  );
};

export default MachineContainerView;
