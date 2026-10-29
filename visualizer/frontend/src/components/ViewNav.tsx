/**
 * ViewNav — the Manager's two top-level views, switched from the upper left
 * of both headers (RealityEngine_Manager#306): [Machines] [Perception].
 *
 * One component for both views so the two buttons cannot drift apart. The
 * button for the view on screen is marked active (aria-pressed) and does
 * nothing when clicked; there is no back button.
 */

import React from 'react';
import { useVisualizerStore } from '../store';
import './ViewNav.css';

const VIEWS = [
  { view: 'selection',         label: 'Machines',   icon: '⬡', testId: 'nav-machines',   title: 'Machines: the Reality Engine operational view' },
  { view: 'perceptual-engine', label: 'Perception', icon: '◎', testId: 'nav-perception', title: 'Perception: Perception Engine management' },
] as const;

export const ViewNav: React.FC = () => {
  const currentView = useVisualizerStore(s => s.currentView);
  const setCurrentView = useVisualizerStore(s => s.setCurrentView);
  return (
    <nav className="view-nav" aria-label="Views">
      {VIEWS.map(v => {
        const active = currentView === v.view;
        return (
          <button
            key={v.view}
            type="button"
            className={`view-nav-btn view-nav-${v.testId}${active ? ' is-active' : ''}`}
            data-testid={v.testId}
            aria-pressed={active}
            title={v.title}
            onClick={() => { if (!active) setCurrentView(v.view); }}
          >
            <span className="view-nav-icon" aria-hidden="true">{v.icon}</span>
            {v.label}
          </button>
        );
      })}
    </nav>
  );
};
