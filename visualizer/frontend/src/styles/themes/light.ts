// Light theme — high-readability inverted surfaces with brightened domain accents
import type { ThemeDef } from './types';

const tokens: ThemeDef['tokens'] = {
  bg: {
    page:          '#f8fafc',
    panel:         '#f1f5f9',
    cardIdle:      '#ffffff',
    cardConnected: '#dbeafe',
    cardActive:    '#e0f2fe',
    cardFired:     '#fee2e2',
    cardVectorBg:  '#f1f5f9',
  },
  text: {
    primary:   '#0f172a',
    secondary: '#334155',
    muted:     '#64748b',
    emphasis:  '#000000',
  },
  accent: {
    input:        '#0284c7',
    output:       '#db2777',
    outputBright: '#ec4899',
    current:      '#0369a1',
    external:     '#7c3aed',
    externalFill: '#6d28d9',
  },
  edge: {
    idle:      '#94a3b8',
    active:    '#0284c7',
    bridge:    '#7c3aed',
    label:     '#475569',
    arrowhead: '#64748b',
  },
  status: {
    activeFill:       '#dcfce7',
    activeStroke:     '#16a34a',
    processingFill:   '#fef9c3',
    processingStroke: '#ca8a04',
    dotActive:        '#16a34a',
    dotProcessing:    '#ca8a04',
    dotIdle:          '#94a3b8',
  },
  outline: {
    idle:  '#cbd5e1',
    focus: '#0284c7',
    hover: '#ca8a04',
  },
  bus: {
    interconnectStroke: '#0369a1',
    interconnectFill:   'rgba(3,105,161,0.08)',
    barBg:              'rgba(3,105,161,0.05)',
    semanticLane:       'rgba(3,105,161,0.12)',
  },
  openclaw: {
    node: '#c2410c',
    fill: 'rgba(194,65,12,0.08)',
    edge: '#c2410c',
  },
  card: {
    firedFill:   '#fee2e2',
    firedStroke: '#dc2626',
  },
};

const css = `
[data-theme="light"] {
  --re-bg-0:   #ffffff;
  --re-bg-1:   #f8fafc;
  --re-bg-2:   #f1f5f9;
  --re-bg-3:   #e2e8f0;
  --re-bg-4:   #cbd5e1;
  --re-border:        #e2e8f0;
  --re-border-bright: #94a3b8;
  --re-border-glow:   #64748b;
  --re-text-0: #0f172a;
  --re-text-1: #334155;
  --re-text-2: #64748b;
  --re-text-3: #94a3b8;
  --re-cyan:   #0284c7;
  --re-pink:   #db2777;
  --re-violet: #7c3aed;
  --re-green:  #16a34a;
  --re-amber:  #ca8a04;
  --re-sky:    #0369a1;
  --re-lime:   #4d7c0f;
  --re-red:    #dc2626;
}`;

export const lightTheme: ThemeDef = {
  id:       'light',
  label:    'Light',
  desc:     'Clean white surfaces, readable in daylight',
  swatches: ['#f8fafc', '#ffffff', '#0284c7', '#0f172a'],
  css,
  tokens,
};
