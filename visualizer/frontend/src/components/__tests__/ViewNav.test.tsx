/**
 * ViewNav (Manager#306): [Machines] [Perception] switch between the two views,
 * the button for the view on screen is active, and there is no third view.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewNav } from '../ViewNav';
import { useVisualizerStore } from '../../store';

beforeEach(() => {
  useVisualizerStore.setState({ currentView: 'selection' });
});

describe('ViewNav', () => {
  it('shows Machines then Perception, with the current view active', () => {
    render(<ViewNav />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('data-testid'))).toEqual(['nav-machines', 'nav-perception']);
    expect(buttons[0].textContent).toContain('Machines');
    expect(buttons[1].textContent).toContain('Perception');
    expect(screen.getByTestId('nav-machines').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('nav-perception').getAttribute('aria-pressed')).toBe('false');
  });

  it('flips between the two views', async () => {
    const user = userEvent.setup();
    render(<ViewNav />);
    await user.click(screen.getByTestId('nav-perception'));
    expect(useVisualizerStore.getState().currentView).toBe('perceptual-engine');
    expect(screen.getByTestId('nav-perception').getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByTestId('nav-machines'));
    expect(useVisualizerStore.getState().currentView).toBe('selection');
    expect(screen.getByTestId('nav-machines').getAttribute('aria-pressed')).toBe('true');
  });
});
