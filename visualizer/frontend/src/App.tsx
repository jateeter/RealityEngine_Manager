import { useEffect } from 'react';
import { useVisualizerStore } from './store';
import RealityEnginePanelView from './views/RealityEnginePanelView';
import { PerceptualEngineView } from './views/PerceptualEngineView';

function App() {
  const { currentView, connectWebSocket, disconnectWebSocket } = useVisualizerStore();

  useEffect(() => {
    (window as any).useVisualizerStore = useVisualizerStore;
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => disconnectWebSocket();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (currentView === 'perceptual-engine') {
    return <PerceptualEngineView />;
  }

  return <RealityEnginePanelView />;
}

export default App;
