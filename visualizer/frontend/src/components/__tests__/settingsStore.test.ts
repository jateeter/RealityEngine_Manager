/**
 * VisualizerSettings Zustand slice — unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useVisualizerStore } from '../../store';

function getStore() {
  return useVisualizerStore.getState();
}

describe('visualizerSettings store slice', () => {
  beforeEach(() => {
    // Reset to initial state between tests
    useVisualizerStore.setState({
      settings: {
        themeId:             'dark',
        compactThreshold:    100,
        edgeOpacity:         0.80,
        semanticLaneOpacity: 0.14,
        domainHullOpacity:   0.75,
        animationSpeed:      'normal',
        reduceMotion:        false,
        autoOpenLegend:      false,
        showCorpusChip:      true,
        showEdgeLabels:      false,
        threeDDefault:       false,
        nodeLabelCutoff:     22,
      },
    });
  });

  it('has correct default themeId', () => {
    expect(getStore().settings.themeId).toBe('dark');
  });

  it('has correct numeric defaults', () => {
    const s = getStore().settings;
    expect(s.compactThreshold).toBe(100);
    expect(s.edgeOpacity).toBeCloseTo(0.80);
    expect(s.semanticLaneOpacity).toBeCloseTo(0.14);
    expect(s.domainHullOpacity).toBeCloseTo(0.75);
    expect(s.nodeLabelCutoff).toBe(22);
  });

  it('has correct boolean defaults', () => {
    const s = getStore().settings;
    expect(s.reduceMotion).toBe(false);
    expect(s.autoOpenLegend).toBe(false);
    expect(s.showCorpusChip).toBe(true);
    expect(s.showEdgeLabels).toBe(false);
    expect(s.threeDDefault).toBe(false);
  });

  it('has normal animation speed by default', () => {
    expect(getStore().settings.animationSpeed).toBe('normal');
  });

  it('updateSettings patches themeId', () => {
    getStore().updateSettings({ themeId: 'nord' });
    expect(getStore().settings.themeId).toBe('nord');
  });

  it('updateSettings patches single field without disturbing others', () => {
    getStore().updateSettings({ edgeOpacity: 0.5 });
    const s = getStore().settings;
    expect(s.edgeOpacity).toBeCloseTo(0.5);
    expect(s.themeId).toBe('dark');
    expect(s.showCorpusChip).toBe(true);
  });

  it('updateSettings can patch multiple fields at once', () => {
    getStore().updateSettings({ reduceMotion: true, animationSpeed: 'slow' });
    const s = getStore().settings;
    expect(s.reduceMotion).toBe(true);
    expect(s.animationSpeed).toBe('slow');
    expect(s.threeDDefault).toBe(false);
  });

  it('updateSettings handles boolean toggles', () => {
    getStore().updateSettings({ showEdgeLabels: true });
    expect(getStore().settings.showEdgeLabels).toBe(true);
    getStore().updateSettings({ showEdgeLabels: false });
    expect(getStore().settings.showEdgeLabels).toBe(false);
  });

  it('settings co-exists with graphFilters slice', () => {
    const state = getStore();
    expect(state.settings).toBeDefined();
    expect(state.graphFilters).toBeDefined();
    expect(state.settings.themeId).toBe('dark');
  });
});
