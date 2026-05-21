import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { VisMachine } from '../../hooks/useMachineSimulation';
import { TobiasRenderer } from './TobiasRenderer';
import './TobiasCanvas.css';

export interface TobiasCanvasHandle {
  clearLayout: () => void;
}

interface TobiasCanvasProps {
  machines: VisMachine[];
  selectedMachineId: string | null;
  onSelectMachine: (id: string | null) => void;
}

/**
 * TobiasCanvas — React boundary between the React tree and the imperative canvas renderer.
 *
 * Responsibilities:
 *  - Maintain the canvas element ref
 *  - Create/destroy TobiasRenderer instances
 *  - Bridge ResizeObserver → renderer.resize()
 *  - Forward data changes → renderer.setData()
 *  - No drawing state; all mutable state lives in TobiasRenderer
 */
const TobiasCanvas = forwardRef<TobiasCanvasHandle, TobiasCanvasProps>(({
  machines,
  selectedMachineId,
  onSelectMachine,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TobiasRenderer | null>(null);

  useImperativeHandle(ref, () => ({
    clearLayout: () => rendererRef.current?.clearLayout(),
  }));

  // Create / destroy renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new TobiasRenderer({
      canvas,
      onSelectMachine,
    });
    rendererRef.current = renderer;

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
    // onSelectMachine is intentionally excluded from deps — it's a stable callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ResizeObserver — call renderer.resize() when container dimensions change
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        rendererRef.current?.resize(width, height);
      }
    });

    ro.observe(container);

    // Trigger an initial size
    const { width, height } = container.getBoundingClientRect();
    rendererRef.current?.resize(width, height);

    return () => ro.disconnect();
  }, []);

  // Forward machine data changes to renderer
  useEffect(() => {
    rendererRef.current?.setData(machines);
  }, [machines]);

  // Forward selected machine id changes to renderer
  useEffect(() => {
    rendererRef.current?.setSelectedId(selectedMachineId);
  }, [selectedMachineId]);

  return (
    <div ref={containerRef} className="tobias-canvas-container">
      <canvas ref={canvasRef} className="tobias-canvas" />
    </div>
  );
});

TobiasCanvas.displayName = 'TobiasCanvas';
export default TobiasCanvas;
