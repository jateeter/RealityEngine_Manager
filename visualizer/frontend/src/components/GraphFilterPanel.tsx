import { useVisualizerStore } from '../store';
import {
  ALL_FILTER_NODE_TYPES,
  FILTER_NODE_TYPE_LABELS,
} from './graphFilters';
import { useTheme } from '../contexts/ThemeContext';

export interface SemanticLaneOption {
  key: string;
  label: string;
}

interface Props {
  availableSemanticLanes: SemanticLaneOption[];
  visibleNodeCount: number;
  totalNodeCount: number;
}

export function GraphFilterPanel({
  availableSemanticLanes,
  visibleNodeCount,
  totalNodeCount,
}: Props) {
  const graphFilters       = useVisualizerStore(s => s.graphFilters);
  const toggleNodeType     = useVisualizerStore(s => s.toggleNodeType);
  const setPortalFocus     = useVisualizerStore(s => s.setPortalFocus);
  const setMqttFocus       = useVisualizerStore(s => s.setMqttFocus);
  const toggleSemanticLane = useVisualizerStore(s => s.toggleSemanticLane);
  const resetGraphFilters  = useVisualizerStore(s => s.resetGraphFilters);
  const { tokens: themeTokens } = useTheme();

  const activeFilterCount = (
    (graphFilters.enabledNodeTypes.size < ALL_FILTER_NODE_TYPES.length ? 1 : 0) +
    (graphFilters.portalFocusActive ? 1 : 0) +
    (graphFilters.mqttFocusActive ? 1 : 0) +
    (graphFilters.selectedSemanticLanes.size > 0 ? 1 : 0)
  );

  return (
    <>
      {/* ── Node-type filter chips ──────────────────────────────── */}
      <div className="vis-legend-divider" />
      <div className="vis-legend-filter-header">
        <span className="vis-legend-filter-title">Node types</span>
        {activeFilterCount > 0 && (
          <span className="vis-filter-status" aria-live="polite">
            {visibleNodeCount}/{totalNodeCount}
          </span>
        )}
      </div>
      <div className="vis-filter-chips" role="group" aria-label="Node type filters">
        {ALL_FILTER_NODE_TYPES.map(type => {
          const pressed = graphFilters.enabledNodeTypes.has(type);
          return (
            <button
              key={type}
              className="vis-filter-chip"
              role="button"
              aria-pressed={pressed}
              onClick={() => toggleNodeType(type)}
              title={`${pressed ? 'Hide' : 'Show'} ${FILTER_NODE_TYPE_LABELS[type]}`}
            >
              {FILTER_NODE_TYPE_LABELS[type]}
            </button>
          );
        })}
      </div>

      {/* ── Focus views ────────────────────────────────────────── */}
      <div className="vis-legend-divider" />
      <span className="vis-legend-filter-title">Focus views</span>
      <label className="vis-filter-focus-row">
        <input
          type="checkbox"
          className="vis-legend-domain-cb"
          checked={graphFilters.portalFocusActive}
          onChange={e => setPortalFocus(e.target.checked)}
          aria-label="OpenClaw Portals only"
        />
        <span style={{ color: themeTokens.openclaw.node, fontSize: 10 }}>
          ⬡ OpenClaw Portals only
        </span>
      </label>
      <label className="vis-filter-focus-row">
        <input
          type="checkbox"
          className="vis-legend-domain-cb"
          checked={graphFilters.mqttFocusActive}
          onChange={e => setMqttFocus(e.target.checked)}
          aria-label="MQTT sources only"
        />
        <span style={{ fontSize: 10 }}>⟁ MQTT sources only</span>
      </label>

      {/* ── Bus semantic lanes ────────────────────────────────── */}
      {availableSemanticLanes.length > 0 && (
        <>
          <div className="vis-legend-divider" />
          <span className="vis-legend-filter-title">Bus semantics</span>
          <div className="vis-filter-lane-tags" role="group" aria-label="Semantic lane filters">
            {availableSemanticLanes.map(lane => (
              <label key={lane.key} className="vis-filter-lane-tag">
                <input
                  type="checkbox"
                  checked={graphFilters.selectedSemanticLanes.has(lane.key)}
                  onChange={() => toggleSemanticLane(lane.key)}
                  aria-label={`Semantic lane: ${lane.label}`}
                />
                <span>{lane.label}</span>
              </label>
            ))}
          </div>
        </>
      )}

      {/* ── Reset ─────────────────────────────────────────────── */}
      {activeFilterCount > 0 && (
        <>
          <div className="vis-legend-divider" />
          <button
            className="vis-reset-filters-btn"
            onClick={resetGraphFilters}
            title="Clear all graph filters"
            aria-label="Reset all graph filters"
          >
            ✕ Reset filters
          </button>
        </>
      )}
    </>
  );
}
