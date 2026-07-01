// Nord Palette — © Sven Greb, MIT License
// https://github.com/nordtheme/nord
// Polar Night surfaces + Snow Storm text + Frost & Aurora accents
import type { ThemeDef } from './types';

const tokens: ThemeDef['tokens'] = {
  bg: {
    page:          '#2e3440',
    panel:         '#3b4252',
    cardIdle:      '#434c5e',
    cardConnected: '#3d566e',
    cardActive:    '#344a5e',
    cardFired:     '#4c2a2a',
    cardVectorBg:  '#2e3440',
  },
  text: {
    primary:   '#eceff4',
    secondary: '#d8dee9',
    muted:     '#4c566a',
    emphasis:  '#ffffff',
  },
  accent: {
    input:        '#88c0d0',
    output:       '#b48ead',
    outputBright: '#c9a0c2',
    current:      '#81a1c1',
    external:     '#5e81ac',
    externalFill: '#4b6a8c',
  },
  edge: {
    idle:      '#4c566a',
    active:    '#88c0d0',
    bridge:    '#5e81ac',
    label:     '#4c566a',
    arrowhead: '#3b4252',
  },
  status: {
    activeFill:       '#2d3d30',
    activeStroke:     '#a3be8c',
    processingFill:   '#3d3222',
    processingStroke: '#ebcb8b',
    dotActive:        '#a3be8c',
    dotProcessing:    '#ebcb8b',
    dotIdle:          '#4c566a',
  },
  outline: {
    idle:  '#434c5e',
    focus: '#88c0d0',
    hover: '#ebcb8b',
  },
  bus: {
    interconnectStroke: '#81a1c1',
    interconnectFill:   'rgba(129,161,193,0.12)',
    barBg:              'rgba(129,161,193,0.07)',
    semanticLane:       'rgba(136,192,208,0.15)',
  },
  openclaw: {
    node: '#d08770',
    fill: 'rgba(208,135,112,0.12)',
    edge: '#d08770',
  },
  card: {
    firedFill:   '#4c2a2a',
    firedStroke: '#bf616a',
  },
};

const css = `
[data-theme="nord"] {
  --re-bg-0:   #242933;
  --re-bg-1:   #2e3440;
  --re-bg-2:   #3b4252;
  --re-bg-3:   #434c5e;
  --re-bg-4:   #4c566a;
  --re-border:        #3b4252;
  --re-border-bright: #4c566a;
  --re-border-glow:   #5e6e82;
  --re-text-0: #eceff4;
  --re-text-1: #d8dee9;
  --re-text-2: #8896a8;
  --re-text-3: #4c566a;
  --re-cyan:   #88c0d0;
  --re-pink:   #b48ead;
  --re-violet: #5e81ac;
  --re-green:  #a3be8c;
  --re-amber:  #ebcb8b;
  --re-sky:    #81a1c1;
  --re-lime:   #a3be8c;
  --re-red:    #bf616a;
}`;

export const nordTheme: ThemeDef = {
  id:       'nord',
  label:    'Nord',
  desc:     'Arctic, north-bluish palette (Sven Greb, MIT)',
  swatches: ['#2e3440', '#434c5e', '#88c0d0', '#eceff4'],
  css,
  tokens,
};
