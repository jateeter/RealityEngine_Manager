import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import OutputStreamVisualization from './OutputStreamVisualization';
import type { OutputVector } from '../types';

// The panel renders collapsed by default: only the header ("OUTPUT" + arrow +
// count) is visible, and all detail content (CURRENT/HISTORY sections, the
// summary line, output cards) is gated behind the expanded state. These helpers
// render and then click the header toggle so detail assertions see the
// expanded view.
function renderPanel(ui: ReactElement) {
  return render(ui);
}

function expand(utils: ReturnType<typeof render>) {
  fireEvent.click(utils.getByRole('button'));
  return utils;
}

function renderExpanded(ui: ReactElement) {
  return expand(render(ui));
}

describe('OutputStreamVisualization', () => {
  const mockOutputVectors: OutputVector[] = [
    {
      id: 'output-1',
      vector: [0.5, 0.25, 0.75],
      timestamp: Date.now() - 5000,
      metadata: { description: 'First output' }
    },
    {
      id: 'output-2',
      vector: [1.0, 0.0, 0.5],
      timestamp: Date.now() - 3000,
      metadata: { description: 'Second output' }
    },
    {
      id: 'output-3',
      vector: [0.0, 1.0, 0.0],
      timestamp: Date.now() - 1000,
      metadata: { description: 'Third output', logicValue: 'TRUE' }
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Component Rendering', () => {
    it('should render without crashing', () => {
      renderPanel(<OutputStreamVisualization outputVectors={[]} />);
      expect(screen.getByText('OUTPUT')).toBeInTheDocument();
    });

    it('should display "No outputs yet" when empty', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={[]} />);
      expect(screen.getByText('No outputs yet')).toBeInTheDocument();
      expect(screen.getByText('Waiting for outputs...')).toBeInTheDocument();
    });

    it('should show correct output count', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);
      expect(screen.getByText('3 outputs')).toBeInTheDocument();
    });

    it('should show singular "output" for one item', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={[mockOutputVectors[0]]} />);
      expect(screen.getByText('1 output')).toBeInTheDocument();
    });
  });

  describe('Current Output Section', () => {
    it('should display CURRENT section header', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);
      expect(screen.getByText('CURRENT')).toBeInTheDocument();
    });

    it('should show the most recent output in current section', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // Most recent output should be visible
      expect(screen.getByText('output-3')).toBeInTheDocument();
      expect(screen.getByText('[0.00, 1.00, 0.00]')).toBeInTheDocument();
    });

    it('should display current output metadata', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);
      expect(screen.getByText('Third output')).toBeInTheDocument();
    });

    it('should show pulsing indicator for current output', () => {
      const utils = renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // Check for pulsing indicator div
      const pulseIndicator = utils.container.querySelector('[style*="pulse"]');
      expect(pulseIndicator).toBeInTheDocument();
    });
  });

  describe('History Section', () => {
    it('should display HISTORY section header when there are previous outputs', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);
      expect(screen.getByText('HISTORY')).toBeInTheDocument();
    });

    it('should show correct history count', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);
      expect(screen.getByText('2 previous')).toBeInTheDocument();
    });

    it('should not show history section with only one output', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={[mockOutputVectors[0]]} />);
      expect(screen.queryByText('HISTORY')).not.toBeInTheDocument();
    });

    it('should display previous outputs in reverse chronological order', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // Should show output-2 and output-1 in history
      expect(screen.getByText('output-2')).toBeInTheDocument();
      expect(screen.getByText('output-1')).toBeInTheDocument();

      // Check vectors are displayed
      expect(screen.getByText('[1.00, 0.00, 0.50]')).toBeInTheDocument();
      expect(screen.getByText('[0.50, 0.25, 0.75]')).toBeInTheDocument();
    });
  });

  describe('Vector Display', () => {
    it('should format vector values to 2 decimal places', () => {
      const output: OutputVector = {
        id: 'test-output',
        vector: [0.123456, 0.987654, 0.555555],
        timestamp: Date.now()
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      expect(screen.getByText('[0.12, 0.99, 0.56]')).toBeInTheDocument();
    });

    it('should display all vector dimensions', () => {
      const output: OutputVector = {
        id: 'test-output',
        vector: [1.0, 0.0, 0.5, 0.25, 0.75],
        timestamp: Date.now()
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      expect(screen.getByText('[1.00, 0.00, 0.50, 0.25, 0.75]')).toBeInTheDocument();
    });
  });

  describe('Metadata Display', () => {
    it('should display metadata description', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);
      expect(screen.getByText('First output')).toBeInTheDocument();
    });

    it('should extract description from metadata object', () => {
      const output: OutputVector = {
        id: 'test',
        vector: [1.0],
        timestamp: Date.now(),
        metadata: { description: 'Test description', logicValue: 'TRUE' }
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      expect(screen.getByText('Test description')).toBeInTheDocument();
    });

    it('should handle string metadata', () => {
      const output: OutputVector = {
        id: 'test',
        vector: [1.0],
        timestamp: Date.now(),
        metadata: 'Simple string metadata'
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      expect(screen.getByText('Simple string metadata')).toBeInTheDocument();
    });

    it('should handle missing metadata gracefully', () => {
      const output: OutputVector = {
        id: 'test',
        vector: [1.0],
        timestamp: Date.now()
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);

      // Should not crash, vector should be visible
      expect(screen.getByText('[1.00]')).toBeInTheDocument();
    });
  });

  describe('Auto-scroll Behavior', () => {
    it('should auto-scroll history to top when new output arrives', async () => {
      const utils = render(<OutputStreamVisualization outputVectors={mockOutputVectors.slice(0, 2)} />);
      expand(utils);

      // Add a new output
      const newOutputs = [...mockOutputVectors];
      utils.rerender(<OutputStreamVisualization outputVectors={newOutputs} />);

      // Wait for effect to run
      await waitFor(() => {
        // The newest output should be in current section
        expect(screen.getByText('output-3')).toBeInTheDocument();
      });
    });
  });

  describe('Styling and Animations', () => {
    it('should apply different styling to current vs history outputs', () => {
      const utils = renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // Current output should have orange gradient
      const currentCards = utils.container.querySelectorAll('[style*="linear-gradient"]');
      expect(currentCards.length).toBeGreaterThan(0);
    });

    it('should include animation styles', () => {
      const { container } = render(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // Check for style tag with animations
      const styleTag = container.querySelector('style');
      expect(styleTag).toBeInTheDocument();
      expect(styleTag?.textContent).toContain('@keyframes slideIn');
      expect(styleTag?.textContent).toContain('@keyframes pulse');
      expect(styleTag?.textContent).toContain('@keyframes sparkle');
      expect(styleTag?.textContent).toContain('@keyframes bounce');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long output IDs', () => {
      const output: OutputVector = {
        id: 'very-long-output-id-that-should-be-truncated-with-ellipsis-when-displayed',
        vector: [1.0],
        timestamp: Date.now()
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      // Should not crash and ID should be visible
      expect(screen.getByText(/very-long-output-id/)).toBeInTheDocument();
    });

    it('should handle empty vector array', () => {
      const output: OutputVector = {
        id: 'empty-vector',
        vector: [],
        timestamp: Date.now()
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      expect(screen.getByText('[]')).toBeInTheDocument();
    });

    it('should handle large numbers of outputs', () => {
      const manyOutputs: OutputVector[] = Array.from({ length: 100 }, (_, i) => ({
        id: `output-${i}`,
        vector: [Math.random(), Math.random(), Math.random()],
        timestamp: Date.now() - (100 - i) * 1000
      }));

      renderExpanded(<OutputStreamVisualization outputVectors={manyOutputs} />);

      // Should show all in history (99 previous + 1 current)
      expect(screen.getByText('100 outputs')).toBeInTheDocument();
      expect(screen.getByText('99 previous')).toBeInTheDocument();
    });

    it('should handle outputs with negative vector values', () => {
      const output: OutputVector = {
        id: 'negative',
        vector: [-0.5, -1.0, -0.25],
        timestamp: Date.now()
      };

      renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      expect(screen.getByText('[-0.50, -1.00, -0.25]')).toBeInTheDocument();
    });

    it('should handle missing timestamp', () => {
      const output: OutputVector = {
        id: 'no-timestamp',
        vector: [1.0],
        timestamp: undefined as any
      };

      const { container } = renderExpanded(<OutputStreamVisualization outputVectors={[output]} />);
      // Should not crash
      expect(container).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper semantic structure', () => {
      const { container } = render(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // Should have divs with proper structure
      expect(container.querySelector('[style*="display: flex"]')).toBeInTheDocument();
    });

    it('should display text content for screen readers', () => {
      renderExpanded(<OutputStreamVisualization outputVectors={mockOutputVectors} />);

      // All text should be accessible
      expect(screen.getByText('OUTPUT')).toBeVisible();
      expect(screen.getByText('CURRENT')).toBeVisible();
      expect(screen.getByText('HISTORY')).toBeVisible();
    });
  });

  describe('Performance', () => {
    it('should render efficiently with many outputs', () => {
      const startTime = performance.now();

      const manyOutputs = Array.from({ length: 1000 }, (_, i) => ({
        id: `perf-${i}`,
        vector: [i, i + 1, i + 2],
        timestamp: Date.now() - i * 1000
      }));

      render(<OutputStreamVisualization outputVectors={manyOutputs} />);

      const endTime = performance.now();
      const renderTime = endTime - startTime;

      // Should render in reasonable time (< 1 second)
      expect(renderTime).toBeLessThan(1000);
    });
  });
});
