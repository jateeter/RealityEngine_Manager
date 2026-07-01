/**
 * Shared theme type — every theme must export this exact shape so
 * the contract test can enforce completeness.
 */

export type ThemeId =
  | 'system'
  | 'dark'
  | 'light'
  | 'nord'
  | 'catppuccin'
  | 'solarized'
  | 'high-contrast';

export interface VizThemeTokens {
  bg: {
    page:          string;
    panel:         string;
    cardIdle:      string;
    cardConnected: string;
    cardActive:    string;
    cardFired:     string;
    cardVectorBg:  string;
  };
  text: {
    primary:   string;
    secondary: string;
    muted:     string;
    emphasis:  string;
  };
  accent: {
    input:         string;
    output:        string;
    outputBright:  string;
    current:       string;
    external:      string;
    externalFill:  string;
  };
  edge: {
    idle:      string;
    active:    string;
    bridge:    string;
    label:     string;
    arrowhead: string;
  };
  status: {
    activeFill:       string;
    activeStroke:     string;
    processingFill:   string;
    processingStroke: string;
    dotActive:        string;
    dotProcessing:    string;
    dotIdle:          string;
  };
  outline: {
    idle:  string;
    focus: string;
    hover: string;
  };
  bus: {
    interconnectStroke: string;
    interconnectFill:   string;
    barBg:              string;
    semanticLane:       string;
  };
  openclaw: {
    node: string;
    fill: string;
    edge: string;
  };
  /** Hex/rgba values for the five node card states (fired stroke/fill are separate) */
  card: {
    firedFill:   string;
    firedStroke: string;
  };
}

export interface ThemeDef {
  id:     ThemeId;
  label:  string;
  /** Short description shown as a preview subtitle */
  desc:   string;
  /** Representative swatches [bg, surface, accent, text] */
  swatches: [string, string, string, string];
  /** CSS block to inject under [data-theme="<id>"] { ... } */
  css:    string;
  tokens: VizThemeTokens;
}
