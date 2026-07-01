/**
 * ThemeContext — unit tests for provider and hook behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { darkTheme } from '../../styles/themes/dark';
import { lightTheme } from '../../styles/themes/light';

// ── jsdom mocks ───────────────────────────────────────────────────────────────

// jsdom doesn't implement matchMedia — use a plain function (not vi.fn) so
// vi.restoreAllMocks() doesn't clear its return value between tests.
function makeMatchMedia(matches = false) {
  return (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: makeMatchMedia(false),
  });
});

// Stub localStorage so .clear() / .getItem() / .setItem() work reliably
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem:   (k: string) => localStorageStore[k] ?? null,
  setItem:   (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem:(k: string) => { delete localStorageStore[k]; },
  clear:     () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
};

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    writable: true,
    value: localStorageMock,
  });
  localStorageMock.clear();
  // Reset data-theme attribute
  document.documentElement.removeAttribute('data-theme');
  // Remove injected theme style if present
  document.getElementById('re-theme-styles')?.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test helpers ──────────────────────────────────────────────────────────────

function ThemeDisplay() {
  const { themeId, resolvedId, tokens } = useTheme();
  return (
    <div>
      <span data-testid="themeId">{themeId}</span>
      <span data-testid="resolvedId">{resolvedId}</span>
      <span data-testid="bgPage">{tokens.bg.page}</span>
    </div>
  );
}

function ThemeSetter({ newId }: { newId: string }) {
  const { setThemeId } = useTheme();
  return (
    <button onClick={() => setThemeId(newId as any)}>set</button>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ThemeProvider', () => {
  it('renders children', () => {
    render(
      <Wrapper>
        <span data-testid="child">hello</span>
      </Wrapper>,
    );
    expect(screen.getByTestId('child')).toBeTruthy();
  });

  it('defaults to dark theme when localStorage is empty', () => {
    render(<Wrapper><ThemeDisplay /></Wrapper>);
    expect(screen.getByTestId('themeId').textContent).toBe('dark');
  });

  it('reads persisted theme from localStorage', () => {
    localStorageMock.setItem('re-viz-theme', 'nord');
    render(<Wrapper><ThemeDisplay /></Wrapper>);
    expect(screen.getByTestId('themeId').textContent).toBe('nord');
  });

  it('sets data-theme attribute on <html> to resolved id', () => {
    render(<Wrapper><ThemeDisplay /></Wrapper>);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('injects <style id="re-theme-styles"> once', () => {
    render(<Wrapper><ThemeDisplay /></Wrapper>);
    const styleEl = document.getElementById('re-theme-styles');
    expect(styleEl).toBeTruthy();
    expect(styleEl!.tagName).toBe('STYLE');
  });

  it('provides dark theme tokens correctly', () => {
    render(<Wrapper><ThemeDisplay /></Wrapper>);
    expect(screen.getByTestId('bgPage').textContent).toBe(darkTheme.tokens.bg.page);
  });
});

describe('useTheme hook', () => {
  it('throws when used outside ThemeProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ThemeDisplay />)).toThrow('useTheme must be used inside <ThemeProvider>');
    spy.mockRestore();
  });

  it('setThemeId updates themeId and data-theme attribute', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <ThemeDisplay />
        <ThemeSetter newId="light" />
      </Wrapper>,
    );
    expect(screen.getByTestId('themeId').textContent).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'set' }));

    expect(screen.getByTestId('themeId').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setThemeId persists to localStorage', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <ThemeSetter newId="catppuccin" />
      </Wrapper>,
    );
    await user.click(screen.getByRole('button', { name: 'set' }));
    expect(localStorageMock.getItem('re-viz-theme')).toBe('catppuccin');
  });

  it('setThemeId updates token values', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <ThemeDisplay />
        <ThemeSetter newId="light" />
      </Wrapper>,
    );
    await user.click(screen.getByRole('button', { name: 'set' }));
    expect(screen.getByTestId('bgPage').textContent).toBe(lightTheme.tokens.bg.page);
  });

  it('system theme resolves without crashing', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <ThemeDisplay />
        <ThemeSetter newId="system" />
      </Wrapper>,
    );
    await user.click(screen.getByRole('button', { name: 'set' }));
    expect(screen.getByTestId('themeId').textContent).toBe('system');
    // resolvedId should be 'dark' or 'light' (not 'system')
    const resolvedId = screen.getByTestId('resolvedId').textContent;
    expect(['dark', 'light']).toContain(resolvedId);
  });

  it('data-theme reflects resolved theme when in system mode', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <ThemeSetter newId="system" />
      </Wrapper>,
    );
    await user.click(screen.getByRole('button', { name: 'set' }));
    const attr = document.documentElement.getAttribute('data-theme');
    expect(['dark', 'light']).toContain(attr);
  });
});
