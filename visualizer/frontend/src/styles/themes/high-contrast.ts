// High Contrast — WCAG AA ≥ 4.5:1 throughout; focus ring 3px solid #ffff00
import type { ThemeDef } from './types';

const tokens: ThemeDef['tokens'] = {
  bg: {
    page:          '#000000',
    panel:         '#0a0a0a',
    cardIdle:      '#000000',
    cardConnected: '#001133',
    cardActive:    '#001a00',
    cardFired:     '#1a0000',
    cardVectorBg:  '#0a0a0a',
  },
  text: {
    primary:   '#ffffff',
    secondary: '#eeeeee',
    muted:     '#aaaaaa',
    emphasis:  '#ffff00',
  },
  accent: {
    input:        '#00ffff',
    output:       '#ff69b4',
    outputBright: '#ff80c0',
    current:      '#44aaff',
    external:     '#cc88ff',
    externalFill: '#9944ee',
  },
  edge: {
    idle:      '#888888',
    active:    '#00ffff',
    bridge:    '#cc88ff',
    label:     '#cccccc',
    arrowhead: '#888888',
  },
  status: {
    activeFill:       '#001a00',
    activeStroke:     '#00ff88',
    processingFill:   '#1a1100',
    processingStroke: '#ffcc00',
    dotActive:        '#00ff88',
    dotProcessing:    '#ffcc00',
    dotIdle:          '#666666',
  },
  outline: {
    idle:  '#444444',
    focus: '#ffff00',
    hover: '#ffff00',
  },
  bus: {
    interconnectStroke: '#44aaff',
    interconnectFill:   'rgba(68,170,255,0.15)',
    barBg:              'rgba(68,170,255,0.08)',
    semanticLane:       'rgba(68,170,255,0.20)',
  },
  openclaw: {
    node: '#ff8800',
    fill: 'rgba(255,136,0,0.15)',
    edge: '#ff8800',
  },
  card: {
    firedFill:   '#1a0000',
    firedStroke: '#ff4444',
  },
};

const css = `
[data-theme="high-contrast"] {
  --re-bg-0:   #000000;
  --re-bg-1:   #000000;
  --re-bg-2:   #0a0a0a;
  --re-bg-3:   #111111;
  --re-bg-4:   #222222;
  --re-border:        #444444;
  --re-border-bright: #888888;
  --re-border-glow:   #aaaaaa;
  --re-text-0: #ffffff;
  --re-text-1: #eeeeee;
  --re-text-2: #cccccc;
  --re-text-3: #aaaaaa;
  --re-cyan:   #00ffff;
  --re-pink:   #ff69b4;
  --re-violet: #cc88ff;
  --re-green:  #00ff88;
  --re-amber:  #ffcc00;
  --re-sky:    #44aaff;
  --re-lime:   #ccff00;
  --re-red:    #ff4444;
}`;

export const highContrastTheme: ThemeDef = {
  id:       'high-contrast',
  label:    'High Contrast',
  desc:     'Maximum legibility — WCAG AA throughout',
  swatches: ['#000000', '#0a0a0a', '#00ffff', '#ffffff'],
  css,
  tokens,
};
