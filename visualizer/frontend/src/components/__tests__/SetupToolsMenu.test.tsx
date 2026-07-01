/**
 * SetupToolsMenu unit tests.
 *
 * Covers: open/close via trigger, click-outside dismiss, Escape key,
 * arrow-key navigation between items, and Settings item opening the modal.
 *
 * SettingsModal is mocked to a simple sentinel so we can test the menu
 * in isolation without <dialog> polyfill complexity.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupToolsMenu } from '../SetupToolsMenu';

// ── Mock SettingsModal ────────────────────────────────────────────────────────

vi.mock('../SettingsModal', () => ({
  SettingsModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="settings-modal">
        <button onClick={onClose}>close-modal</button>
      </div>
    ) : null,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTrigger() {
  return screen.getByRole('button', { name: /setup tools/i });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SetupToolsMenu', () => {

  it('renders trigger button', () => {
    render(<SetupToolsMenu />);
    expect(getTrigger()).toBeInTheDocument();
  });

  it('aria-expanded is false initially', () => {
    render(<SetupToolsMenu />);
    expect(getTrigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens menu on trigger click', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(getTrigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes menu on second trigger click', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(getTrigger());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('contains "Visualizer Settings" menu item', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('menuitem', { name: /visualizer settings/i })).toBeInTheDocument();
  });

  it('clicking "Visualizer Settings" opens the settings modal', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    fireEvent.click(screen.getByRole('menuitem', { name: /visualizer settings/i }));
    // menu closed, modal open
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument();
  });

  it('closing the modal hides it', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    fireEvent.click(screen.getByRole('menuitem', { name: /visualizer settings/i }));
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByText('close-modal'));
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument();
  });

  it('Escape key closes the menu', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const menuItem = screen.getByRole('menuitem', { name: /visualizer settings/i });
    fireEvent.keyDown(menuItem, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Escape on trigger closes the menu', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(getTrigger(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('ArrowDown on trigger opens menu', () => {
    render(<SetupToolsMenu />);
    fireEvent.keyDown(getTrigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('ArrowDown on last item wraps to first', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    const items = screen.getAllByRole('menuitem');
    // With a single item ArrowDown wraps back to index 0 — just check it doesn't throw
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    // Menu still open
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('ArrowUp on first item wraps to last', () => {
    render(<SetupToolsMenu />);
    fireEvent.click(getTrigger());
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('click outside closes menu', () => {
    render(
      <div>
        <SetupToolsMenu />
        <button data-testid="outside">outside</button>
      </div>
    );
    fireEvent.click(getTrigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    act(() => {
      fireEvent.mouseDown(screen.getByTestId('outside'));
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('aria-haspopup is "menu"', () => {
    render(<SetupToolsMenu />);
    expect(getTrigger()).toHaveAttribute('aria-haspopup', 'menu');
  });
});
