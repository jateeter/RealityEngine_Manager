/**
 * Shared color / contrast tokens for visualizations.
 *
 * "Neural Architecture Monitor" palette — deep navy-black background with
 * electric signal colors per domain.  All graph views pull from here.
 *
 * Matching CSS custom properties live in styles/viz.css.
 */

export const vizTheme = {
  bg: {
    page:           '#040a14',
    panel:          '#070e1c',
    cardIdle:       '#0c1828',   // default card body
    cardConnected:  '#1d3a5c',
    cardActive:     '#0c2d5c',
    cardVectorBg:   '#060e1a',   // vector-node inner fill (Tobias)
  },

  text: {
    primary:        '#ddeeff',
    secondary:      '#7a9ab8',
    muted:          '#3d5a72',
    emphasis:       '#ffffff',
  },

  accent: {
    input:          '#00c8ef',   // electric cyan — input streams
    output:         '#f03e8a',   // neon pink — output streams
    outputBright:   '#f472b6',
    current:        '#60b4f8',   // sky blue
    external:       '#9b6dff',   // violet — AI/external machines
    externalFill:   '#7c3aed',
  },

  edge: {
    idle:           '#1a3352',   // quiet navy for dotted connectors
    active:         '#00c8ef',   // electric cyan — active data flow
    bridge:         '#9b6dff',   // violet — cross-domain bridge edges
    label:          '#7a9ab8',
    arrowhead:      '#254d73',
  },

  status: {
    activeFill:       '#062d1a',
    activeStroke:     '#10d9a0',  // teal-green
    processingFill:   '#2d1c00',
    processingStroke: '#f59e0b',  // amber
    dotActive:        '#10d9a0',
    dotProcessing:    '#f59e0b',
    dotIdle:          '#3d5a72',
  },

  outline: {
    idle:           '#1a3352',
    focus:          '#00c8ef',
    hover:          '#f59e0b',
  },

  bus: {
    interconnectStroke: '#60b4f8',         // sky-blue — mechanical bus/interconnect nodes
    interconnectFill:   'rgba(96,180,248,0.10)',
    barBg:              'rgba(96,180,248,0.06)',
    semanticLane:       'rgba(96,180,248,0.18)',
  },

  openclaw: {
    node:  '#ff6b35',                      // burnt-orange — OpenClaw gateway
    fill:  'rgba(255,107,53,0.12)',
    edge:  '#ff6b35',
  },
} as const;

export type VizTheme = typeof vizTheme;
