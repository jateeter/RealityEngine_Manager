// Catppuccin Mocha — © Catppuccin Contributors, MIT License
// https://github.com/catppuccin/catppuccin
// Crust/Mantle/Base surfaces + Flamingo/Mauve/Sapphire/Teal accents
import type { ThemeDef } from './types';

const tokens: ThemeDef['tokens'] = {
  bg: {
    page:          '#181825',
    panel:         '#1e1e2e',
    cardIdle:      '#313244',
    cardConnected: '#2a3a5e',
    cardActive:    '#1e3a5e',
    cardFired:     '#3b1a1a',
    cardVectorBg:  '#181825',
  },
  text: {
    primary:   '#cdd6f4',
    secondary: '#bac2de',
    muted:     '#585b70',
    emphasis:  '#ffffff',
  },
  accent: {
    input:        '#89dceb',
    output:       '#f5c2e7',
    outputBright: '#f38ba8',
    current:      '#89b4fa',
    external:     '#cba6f7',
    externalFill: '#b4a0f0',
  },
  edge: {
    idle:      '#45475a',
    active:    '#89dceb',
    bridge:    '#cba6f7',
    label:     '#6c7086',
    arrowhead: '#313244',
  },
  status: {
    activeFill:       '#1a2c20',
    activeStroke:     '#a6e3a1',
    processingFill:   '#2c2314',
    processingStroke: '#f9e2af',
    dotActive:        '#a6e3a1',
    dotProcessing:    '#f9e2af',
    dotIdle:          '#45475a',
  },
  outline: {
    idle:  '#313244',
    focus: '#89dceb',
    hover: '#f9e2af',
  },
  bus: {
    interconnectStroke: '#89b4fa',
    interconnectFill:   'rgba(137,180,250,0.10)',
    barBg:              'rgba(137,180,250,0.06)',
    semanticLane:       'rgba(137,180,250,0.16)',
  },
  openclaw: {
    node: '#fab387',
    fill: 'rgba(250,179,135,0.12)',
    edge: '#fab387',
  },
  card: {
    firedFill:   '#3b1a1a',
    firedStroke: '#f38ba8',
  },
};

const css = `
[data-theme="catppuccin"] {
  --re-bg-0:   #11111b;
  --re-bg-1:   #181825;
  --re-bg-2:   #1e1e2e;
  --re-bg-3:   #313244;
  --re-bg-4:   #45475a;
  --re-border:        #313244;
  --re-border-bright: #45475a;
  --re-border-glow:   #585b70;
  --re-text-0: #cdd6f4;
  --re-text-1: #bac2de;
  --re-text-2: #7f849c;
  --re-text-3: #45475a;
  --re-cyan:   #89dceb;
  --re-pink:   #f5c2e7;
  --re-violet: #cba6f7;
  --re-green:  #a6e3a1;
  --re-amber:  #f9e2af;
  --re-sky:    #89b4fa;
  --re-lime:   #a6e3a1;
  --re-red:    #f38ba8;
}`;

export const catppuccinTheme: ThemeDef = {
  id:       'catppuccin',
  label:    'Catppuccin',
  desc:     'Catppuccin Mocha — soothing pastel palette (MIT)',
  swatches: ['#1e1e2e', '#313244', '#89dceb', '#cdd6f4'],
  css,
  tokens,
};
