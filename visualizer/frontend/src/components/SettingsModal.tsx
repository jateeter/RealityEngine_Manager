import React, {
  useCallback, useEffect, useId, useRef,
} from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useVisualizerStore } from '../store';
import { THEMES } from '../styles/themes/index';
import type { ThemeId } from '../styles/themes/index';
import './SettingsModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export function SettingsModal({ open, onClose, triggerRef }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { themeId, setThemeId } = useTheme();
  const { settings, updateSettings } = useVisualizerStore(s => ({
    settings: s.settings,
    updateSettings: s.updateSettings,
  }));
  const headingId = useId();

  // Open/close native dialog
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else {
      if (el.open) el.close();
    }
  }, [open]);

  // Return focus to trigger on close
  const handleClose = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose, triggerRef]);

  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) handleClose();
  }, [handleClose]);

  // Escape key is handled natively by <dialog>; sync state
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handler = () => handleClose();
    el.addEventListener('cancel', handler);
    return () => el.removeEventListener('cancel', handler);
  }, [handleClose]);

  const handleThemeChange = (id: ThemeId) => {
    setThemeId(id);
    updateSettings({ themeId: id });
  };

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onClick={handleBackdropClick}
    >
      <div className="settings-panel">
        <header className="settings-header">
          <h2 id={headingId} className="settings-title">Visualizer Settings</h2>
          <button
            className="settings-close"
            onClick={handleClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="settings-body">

          {/* ── Appearance ─────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Appearance</h3>

            <div className="settings-field">
              <span className="settings-label">Theme</span>
              <div className="settings-theme-grid" role="radiogroup" aria-label="Theme">
                {THEMES.map(t => (
                  <label
                    key={t.id}
                    className={`theme-option${themeId === t.id ? ' is-selected' : ''}`}
                    title={t.desc}
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={t.id}
                      checked={themeId === t.id}
                      onChange={() => handleThemeChange(t.id)}
                      className="theme-radio"
                    />
                    <div className="theme-swatches">
                      {t.swatches.map((s, i) => (
                        <span key={i} className="theme-swatch" style={{ background: s }} />
                      ))}
                    </div>
                    <span className="theme-label">{t.label}</span>
                    <span className="theme-desc">{t.desc}</span>
                  </label>
                ))}

                {/* System option */}
                <label
                  className={`theme-option${themeId === 'system' ? ' is-selected' : ''}`}
                  title="Follow OS light/dark preference"
                >
                  <input
                    type="radio"
                    name="theme"
                    value="system"
                    checked={themeId === 'system'}
                    onChange={() => handleThemeChange('system')}
                    className="theme-radio"
                  />
                  <div className="theme-swatches theme-swatches--system">
                    <span className="theme-swatch" style={{ background: '#040a14' }} />
                    <span className="theme-swatch" style={{ background: '#f8fafc' }} />
                    <span className="theme-swatch" style={{ background: '#00c8ef' }} />
                    <span className="theme-swatch" style={{ background: '#0284c7' }} />
                  </div>
                  <span className="theme-label">System</span>
                  <span className="theme-desc">Follow OS light/dark preference</span>
                </label>
              </div>
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="anim-speed">Animation Speed</label>
              <select
                id="anim-speed"
                className="settings-select"
                value={settings.animationSpeed}
                onChange={e => updateSettings({ animationSpeed: e.target.value as 'slow' | 'normal' | 'fast' })}
              >
                <option value="slow">Slow</option>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
              </select>
            </div>

            <div className="settings-field settings-field--row">
              <label className="settings-label" htmlFor="reduce-motion">Reduce Motion</label>
              <input
                id="reduce-motion"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.reduceMotion}
                onChange={e => updateSettings({ reduceMotion: e.target.checked })}
              />
            </div>
          </section>

          {/* ── Graph ──────────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Graph</h3>

            <div className="settings-field">
              <label className="settings-label" htmlFor="edge-opacity">
                Edge Opacity <span className="settings-value">{Math.round(settings.edgeOpacity * 100)}%</span>
              </label>
              <input
                id="edge-opacity"
                type="range"
                className="settings-range"
                min={0.1} max={1} step={0.05}
                value={settings.edgeOpacity}
                onChange={e => updateSettings({ edgeOpacity: parseFloat(e.target.value) })}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="sem-lane-opacity">
                Semantic Lane Opacity <span className="settings-value">{Math.round(settings.semanticLaneOpacity * 100)}%</span>
              </label>
              <input
                id="sem-lane-opacity"
                type="range"
                className="settings-range"
                min={0} max={0.5} step={0.02}
                value={settings.semanticLaneOpacity}
                onChange={e => updateSettings({ semanticLaneOpacity: parseFloat(e.target.value) })}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="hull-opacity">
                Domain Hull Opacity <span className="settings-value">{Math.round(settings.domainHullOpacity * 100)}%</span>
              </label>
              <input
                id="hull-opacity"
                type="range"
                className="settings-range"
                min={0} max={1} step={0.05}
                value={settings.domainHullOpacity}
                onChange={e => updateSettings({ domainHullOpacity: parseFloat(e.target.value) })}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="compact-threshold">
                Compact Threshold <span className="settings-value">{settings.compactThreshold} nodes</span>
              </label>
              <input
                id="compact-threshold"
                type="range"
                className="settings-range"
                min={20} max={500} step={10}
                value={settings.compactThreshold}
                onChange={e => updateSettings({ compactThreshold: parseInt(e.target.value, 10) })}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="label-cutoff">
                Node Label Cutoff <span className="settings-value">{settings.nodeLabelCutoff} chars</span>
              </label>
              <input
                id="label-cutoff"
                type="range"
                className="settings-range"
                min={8} max={60} step={1}
                value={settings.nodeLabelCutoff}
                onChange={e => updateSettings({ nodeLabelCutoff: parseInt(e.target.value, 10) })}
              />
            </div>

            <div className="settings-field settings-field--row">
              <label className="settings-label" htmlFor="show-edge-labels">Show Edge Labels</label>
              <input
                id="show-edge-labels"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.showEdgeLabels}
                onChange={e => updateSettings({ showEdgeLabels: e.target.checked })}
              />
            </div>

            <div className="settings-field settings-field--row">
              <label className="settings-label" htmlFor="three-d-default">Default 3D View</label>
              <input
                id="three-d-default"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.threeDDefault}
                onChange={e => updateSettings({ threeDDefault: e.target.checked })}
              />
            </div>
          </section>

          {/* ── Legend & Display ───────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Legend &amp; Display</h3>

            <div className="settings-field settings-field--row">
              <label className="settings-label" htmlFor="auto-legend">Auto-Open Legend</label>
              <input
                id="auto-legend"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.autoOpenLegend}
                onChange={e => updateSettings({ autoOpenLegend: e.target.checked })}
              />
            </div>

            <div className="settings-field settings-field--row">
              <label className="settings-label" htmlFor="show-corpus-chip">Show Corpus Chip</label>
              <input
                id="show-corpus-chip"
                type="checkbox"
                className="settings-checkbox"
                checked={settings.showCorpusChip}
                onChange={e => updateSettings({ showCorpusChip: e.target.checked })}
              />
            </div>
          </section>

        </div>

        <footer className="settings-footer">
          <button className="settings-done" onClick={handleClose}>Done</button>
        </footer>
      </div>
    </dialog>
  );
}
