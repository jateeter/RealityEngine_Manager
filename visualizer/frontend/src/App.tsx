import { useEffect } from 'react';
import { useVisualizerStore } from './store';
import RealityEnginePanelView from './views/RealityEnginePanelView';
import { MachineInterconnectionView } from './pages/MachineInterconnectionView';

function App() {
  const { currentView, connectWebSocket, disconnectWebSocket } = useVisualizerStore();

  useEffect(() => {
    (window as any).useVisualizerStore = useVisualizerStore;
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => disconnectWebSocket();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (currentView === 'interconnection') {
    return <MachineInterconnectionView />;
  }

  return <RealityEnginePanelView />;
}

export default App;
