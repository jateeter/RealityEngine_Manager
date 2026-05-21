import React, { useState } from 'react';
import './GlobalCurrentVectorDisplay.css';

interface GlobalCurrentVectorDisplayProps {
  // Current universal input event vector (En)
  currentVector: number[];
  // Simulation step number
  currentStep: number;
  // Callback to open log viewer
  onOpenLogViewer: () => void;
}

export const GlobalCurrentVectorDisplay: React.FC<GlobalCurrentVectorDisplayProps> = ({
  currentVector,
  currentStep,
  onOpenLogViewer
}) => {
  const [expandedView, setExpandedView] = useState(false);

  // Display settings
  const bytesPerRow = 16;
  const previewBytes = 32; // Show first 32 bytes in compact view
  const totalBytes = currentVector.length;

  // Calculate non-zero byte count
  const nonZeroCount = currentVector.filter(v => v !== 0).length;
  const activePercentage = ((nonZeroCount / totalBytes) * 100).toFixed(1);

  // Get bytes to display
  const displayBytes = expandedView ? currentVector : currentVector.slice(0, previewBytes);
  const rows = Math.ceil(displayBytes.length / bytesPerRow);

  return (
    <div className="global-current-vector-display">
      {/* Header */}
      <div className="vector-display-header">
        <div className="header-left">
          <span className="header-icon">🌐</span>
          <div className="header-text">
            <span className="header-title">Global Input Space Reality Event Vector (En)</span>
            <span className="header-subtitle">Current Universal Perceptual Input</span>
          </div>
        </div>
        <div className="header-right">
          <div className="vector-stats">
            <div className="stat-item">
              <span className="stat-label">Step:</span>
              <span className="stat-value">{currentStep}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Dimension:</span>
              <span className="stat-value">{totalBytes} bytes</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Active:</span>
              <span className="stat-value">{activePercentage}%</span>
              <div className="stat-bar">
                <div
                  className="stat-bar-fill"
                  style={{ width: `${activePercentage}%` }}
                />
              </div>
            </div>
          </div>
          <div className="header-actions">
            <button
              onClick={() => setExpandedView(!expandedView)}
              className="action-button view-toggle"
              title={expandedView ? 'Show compact view' : 'Show full vector'}
            >
              {expandedView ? '📋 Compact' : '📊 Expand'}
            </button>
            <button
              onClick={onOpenLogViewer}
              className="action-button log-viewer"
              title="View perceptual sequence logs"
            >
              📋 Logs
            </button>
          </div>
        </div>
      </div>

      {/* Current Vector Display */}
      <div className={`vector-content ${expandedView ? 'expanded' : 'compact'}`}>
        <div className="vector-grid-wrapper">
          {/* Vector Grid */}
          <div className="vector-grid">
            {Array.from({ length: rows }).map((_, rowIndex) => {
              const rowStart = rowIndex * bytesPerRow;
              const rowEnd = Math.min(rowStart + bytesPerRow, displayBytes.length);
              const rowBytes = displayBytes.slice(rowStart, rowEnd);

              return (
                <div key={rowIndex} className="vector-row">
                  {/* Row offset label */}
                  <div className="row-offset">
                    {(rowStart).toString(16).padStart(3, '0').toUpperCase()}
                  </div>

                  {/* Byte cells */}
                  <div className="row-bytes">
                    {rowBytes.map((value, colIndex) => {
                      const byteIndex = rowStart + colIndex;
                      const isActive = value !== 0;
                      const intensity = Math.min(value, 1.0);

                      return (
                        <div
                          key={byteIndex}
                          className={`byte-cell ${isActive ? 'active' : 'inactive'}`}
                          style={{
                            opacity: isActive ? 0.5 + (intensity * 0.5) : 0.3
                          }}
                          title={`Byte ${byteIndex}: ${value.toFixed(3)}`}
                        >
                          <span className="byte-value">{value.toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Row ASCII representation (optional) */}
                  <div className="row-ascii">
                    {rowBytes.map((value, colIndex) => {
                      const char = value > 0.1 ? '█' : value > 0.01 ? '▓' : '░';
                      return (
                        <span key={colIndex} className="ascii-char">
                          {char}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Show ellipsis if compact */}
          {!expandedView && totalBytes > previewBytes && (
            <div className="vector-ellipsis">
              <span className="ellipsis-icon">⋮</span>
              <span className="ellipsis-text">
                {totalBytes - previewBytes} more bytes (click Expand to view all)
              </span>
            </div>
          )}
        </div>

        {/* Vector Info Panel */}
        <div className="vector-info-panel">
          <div className="info-section">
            <div className="info-title">Vector Statistics</div>
            <div className="info-grid">
              <div className="info-item">
                <span className="info-label">Non-zero bytes:</span>
                <span className="info-value">{nonZeroCount} / {totalBytes}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Min value:</span>
                <span className="info-value">
                  {Math.min(...currentVector.filter(v => v > 0)).toFixed(3)}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Max value:</span>
                <span className="info-value">
                  {Math.max(...currentVector).toFixed(3)}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Mean (active):</span>
                <span className="info-value">
                  {nonZeroCount > 0
                    ? (currentVector.filter(v => v > 0).reduce((a, b) => a + b, 0) / nonZeroCount).toFixed(3)
                    : '0.000'}
                </span>
              </div>
            </div>
          </div>

          <div className="info-section">
            <div className="info-title">Current State</div>
            <div className="info-description">
              This vector represents the complete universal perceptual input space (En)
              at the current simulation step. All machines extract their inputs from
              designated regions of this vector.
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};
