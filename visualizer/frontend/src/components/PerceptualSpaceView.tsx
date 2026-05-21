/**
 * PerceptualSpaceView - Visualization of the perceptual space
 *
 * Shows active regions, machine I/O mappings, and current values
 */

import React, { useEffect, useState } from 'react';
import { useVisualizerStore } from '../store';
import './PerceptualSpaceView.css';

interface PerceptualSpaceState {
  isRunning: boolean;
  currentStep: number;
  config: any;
  perceptualSpace: number[];
  machines: Array<{
    id: string;
    name: string;
    perceptualMapping: {
      input: { offset: number; length: number };
      output: { offset: number; length: number };
      bitsPerElement?: number;
    };
    severity?: string;
  }>;
}

interface ActiveRegion {
  offset: number;
  length: number;
  machineId: string;
  type: 'input' | 'output';
}

export const PerceptualSpaceView: React.FC = () => {
  const [state, setState] = useState<PerceptualSpaceState | null>(null);
  const [activeRegions, setActiveRegions] = useState<ActiveRegion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const ws = useVisualizerStore(state => state.ws);

  // Fetch initial state
  useEffect(() => {
    fetchState();
  }, []);

  const fetchState = async () => {
    try {
      const response = await fetch('/api/perceptual-simulation/state');
      const result = await response.json();

      if (result.success || result.state) {
        setState(result.state);
        setError(null);
      } else {
        setError(result.error || 'Failed to load state');
      }
    } catch (err: any) {
      setError(`Error fetching state: ${err.message}`);
    }
  };

  // Listen for WebSocket updates from the store's shared connection
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);

      if (data.type === 'perceptual-simulation-stepped') {
        const step = data.step;
        setState(prev => prev ? {
          ...prev,
          currentStep: step.stepNumber,
          perceptualSpace: step.perceptualSpace
        } : null);
        setActiveRegions(step.activeRegions || []);
      } else if (data.type === 'perceptual-simulation-reset') {
        fetchState();
        setActiveRegions([]);
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => {
      ws.removeEventListener('message', handleMessage);
    };
  }, [ws]);

  if (error) {
    return (
      <div className="perceptual-space-view error">
        <div className="error-message">{error}</div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="perceptual-space-view loading">
        <div>Loading...</div>
      </div>
    );
  }

  // Group the perceptual space into blocks of 16 for visualization
  const blockSize = 16;
  const numBlocks = Math.ceil(state.perceptualSpace.length / blockSize);

  // Helper to check if a dimension is in an active region
  const isInActiveRegion = (index: number): 'input' | 'output' | null => {
    for (const region of activeRegions) {
      if (index >= region.offset && index < region.offset + region.length) {
        return region.type;
      }
    }
    return null;
  };

  // Helper to get machine name + cell-width hint for a region.  The cell
  // width comes from `perceptualMapping.bitsPerElement` (Option A1 narrow-
  // cell declaration) so an operator can see, at the cell granularity,
  // whether the slot is a 1-bit boolean, 2-bit ordinal, etc.  Falls back
  // to a single name string when no bpe is declared.
  const getMachineForDimension = (
    index: number
  ): { name: string; bitsPerElement?: number; severity?: string } | null => {
    if (!state.machines) return null;

    for (const machine of state.machines) {
      const { input, output, bitsPerElement } = machine.perceptualMapping;
      if (index >= input.offset && index < input.offset + input.length) {
        return { name: `${machine.name} (In)`, bitsPerElement, severity: machine.severity };
      }
      if (index >= output.offset && index < output.offset + output.length) {
        return { name: `${machine.name} (Out)`, bitsPerElement, severity: machine.severity };
      }
    }
    return null;
  };

  return (
    <div className="perceptual-space-view">
      <button
        className="space-toggle"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="space-toggle-label">Machine Inputs</span>
        <span className="space-toggle-meta">
          {state.isRunning && <span className="running-indicator">Running</span>}
          <span>Step: {state.currentStep}</span>
        </span>
        <span className="space-toggle-icon">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <>
          <div className="space-grid">
            {Array.from({ length: numBlocks }).map((_, blockIndex) => {
              const startIdx = blockIndex * blockSize;
              const endIdx = Math.min(startIdx + blockSize, state.perceptualSpace.length);
              const blockValues = state.perceptualSpace.slice(startIdx, endIdx);

              return (
                <div key={blockIndex} className="space-block">
                  <div className="block-header">
                    <span>[{startIdx}:{endIdx}]</span>
                  </div>
                  <div className="block-cells">
                    {blockValues.map((value, cellIndex) => {
                      const globalIndex = startIdx + cellIndex;
                      const activeType = isInActiveRegion(globalIndex);
                      const machineInfo = getMachineForDimension(globalIndex);
                      // Title surfaces the cell width + severity so an operator
                      // can audit slot-level encoding while inspecting values.
                      const bpeStr = machineInfo?.bitsPerElement
                        ? `\n${machineInfo.bitsPerElement}-bit cell`
                        : '';
                      const sevStr = machineInfo?.severity
                        ? `\nSeverity: ${machineInfo.severity}`
                        : '';

                      return (
                        <div
                          key={cellIndex}
                          className={`space-cell ${activeType ? `active-${activeType}` : ''}${machineInfo?.severity === 'life-safety' ? ' severity-life-safety' : ''}`}
                          title={`[${globalIndex}] = ${value.toFixed(2)}${machineInfo ? `\n${machineInfo.name}` : ''}${bpeStr}${sevStr}`}
                        >
                          <div className="cell-index">{globalIndex}</div>
                          <div className="cell-value">{value.toFixed(1)}</div>
                          {machineInfo && (
                            <div className="cell-machine">{machineInfo.name.substring(0, 10)}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-legend">
            <div className="legend-item">
              <div className="legend-box active-input"></div>
              <span>Input Region</span>
            </div>
            <div className="legend-item">
              <div className="legend-box active-output"></div>
              <span>Output Region</span>
            </div>
            <div className="legend-item">
              <div className="legend-box"></div>
              <span>Inactive</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
