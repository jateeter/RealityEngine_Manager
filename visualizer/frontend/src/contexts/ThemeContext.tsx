import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ThemeId, VizThemeTokens } from '../styles/themes/index';
import {
  THEME_MAP, applyTheme, getThemeTokens, injectThemeStyles, resolveThemeId,
} from '../styles/themes/index';

const STORAGE_KEY = 're-viz-theme';

interface ThemeContextValue {
  themeId:    ThemeId;
  resolvedId: Exclude<ThemeId, 'system'>;
  setThemeId: (id: ThemeId) => void;
  tokens:     VizThemeTokens;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPersistedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && (v in THEME_MAP || v === 'system')) return v as ThemeId;
  } catch {
    // localStorage not available — fall through
  }
  return 'dark';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(readPersistedTheme);
  const mediaRef = useRef<MediaQueryList | null>(null);

  // Inject CSS blocks once on mount
  useEffect(() => { injectThemeStyles(); }, []);

  const applyAndPersist = useCallback((id: ThemeId) => {
    setThemeIdState(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
    applyTheme(id);
  }, []);

  // Keep data-theme in sync
  useEffect(() => { applyTheme(themeId); }, [themeId]);

  // Listen for OS-level preference changes when in system mode
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    mediaRef.current = mql;
    const handler = () => { if (themeId === 'system') applyTheme('system'); };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [themeId]);

  const resolvedId = resolveThemeId(themeId);
  const tokens     = useMemo(() => getThemeTokens(themeId), [themeId]);

  const value: ThemeContextValue = useMemo(() => ({
    themeId,
    resolvedId,
    setThemeId: applyAndPersist,
    tokens,
  }), [themeId, resolvedId, tokens, applyAndPersist]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
