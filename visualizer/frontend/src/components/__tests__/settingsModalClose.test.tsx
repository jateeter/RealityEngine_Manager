/**
 * SettingsModal close-path tests — covers all three root causes from Issue #22.
 *
 * RC-1: cancel event must be prevented so browser doesn't close dialog natively.
 * RC-2: handleClose must call el.close() synchronously, not via a deferred effect.
 * RC-3: onClose must be consumed via a stable ref so handleClose deps stay minimal.
 *
 * jsdom does not implement <dialog> natively — we apply a minimal polyfill
 * on each HTMLDialogElement created during the test run.
 */

import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsModal } from '../SettingsModal';

// ── jsdom dialog polyfill ────────────────────────────────────────────────────

function polyfillDialog(el: HTMLDialogElement) {
  let isOpen = false;
  Object.defineProperties(el, {
    open:      { get: () => isOpen, configurable: true },
    showModal: { value: () => { isOpen = true; el.setAttribute('open', ''); }, configurable: true },
    close:     { value: () => { isOpen = false; el.removeAttribute('open'); el.dispatchEvent(new Event('close')); }, configurable: true },
  });
}

const origCreate = document.createElement.bind(document);
beforeEach(() => {
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...args: any[]) => {
    const el = origCreate(tag, ...args);
    if (tag === 'dialog') polyfillDialog(el as HTMLDialogElement);
    return el;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Theme / store mocks ───────────────────────────────────────────────────────

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({
    themeId: 'dark',
    setThemeId: vi.fn(),
    tokens: { bg: {}, text: {}, accent: {}, edge: {}, status: {}, outline: {}, bus: {}, openclaw: {}, card: {} },
  }),
}));

vi.mock('../../store', () => ({
  useVisualizerStore: (sel: any) => sel({
    settings: {
      themeId: 'dark',
      animationSpeed: 'normal',
      reduceMotion: false,
      edgeOpacity: 0.8,
      semanticLaneOpacity: 0.14,
      domainHullOpacity: 0.75,
      compactThreshold: 100,
      nodeLabelCutoff: 22,
      showEdgeLabels: false,
      threeDDefault: false,
      autoOpenLegend: false,
      showCorpusChip: true,
    },
    updateSettings: vi.fn(),
  }),
}));

vi.mock('../../styles/themes/index', () => ({
  THEMES: [
    { id: 'dark',  label: 'Dark',  desc: '', swatches: ['#000','#000','#000','#000'], css: '' },
    { id: 'light', label: 'Light', desc: '', swatches: ['#fff','#fff','#fff','#fff'], css: '' },
  ],
}));

// ── Wrapper that provides triggerRef ─────────────────────────────────────────

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef}>Trigger</button>
      <SettingsModal open={open} onClose={onClose} triggerRef={triggerRef} />
    </>
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsModal close-path', () => {
  it('renders without crashing', () => {
    const onClose = vi.fn();
    render(<Harness open={false} onClose={onClose} />);
    // dialog element exists (not necessarily open)
    expect(document.querySelector('dialog')).toBeTruthy();
  });

  it('opens the dialog when open=true', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('Done button calls onClose (RC-2: synchronous close path)', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Close (✕) button calls onClose', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close settings/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('RC-1: cancel event is prevented and handleClose fires', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    const dialog = document.querySelector('dialog')!;
    const cancelEvt = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvt);
    expect(cancelEvt.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('RC-2: dialog.close() called synchronously — dialog is not open after Done click', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('RC-3: onClose ref update — new onClose callback picked up without full re-subscribe', () => {
    const onClose1 = vi.fn();
    const onClose2 = vi.fn();
    const { rerender } = render(<Harness open={true} onClose={onClose1} />);
    // Replace onClose with a new function
    rerender(<Harness open={true} onClose={onClose2} />);
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose1).not.toHaveBeenCalled();
    expect(onClose2).toHaveBeenCalledTimes(1);
  });

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    const dialog = document.querySelector('dialog')!;
    // Simulate click where target === dialog element
    fireEvent.click(dialog, { target: dialog });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click inside panel does NOT call onClose', () => {
    const onClose = vi.fn();
    render(<Harness open={true} onClose={onClose} />);
    // clicking an inner element (the panel div) should NOT close
    const panel = document.querySelector('.settings-panel')!;
    fireEvent.click(panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('prop open=false closes dialog', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness open={true} onClose={onClose} />);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    rerender(<Harness open={false} onClose={onClose} />);
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});
