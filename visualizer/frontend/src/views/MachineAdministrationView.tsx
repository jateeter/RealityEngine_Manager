import React from 'react';
import { useVisualizerStore } from '../store';
import TopNavigationBar from '../components/TopNavigationBar';
import MachineContainerView from '../components/MachineContainerView';

interface MachineAdministrationViewProps {
  machineId: string;
  onNavigateBack: () => void;
}

const MachineAdministrationView: React.FC<MachineAdministrationViewProps> = ({
  onNavigateBack
}) => {
  const { currentMachine, selectedSequenceId } = useVisualizerStore();

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0a0a0a', display: 'flex', flexDirection: 'column' }}>
      {/* Top Navigation Bar */}
      <TopNavigationBar
        currentMachine={currentMachine}
        onNavigateBack={onNavigateBack}
      />

      {/* Main Content: Machine View with Input/Output Streams */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <MachineContainerView selectedSequenceId={selectedSequenceId} />
      </div>
    </div>
  );
};

export default MachineAdministrationView;
