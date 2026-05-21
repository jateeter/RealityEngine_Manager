import { useEffect } from 'react';
import { useVisualizerStore } from './store';
import MachineSelectionView from './views/MachineSelectionView';
import MachineAdministrationView from './views/MachineAdministrationView';
import { MachineInterconnectionView } from './pages/MachineInterconnectionView';
import TobiasView from './pages/TobiasView';
import { perceptualLogger } from './utils/perceptualSequenceLogger';

function App() {
  const {
    currentView,
    lastViewedMachineId,
    currentMachineId,
    setCurrentView,
    loadMachine,
    connectWebSocket,
    disconnectWebSocket,
  } = useVisualizerStore();

  // Expose store to window for E2E testing
  useEffect(() => {
    (window as any).useVisualizerStore = useVisualizerStore;
  }, []);

  // Single persistent WebSocket connection for the lifetime of the app
  useEffect(() => {
    connectWebSocket();
    return () => disconnectWebSocket();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup perceptual logger on unmount
  useEffect(() => {
    return () => {
      perceptualLogger.destroy();
    };
  }, []);

  // Initialize app - check for last viewed machine
  useEffect(() => {
    const initializeApp = async () => {
      // Try to load the last viewed machine from localStorage
      if (lastViewedMachineId) {
        try {
          // Attempt to load the machine
          await loadMachine(lastViewedMachineId);
          // If successful, we're already in administration view
        } catch (error) {
          console.error('Failed to load last viewed machine:', error);
          // If failed, clear localStorage and go to selection
          localStorage.removeItem('lastViewedMachineId');
          setCurrentView('selection');
        }
      } else {
        // No last viewed machine, go to selection
        setCurrentView('selection');
      }
    };

    initializeApp();
  }, []); // Empty dependency array - only run once on mount

  // Handle navigation back to selection
  const handleNavigateBack = () => {
    setCurrentView('selection');
  };

  // Render based on current view
  if (currentView === 'administration' && currentMachineId) {
    return (
      <MachineAdministrationView
        machineId={currentMachineId}
        onNavigateBack={handleNavigateBack}
      />
    );
  }

  if (currentView === 'interconnection') {
    return <MachineInterconnectionView />;
  }

  if (currentView === 'tobias') {
    return <TobiasView />;
  }

  return <MachineSelectionView />;
}

export default App;
