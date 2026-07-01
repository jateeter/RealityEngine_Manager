// Solarized Dark — © Ethan Schoonover, MIT License
// https://ethanschoonover.com/solarized/
// Base03/02/01 surfaces + 8-hue classic accent palette
import type { ThemeDef } from './types';

const tokens: ThemeDef['tokens'] = {
  bg: {
    page:          '#002b36',
    panel:         '#073642',
    cardIdle:      '#073642',
    cardConnected: '#0a4055',
    cardActive:    '#094050',
    cardFired:     '#321414',
    cardVectorBg:  '#002b36',
  },
  text: {
    primary:   '#fdf6e3',
    secondary: '#eee8d5',
    muted:     '#586e75',
    emphasis:  '#ffffff',
  },
  accent: {
    input:        '#2aa198',
    output:       '#d33682',
    outputBright: '#e0508a',
    current:      '#268bd2',
    external:     '#6c71c4',
    externalFill: '#5a60b0',
  },
  edge: {
    idle:      '#586e75',
    active:    '#2aa198',
    bridge:    '#6c71c4',
    label:     '#657b83',
    arrowhead: '#073642',
  },
  status: {
    activeFill:       '#1a3028',
    activeStroke:     '#859900',
    processingFill:   '#2e2000',
    processingStroke: '#b58900',
    dotActive:        '#859900',
    dotProcessing:    '#b58900',
    dotIdle:          '#586e75',
  },
  outline: {
    idle:  '#073642',
    focus: '#2aa198',
    hover: '#b58900',
  },
  bus: {
    interconnectStroke: '#268bd2',
    interconnectFill:   'rgba(38,139,210,0.12)',
    barBg:              'rgba(38,139,210,0.06)',
    semanticLane:       'rgba(42,161,152,0.18)',
  },
  openclaw: {
    node: '#cb4b16',
    fill: 'rgba(203,75,22,0.12)',
    edge: '#cb4b16',
  },
  card: {
    firedFill:   '#321414',
    firedStroke: '#dc322f',
  },
};

const css = `
[data-theme="solarized"] {
  --re-bg-0:   #001e26;
  --re-bg-1:   #002b36;
  --re-bg-2:   #073642;
  --re-bg-3:   #094052;
  --re-bg-4:   #586e75;
  --re-border:        #073642;
  --re-border-bright: #094052;
  --re-border-glow:   #2f6e7a;
  --re-text-0: #fdf6e3;
  --re-text-1: #eee8d5;
  --re-text-2: #839496;
  --re-text-3: #586e75;
  --re-cyan:   #2aa198;
  --re-pink:   #d33682;
  --re-violet: #6c71c4;
  --re-green:  #859900;
  --re-amber:  #b58900;
  --re-sky:    #268bd2;
  --re-lime:   #859900;
  --re-red:    #dc322f;
}`;

export const solarizedTheme: ThemeDef = {
  id:       'solarized',
  label:    'Solarized',
  desc:     'Solarized Dark — timeless teal/amber palette (MIT)',
  swatches: ['#002b36', '#073642', '#2aa198', '#fdf6e3'],
  css,
  tokens,
};
