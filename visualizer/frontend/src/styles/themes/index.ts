import type { ThemeDef, ThemeId } from './types';
import { darkTheme }          from './dark';
import { lightTheme }         from './light';
import { nordTheme }          from './nord';
import { catppuccinTheme }    from './catppuccin';
import { solarizedTheme }     from './solarized';
import { highContrastTheme }  from './high-contrast';

export type { ThemeDef, ThemeId };
export type { VizThemeTokens } from './types';

export const THEMES: ThemeDef[] = [
  darkTheme,
  lightTheme,
  nordTheme,
  catppuccinTheme,
  solarizedTheme,
  highContrastTheme,
];

export const THEME_MAP: Record<string, ThemeDef> = Object.fromEntries(
  THEMES.map(t => [t.id, t]),
);

/** Inject all [data-theme] CSS blocks into <head> once. */
export function injectThemeStyles(): void {
  if (document.getElementById('re-theme-styles')) return;
  const style = document.createElement('style');
  style.id = 're-theme-styles';
  style.textContent = THEMES.map(t => t.css).join('\n');
  document.head.appendChild(style);
}

/** Resolve 'system' → the concrete theme matching the user's OS preference. */
export function resolveThemeId(id: ThemeId): Exclude<ThemeId, 'system'> {
  if (id !== 'system') return id;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Apply a theme to the document root. */
export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', resolveThemeId(id));
}

/** Retrieve tokens for the resolved theme id (never returns the system pseudo-entry). */
export function getThemeTokens(id: ThemeId): ThemeDef['tokens'] {
  return THEME_MAP[resolveThemeId(id)].tokens;
}
