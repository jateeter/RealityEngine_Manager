import React from 'react';
import { Machine } from '../types';
import './MachineCard.css';

interface MachineCardProps {
  machine: Machine;
  onSelect: (machineId: string) => void;
  onEdit: (machine: Machine) => void;
  onDelete: (machineId: string) => void;
}

function formatLastAccessed(timestamp: number | null): string {
  if (!timestamp) return 'never';
  const diffMs   = Date.now() - timestamp;
  const diffMins  = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays  = Math.floor(diffMs / 86_400_000);
  if (diffMins  <  1) return 'just now';
  if (diffMins  < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays  <  7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const MachineCard: React.FC<MachineCardProps> = ({ machine, onSelect, onEdit, onDelete }) => (
  <div
    className={`mc-card${machine.isExample ? ' is-example' : ''}`}
    onClick={() => onSelect(machine.id)}
  >
    {/* ── Name + badge ── */}
    <div className="mc-header">
      <span className="mc-name">{machine.name}</span>
      {machine.isExample && <span className="mc-badge">example</span>}
    </div>

    {/* ── Description ── */}
    <p className="mc-desc">{machine.description || 'no description available'}</p>

    {/* ── Stats ── */}
    <div className="mc-stats">
      <div className="mc-stat">
        <span className="mc-stat-label">Sequences</span>
        <span className="mc-stat-value">{machine.sequenceCount}</span>
      </div>
      <div className="mc-stat-divider" />
      <div className="mc-stat">
        <span className="mc-stat-label">Vectors</span>
        <span className="mc-stat-value">{machine.totalVectors}</span>
      </div>
    </div>

    {/* ── Footer: timestamp + actions ── */}
    <div className="mc-footer">
      <span className="mc-last-accessed">
        accessed <span className="mc-last-accessed-val">{formatLastAccessed(machine.lastAccessedAt)}</span>
      </span>

      <div className="mc-actions" onClick={e => e.stopPropagation()}>
        <button
          className="mc-action-btn"
          onClick={() => onEdit(machine)}
        >
          edit
        </button>
        {!machine.isExample && (
          <button
            className="mc-action-btn mc-action-btn-delete"
            onClick={() => {
              if (window.confirm(`Delete "${machine.name}"?`)) onDelete(machine.id);
            }}
          >
            del
          </button>
        )}
      </div>
    </div>
  </div>
);

export default MachineCard;
