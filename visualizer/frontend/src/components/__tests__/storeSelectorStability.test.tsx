/**
 * Store selectors must return referentially stable values (#145).
 *
 * `SettingsModal` read the store with an object-literal selector:
 *
 *     useVisualizerStore(s => ({ settings: s.settings, updateSettings: s.updateSettings }))
 *
 * which builds a new object on every call. zustand v4 tolerated it. v5 compares
 * with `Object.is`, so the snapshot never matched the previous one and React
 * re-rendered forever — "The result of getSnapshot should be cached to avoid an
 * infinite loop", then "Maximum update depth exceeded", then an empty `#root`.
 *
 * The component is mounted on every page load (SetupToolsMenu renders it
 * unconditionally; `open` is only a prop), so the whole Visualizer failed to
 * render and every Playwright spec failed on a missing element. The engine
 * switcher specs were simply the ones looking.
 *
 * ## Why this test exists in this shape
 *
 * The change that introduced it (zustand 4.5.7 -> 5.0.15) was merged with 304
 * unit tests and a clean `npm run build`. Neither renders the app, so neither
 * could see it. A suite that never mounts a component cannot tell you the app
 * mounts.
 *
 * So this asserts the property directly — a component that reads the store
 * renders without a render loop — rather than asserting the text of one
 * selector, which the next object literal would walk straight past.
 */

import { useRef } from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ThemeProvider } from '../../contexts/ThemeContext';
import { SettingsModal } from '../SettingsModal';
import { useVisualizerStore } from '../../store';

// jsdom has no <dialog>; SettingsModal calls showModal/close on mount paths.
function polyfillDialog(el: HTMLDialogElement) {
  let isOpen = false;
  Object.defineProperty(el, 'open', { get: () => isOpen, configurable: true });
  el.showModal = () => { isOpen = true; };
  el.close = () => { isOpen = false; el.dispatchEvent(new Event('close')); };
}

function Harness() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <ThemeProvider>
      <button ref={triggerRef}>open</button>
      <SettingsModal open={false} onClose={() => {}} triggerRef={triggerRef} />
    </ThemeProvider>
  );
}

describe('store selector stability', () => {
  let origCreate: typeof document.createElement;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom implements neither <dialog> nor matchMedia; ThemeProvider needs the
    // latter. Both are environment gaps, not behaviour under test.
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true, configurable: true,
        value: (query: string) => ({
          matches: false, media: query, onchange: null,
          addEventListener: () => {}, removeEventListener: () => {},
          addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        }),
      });
    }
    origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: unknown[]) => {
      const el = origCreate(tag as never, ...(rest as []));
      if (tag.toLowerCase() === 'dialog') polyfillDialog(el as HTMLDialogElement);
      return el;
    }) as typeof document.createElement);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a store-reading component without a render loop', () => {
    expect(() => render(<Harness />)).not.toThrow();

    // React reports the uncached-snapshot case through console.error before it
    // escalates to "Maximum update depth exceeded", so catching it here fails
    // the test at the first symptom rather than the last.
    const messages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? ''));
    const loopWarning = messages.find((m: string) =>
      m.includes('getSnapshot should be cached') || m.includes('Maximum update depth'));
    expect(loopWarning, `React reported a render loop: ${loopWarning}`).toBeUndefined();
  });

  it('a selector reading the same slice twice returns an identical reference', () => {
    // The property the loop violated, asserted on the store directly: two reads
    // of the same slice must be `Object.is`-equal, or useSyncExternalStore will
    // re-render on every check.
    const a = useVisualizerStore.getState().settings;
    const b = useVisualizerStore.getState().settings;
    expect(Object.is(a, b)).toBe(true);
  });
});
