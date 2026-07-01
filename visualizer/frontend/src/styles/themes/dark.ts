// Neural Architecture Monitor — default dark palette (unchanged from original)
import type { ThemeDef } from './types';

const tokens: ThemeDef['tokens'] = {
  bg: {
    page:          '#040a14',
    panel:         '#070e1c',
    cardIdle:      '#0c1828',
    cardConnected: '#1d3a5c',
    cardActive:    '#0c2d5c',
    cardFired:     '#2d0808',
    cardVectorBg:  '#060e1a',
  },
  text: {
    primary:   '#ddeeff',
    secondary: '#7a9ab8',
    muted:     '#3d5a72',
    emphasis:  '#ffffff',
  },
  accent: {
    input:        '#00c8ef',
    output:       '#f03e8a',
    outputBright: '#f472b6',
    current:      '#60b4f8',
    external:     '#9b6dff',
    externalFill: '#7c3aed',
  },
  edge: {
    idle:      '#8ab4cc',
    active:    '#00c8ef',
    bridge:    '#9b6dff',
    label:     '#7a9ab8',
    arrowhead: '#254d73',
  },
  status: {
    activeFill:       '#062d1a',
    activeStroke:     '#10d9a0',
    processingFill:   '#2d1c00',
    processingStroke: '#f59e0b',
    dotActive:        '#10d9a0',
    dotProcessing:    '#f59e0b',
    dotIdle:          '#3d5a72',
  },
  outline: {
    idle:  '#1a3352',
    focus: '#00c8ef',
    hover: '#f59e0b',
  },
  bus: {
    interconnectStroke: '#60b4f8',
    interconnectFill:   'rgba(96,180,248,0.10)',
    barBg:              'rgba(96,180,248,0.06)',
    semanticLane:       'rgba(96,180,248,0.18)',
  },
  openclaw: {
    node: '#ff6b35',
    fill: 'rgba(255,107,53,0.12)',
    edge: '#ff6b35',
  },
  card: {
    firedFill:   '#2d0808',
    firedStroke: '#ef4444',
  },
};

const css = `
[data-theme="dark"] {
  --re-bg-0:   #020609;
  --re-bg-1:   #040a14;
  --re-bg-2:   #070e1c;
  --re-bg-3:   #0c1828;
  --re-bg-4:   #132237;
  --re-border:        #0e2038;
  --re-border-bright: #1a3352;
  --re-border-glow:   #254d73;
  --re-text-0: #ddeeff;
  --re-text-1: #7a9ab8;
  --re-text-2: #3d5a72;
  --re-text-3: #1e3347;
  --re-cyan:   #00c8ef;
  --re-pink:   #f03e8a;
  --re-violet: #9b6dff;
  --re-green:  #10d9a0;
  --re-amber:  #f59e0b;
  --re-sky:    #38bdf8;
  --re-lime:   #84cc16;
  --re-red:    #f87171;
}`;

export const darkTheme: ThemeDef = {
  id:       'dark',
  label:    'Dark',
  desc:     'Neural Architecture Monitor — deep navy',
  swatches: ['#040a14', '#0c1828', '#00c8ef', '#ddeeff'],
  css,
  tokens,
};
