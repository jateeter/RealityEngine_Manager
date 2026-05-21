/**
 * Graph3DToggle - Toggle button for switching between 2D and 3D graph views.
 *
 * Renders a floating pill-shaped toggle in the top-right corner of the graph
 * container. Matches the vizTheme styling.
 */

import React from 'react';
import { vizTheme } from '../styles/vizTheme';

interface Graph3DToggleProps {
  is3D: boolean;
  onToggle: () => void;
}

export const Graph3DToggle: React.FC<Graph3DToggleProps> = ({ is3D, onToggle }) => {
  return (
    <button
      onClick={onToggle}
      title={is3D ? 'Switch to 2D view' : 'Switch to 3D view'}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 14px',
        borderRadius: 20,
        border: `1px solid ${is3D ? vizTheme.accent.input : vizTheme.outline.idle}`,
        background: is3D ? 'rgba(0, 200, 239, 0.12)' : vizTheme.bg.panel,
        color: is3D ? vizTheme.accent.input : vizTheme.text.secondary,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 1,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        fontFamily: 'inherit',
        textTransform: 'uppercase',
      }}
    >
      <span style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: is3D ? vizTheme.accent.input : vizTheme.text.muted,
        boxShadow: is3D ? `0 0 6px ${vizTheme.accent.input}` : 'none',
        transition: 'all 0.2s ease',
      }} />
      {is3D ? '3D' : '2D'}
    </button>
  );
};

export default Graph3DToggle;
