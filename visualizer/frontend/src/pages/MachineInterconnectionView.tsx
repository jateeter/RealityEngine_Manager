/**
 * MachineInterconnectionView - Main page for machine interconnection visualization
 *
 * Combines machine graph and perceptual space view to provide a complete view
 * of machine interconnection and reality flow. Simulation is driven uniformly
 * through the store's universal perception API.
 */

import React from 'react';
import { useVisualizerStore } from '../store';
import { MachineGraphView } from '../components/MachineGraphView';
import './MachineInterconnectionView.css';

export const MachineInterconnectionView: React.FC = () => {
  const { setCurrentView } = useVisualizerStore();

  return (
    <div className="machine-interconnection-view">
      <div className="view-header">
        <div className="header-content">
          <div className="header-title">
            <button
              className="back-button"
              onClick={() => setCurrentView('selection')}
              title="Back to Machine Selection"
            >
              ← Back
            </button>
            <h1>Machine Interconnection View</h1>
          </div>
        </div>
      </div>

      <div className="view-layout">
        <div className="left-panel">
          <div className="panel-section">
            <MachineGraphView />
          </div>
        </div>
      </div>
    </div>
  );
};
