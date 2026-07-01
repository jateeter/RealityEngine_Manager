/**
 * Contract test: every theme must provide a token object matching VizThemeTokens.
 * Catches incomplete themes before they reach the browser.
 */

import { describe, it, expect } from 'vitest';
import type { VizThemeTokens } from '../../styles/themes/index';
import { THEMES, THEME_MAP, resolveThemeId, getThemeTokens } from '../../styles/themes/index';
import { darkTheme }         from '../../styles/themes/dark';
import { lightTheme }        from '../../styles/themes/light';
import { nordTheme }         from '../../styles/themes/nord';
import { catppuccinTheme }   from '../../styles/themes/catppuccin';
import { solarizedTheme }    from '../../styles/themes/solarized';
import { highContrastTheme } from '../../styles/themes/high-contrast';

const TOKEN_SHAPE: Record<string, string[]> = {
  bg:      ['page','panel','cardIdle','cardConnected','cardActive','cardFired','cardVectorBg'],
  text:    ['primary','secondary','muted','emphasis'],
  accent:  ['input','output','outputBright','current','external','externalFill'],
  edge:    ['idle','active','bridge','label','arrowhead'],
  status:  ['activeFill','activeStroke','processingFill','processingStroke','dotActive','dotProcessing','dotIdle'],
  outline: ['idle','focus','hover'],
  bus:     ['interconnectStroke','interconnectFill','barBg','semanticLane'],
  openclaw:['node','fill','edge'],
  card:    ['firedFill','firedStroke'],
};

function validateTokens(tokens: VizThemeTokens, label: string) {
  for (const [group, keys] of Object.entries(TOKEN_SHAPE)) {
    for (const key of keys) {
      const value = (tokens as any)[group][key];
      expect(
        typeof value,
        `${label}: tokens.${group}.${key} should be a string`,
      ).toBe('string');
      expect(
        value.length,
        `${label}: tokens.${group}.${key} should be non-empty`,
      ).toBeGreaterThan(0);
    }
  }
}

describe('theme token contract', () => {
  const allThemes = [darkTheme, lightTheme, nordTheme, catppuccinTheme, solarizedTheme, highContrastTheme];

  it('THEMES registry has 6 entries', () => {
    expect(THEMES).toHaveLength(6);
  });

  it('every theme id is unique', () => {
    const ids = THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(allThemes)('$id has all required token fields', (theme) => {
    validateTokens(theme.tokens, theme.id);
  });

  it.each(allThemes)('$id has exactly 4 swatches', (theme) => {
    expect(theme.swatches).toHaveLength(4);
    for (const s of theme.swatches) expect(typeof s).toBe('string');
  });

  it.each(allThemes)('$id has a non-empty CSS block', (theme) => {
    expect(theme.css).toContain(`[data-theme="${theme.id}"]`);
    expect(theme.css).toContain('--re-bg-0');
  });

  it.each(allThemes)('$id is in THEME_MAP', (theme) => {
    expect(THEME_MAP[theme.id]).toBe(theme);
  });

  it('resolveThemeId passes through non-system ids', () => {
    expect(resolveThemeId('dark')).toBe('dark');
    expect(resolveThemeId('light')).toBe('light');
    expect(resolveThemeId('nord')).toBe('nord');
  });

  it('getThemeTokens returns matching tokens', () => {
    expect(getThemeTokens('dark')).toBe(darkTheme.tokens);
    expect(getThemeTokens('nord')).toBe(nordTheme.tokens);
  });

  it('high-contrast focus token is yellow (#ffff00)', () => {
    expect(highContrastTheme.tokens.outline.focus).toBe('#ffff00');
  });
});
