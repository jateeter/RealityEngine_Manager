import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useVisualizerStore } from '../store';
import { useMachineSimulation, StepRecord, VisMachine } from '../hooks/useMachineSimulation';
import { MachineGraphView } from '../components/MachineGraphView';
import TobiasAISequencePulse from '../components/tobias/TobiasAISequencePulse';
import { classifyMachine, domainColor, DOMAINS, DOMAIN_ORDER, DomainId } from '../components/machineDomains';
import { PERCEPTUAL_DIM } from '../constants';

import './TobiasView.css';

// ---------------------------------------------------------------------------
// GraphNode — shape returned by /api/machine-graph
// ---------------------------------------------------------------------------
interface GraphNode {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, any>;
  inputMapping:  { offset: number; length: number };
  outputMapping: { offset: number; length: number };
}

// Parse "#rrggbb" → "r,g,b" for use inside rgba(...) fill strings.
function hexToRgbTriplet(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

// ---------------------------------------------------------------------------
// PerceptualSpaceBar
// Condensed canvas heatmap of the full global perceptual space.
// Machine input regions are color-coded and labeled.
// ---------------------------------------------------------------------------

interface PerceptualSpaceBarProps {
  perceptualSpace: number[];
  machines: VisMachine[];
  latestStep: number | null;
}

const PerceptualSpaceBar: React.FC<PerceptualSpaceBarProps> = ({
  perceptualSpace, machines, latestStep,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vizRef    = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const viz    = vizRef.current;
    if (!canvas || !viz) return;
    const W = viz.clientWidth;
    if (W <= 0) return;
    canvas.width = W;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const DIM = PERCEPTUAL_DIM;
    const H   = canvas.height;

    ctx.fillStyle = '#020609';
    ctx.fillRect(0, 0, W, H);

    // Pre-assign a domain-colored rgb triplet per perceptual-space index based on
    // which machine owns that region. Unowned regions fall back to slate.
    const DEFAULT_TRIPLET = hexToRgbTriplet(DOMAINS.general.color);
    const triplets = new Array<string>(DIM).fill(DEFAULT_TRIPLET);
    machines.forEach(m => {
      if (!m.inputRegion) return;
      const d = classifyMachine(m).domain;
      const triplet = hexToRgbTriplet(domainColor(d));
      const end = Math.min(DIM, m.inputRegion.offset + m.inputRegion.length);
      for (let j = m.inputRegion.offset; j < end; j++) triplets[j] = triplet;
    });

    const bw = W / DIM;
    for (let i = 0; i < DIM; i++) {
      const v = Math.max(0, Math.min(1, perceptualSpace[i] ?? 0));
      ctx.fillStyle = `rgba(${triplets[i]},${0.10 + v * 0.85})`;
      ctx.fillRect(i * bw, 0, Math.max(bw, 1), H);
    }

    // Region boundary markers
    const bounds = new Set<number>();
    machines.forEach(m => {
      if (m.inputRegion) {
        bounds.add(m.inputRegion.offset);
        bounds.add(m.inputRegion.offset + m.inputRegion.length);
      }
    });
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    for (const b of bounds) ctx.fillRect((b / DIM) * W, 0, 1, H);
  }, [perceptualSpace, machines]);

  // Redraw whenever data or layout changes
  useEffect(() => {
    const viz = vizRef.current;
    if (!viz) return;
    const ro = new ResizeObserver(draw);
    ro.observe(viz);
    draw();
    return () => ro.disconnect();
  }, [draw]);

  // Percentage-based region labels (no re-draw needed for layout)
  const regionLabels = useMemo(
    () => machines
      .filter(m => m.inputRegion)
      .map(m => ({
        id:     m.id,
        name:   m.name.replace(/^DC/, '').slice(0, 10),
        left:   (m.inputRegion!.offset / PERCEPTUAL_DIM) * 100,
        width:  (m.inputRegion!.length  / PERCEPTUAL_DIM) * 100,
        domain: classifyMachine(m).domain,
      })),
    [machines],
  );

  const hasData = perceptualSpace.some(v => v > 0);

  return (
    <div className="tobias-psbar">
      <div className="tobias-psbar-viz" ref={vizRef}>
        {/* Region labels (CSS percentage positioning) */}
        <div className="tobias-psbar-labels">
          {regionLabels.map(r => (
            <div
              key={r.id}
              className="tobias-psbar-region-label"
              style={{
                left:            `${r.left}%`,
                width:           `${r.width}%`,
                borderLeftColor: domainColor(r.domain),
              }}
              title={`${machines.find(m => m.id === r.id)?.name} · ${DOMAINS[r.domain].label}`}
            >
              {r.name}
            </div>
          ))}
          {!hasData && machines.length === 0 && (
            <span className="tobias-psbar-placeholder">load a demo or step the simulation</span>
          )}
        </div>
        <canvas ref={canvasRef} className="tobias-psbar-canvas" height={18} />
      </div>

      <div className="tobias-psbar-meta">
        <span className="tobias-psbar-meta-label">step</span>
        <span className="tobias-psbar-meta-value">
          {latestStep !== null ? latestStep : '—'}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// OutputDots — shared dot renderer for both collapsed and expanded views.
// ---------------------------------------------------------------------------

const OUTPUT_DOT_RGB = '240,62,138'; // --re-pink
const OUTPUT_DOT_MIN = 0.12;

const OutputDots: React.FC<{
  ov?: number[] | null;
  getTitle?: (i: number, v: number) => string;
}> = ({ ov, getTitle }) => (
  <>
    {ov && ov.length > 0
      ? ov.slice(0, 4).map((v, i) => (
          <div
            key={i}
            className="tobias-outbar-dot"
            style={{ background: `rgba(${OUTPUT_DOT_RGB},${Math.max(OUTPUT_DOT_MIN, Math.min(1, v))})` }}
            title={getTitle?.(i, v)}
          />
        ))
      : <div className="tobias-outbar-dot tobias-outbar-dot-nil" />
    }
  </>
);

// ---------------------------------------------------------------------------
// OutputHistoryBar
// Collapsed (default): single inline row per machine showing latest output dots.
// Expanded: scrolling step-history table (machines × steps).
// ---------------------------------------------------------------------------

interface OutputHistoryBarProps {
  stepHistory: StepRecord[];
  machines: VisMachine[];
  selectedMachineId: string | null;
}

const OutputHistoryBar: React.FC<OutputHistoryBarProps> = ({
  stepHistory, machines, selectedMachineId,
}) => {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest step on the right
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [stepHistory, expanded]);

  // Selected machine first, then up to 8 total
  const displayMachines = useMemo(() => {
    const ordered = selectedMachineId
      ? [
          ...machines.filter(m => m.id === selectedMachineId),
          ...machines.filter(m => m.id !== selectedMachineId),
        ]
      : machines;
    return ordered.slice(0, 6);
  }, [machines, selectedMachineId]);

  const latestStep = stepHistory[stepHistory.length - 1];

  return (
    <div className={`tobias-outbar${expanded ? ' expanded' : ''}`}>
      {/* Left column: toggle + "OUTPUT" label */}
      <div className="tobias-outbar-side">
        <button
          className="tobias-outbar-toggle"
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Collapse output bar' : 'Expand output history'}
        >
          {expanded ? '▼' : '▲'}
        </button>
        <span className="tobias-outbar-label">OUTPUT</span>
      </div>

      {/* Content */}
      <div className="tobias-outbar-content" ref={scrollRef}>

        {!expanded ? (
          /* ── Collapsed: inline machine summary ── */
          <div className="tobias-outbar-summary">
            {displayMachines.map(m => {
              const result = latestStep?.machineResults[m.id];
              const ov     = result?.outputVector;
              return (
                <div key={m.id} className="tobias-outbar-machine" title={m.name}>
                  <span className="tobias-outbar-mname">
                    {m.name.replace(/^DC/, '').slice(0, 10)}
                  </span>
                  <div className="tobias-outbar-dots">
                    <OutputDots ov={ov} />
                  </div>
                </div>
              );
            })}
            {stepHistory.length === 0 && (
              <span className="tobias-outbar-idle">awaiting simulation output…</span>
            )}
          </div>
        ) : (
          /* ── Expanded: step-history table ── */
          <div className="tobias-outbar-table">
            {/* Sticky machine-name column */}
            <div className="tobias-outbar-names">
              <div className="tobias-outbar-corner" />
              {displayMachines.map(m => (
                <div key={m.id} className="tobias-outbar-row-name" title={m.name}>
                  {m.name.replace(/^DC/, '').slice(0, 12)}
                </div>
              ))}
            </div>

            {/* Step columns, newest on the right */}
            {stepHistory.map(step => (
              <div key={step.stepNumber} className="tobias-outbar-stepcol">
                <div className="tobias-outbar-stepnum">{step.stepNumber}</div>
                {displayMachines.map(m => {
                  const result = step.machineResults[m.id];
                  const ov     = result?.outputVector;
                  return (
                    <div key={m.id} className="tobias-outbar-cell">
                      <OutputDots
                        ov={ov}
                        getTitle={(i, v) => `${m.name}[out${i}] = ${v.toFixed(3)} @ step ${step.stepNumber}`}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// TobiasView
// ---------------------------------------------------------------------------

/**
 * Tobias — Machine Visualization (D3 SVG — same graph as Machine Interconnect)
 *
 * Layout:
 *   header  (back button · title · step indicator · machine count)
 *   body (flex-row):
 *     sidebar (collapsible, LEFT) ← domain filters (counts from /api/machine-graph)
 *     sidebar-gutter              ← collapse toggle
 *     canvas-area (flex-1, flex-col):
 *       PerceptualSpaceBar  [INPUT STREAM]   — top  (~44px)
 *       canvas-center (flex-1):
 *         MachineGraphView (D3 SVG — same component as Machine Interconnect)
 *       TobiasAISequencePulse                — below graph
 *       OutputHistoryBar    [OUTPUT STREAM]  — bottom (32px collapsed / 148px expanded)
 */
const TobiasView: React.FC = () => {
  const { setCurrentView, hoveredDomainId, selectedDomains } = useVisualizerStore();

  // Step history + live simulation state from the shared hook.
  // We use machines only for step-based display (OutputHistoryBar, TobiasAISequencePulse).
  const {
    machines,
    selectedMachineId,
    stepHistory,
  } = useMachineSimulation();

  // ── Machine graph data (same source as MachineGraphView / Machine Interconnect) ──
  // Fetching from /api/machine-graph gives us full metadata including `category`,
  // so domain classification matches the Machine Interconnect view exactly.
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  useEffect(() => {
    fetch('/api/machine-graph')
      .then(r => r.json())
      .then(data => { if (Array.isArray(data.nodes)) setGraphNodes(data.nodes); })
      .catch(() => {});
  }, []);

  // Map graphNodes → VisMachine shape for PerceptualSpaceBar (needs inputRegion).
  const graphAsMachines = useMemo((): VisMachine[] =>
    graphNodes.map(n => ({
      id:          n.id,
      name:        n.name,
      description: n.description,
      metadata:    n.metadata,
      isExample:   false,
      sequences:   [],
      status:      'idle' as const,
      justFired:   false,
      hasInitialMatch: false,
      inputRegion:  n.inputMapping,
      outputRegion: n.outputMapping,
    })),
    [graphNodes],
  );

  // Domain classification + counts from graphNodes — single pass, correct metadata.
  const { domainById, domainCounts } = useMemo(() => {
    const byId   = new Map(graphNodes.map(n => [n.id, classifyMachine(n).domain]));
    const counts = Object.fromEntries(DOMAIN_ORDER.map(d => [d, 0])) as Record<DomainId, number>;
    for (const n of graphNodes) counts[byId.get(n.id) ?? 'general']++;
    return { domainById: byId, domainCounts: counts };
  }, [graphNodes]);

  const allDomainsSelected = selectedDomains.length === DOMAIN_ORDER.length;

  // PerceptualSpaceBar uses graphAsMachines filtered by domain for correct region coloring.
  const filteredGraphMachines = useMemo(() => {
    if (allDomainsSelected) return graphAsMachines;
    const sel = new Set(selectedDomains);
    return graphAsMachines.filter(m => sel.has(domainById.get(m.id) ?? 'general'));
  }, [graphAsMachines, selectedDomains, allDomainsSelected, domainById]);

  // OutputHistoryBar uses useMachineSimulation machines (has live step state).
  const filteredMachines = useMemo(() => {
    if (allDomainsSelected) return machines;
    const sel = new Set(selectedDomains);
    return machines.filter(m => sel.has(domainById.get(m.id) ?? 'general'));
  }, [machines, selectedDomains, allDomainsSelected, domainById]);

  const latestStep       = stepHistory[stepHistory.length - 1];
  const latestStepNumber = latestStep?.stepNumber ?? null;
  const perceptualSpace  = latestStep?.perceptualSpace ?? [];

  const totalMachines    = graphNodes.length;
  const filteredTotal    = allDomainsSelected
    ? totalMachines
    : selectedDomains.reduce((sum, d) => sum + (domainCounts[d] ?? 0), 0);

  return (
    <div className="tobias-view">

      {/* ── Header ────────────────────────────────────────────── */}
      <header className="tobias-header">
        <div className="tobias-header-left">
          <button
            className="tobias-back-button"
            onClick={() => setCurrentView('selection')}
            title="Back to Machine Selection"
          >
            ← Back
          </button>
          <div className="tobias-title-group">
            <h1 className="tobias-title">🔮 <span className="tobias-title-accent">Tobias</span></h1>
            <p className="tobias-subtitle">D3 force graph · machine visualization</p>
          </div>
        </div>

        <div className="tobias-header-right">
          {hoveredDomainId && (
            <span className="tobias-domain-hover-label" style={{ borderColor: DOMAINS[hoveredDomainId].color, color: DOMAINS[hoveredDomainId].color }}>
              <span className="tobias-domain-hover-dot" style={{ background: DOMAINS[hoveredDomainId].color }} />
              {DOMAINS[hoveredDomainId].label}
            </span>
          )}
          {latestStepNumber !== null && (
            <span className="tobias-step-indicator">
              step <strong>{latestStepNumber}</strong>
            </span>
          )}
          {selectedMachineId && (
            <span className="tobias-selected-label">
              <strong>{selectedMachineId}</strong>
            </span>
          )}
          <span className="tobias-machine-count">
            {filteredTotal}/{totalMachines} machine
            {totalMachines !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      {/* ── Body ──────────────────────────────────────────────── */}
      <div className="tobias-body">

        {/* ── Canvas column ────────────────────────────────────── */}
        <div className="tobias-canvas-area">

          {/* TOP: condensed global perceptual input stream */}
          <PerceptualSpaceBar
            perceptualSpace={perceptualSpace}
            machines={filteredGraphMachines}
            latestStep={latestStepNumber}
          />

          {/* CENTER: D3 SVG — same MachineGraphView as Machine Interconnect */}
          <div className="tobias-canvas-center">
            <MachineGraphView />
          </div>

          {/* BELOW GRAPH: AI sequence-fire pulse readout (localAI observability) */}
          <TobiasAISequencePulse
            stepHistory={stepHistory}
            machines={machines}
          />

          {/* BOTTOM: condensed output stream with history expansion */}
          <OutputHistoryBar
            stepHistory={stepHistory}
            machines={filteredMachines}
            selectedMachineId={selectedMachineId}
          />

        </div>
      </div>

    </div>
  );
};

export default TobiasView;
