// One histogram of counts (RealityEngine_Manager#372). A single series, so a
// single hue and no legend: the title names what is counted. Thin bars with a
// 4px rounded data end and a 2px gap, a hover tooltip larger than the mark, and
// a table view of the same numbers. Small multiples share a scale (`max`), so
// voters side by side compare by length.
import React, { useState } from 'react';

export interface HistogramProps {
  title: string;
  counts: Record<string, number>;
  /** the scale's maximum, shared across the small multiples in a row */
  max?: number;
  /** horizontal bars for named categories (default); columns for an ordered axis such as steps */
  orientation?: 'bars' | 'columns';
  /** order of the categories; numeric keys sort numerically by default */
  order?: string[];
  unit?: string;
  testId?: string;
}

const numericFirst = (a: string, b: string) => {
  const x = Number(a.split('-')[0]), y = Number(b.split('-')[0]);
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b);
};

export const Histogram: React.FC<HistogramProps> = ({ title, counts, max, orientation = 'bars', order, unit = 'K-lines', testId }) => {
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [table, setTable] = useState(false);
  const keys = order ?? Object.keys(counts).sort(numericFirst);
  const top = Math.max(1, max ?? Math.max(0, ...keys.map(k => counts[k] ?? 0)));
  const total = keys.reduce((s, k) => s + (counts[k] ?? 0), 0);

  return (
    <figure className="kl-hist" data-testid={testId}>
      <figcaption>
        <span className="kl-hist-title">{title}</span>
        <span className="kl-hist-total">{total.toLocaleString()} {unit}</span>
        <button type="button" className="kl-link" onClick={() => setTable(t => !t)} aria-pressed={table}>
          {table ? 'chart' : 'table'}
        </button>
      </figcaption>
      {keys.length === 0 ? <div className="kl-empty">none</div> : table ? (
        <table className="kl-table">
          <tbody>{keys.map(k => <tr key={k}><th scope="row">{k}</th><td>{(counts[k] ?? 0).toLocaleString()}</td></tr>)}</tbody>
        </table>
      ) : orientation === 'bars' ? (
        <div className="kl-bars" onMouseLeave={() => setHover(null)}>
          {keys.map(k => {
            const n = counts[k] ?? 0;
            return (
              <div key={k} className="kl-bar-row"
                   onMouseMove={e => setHover({ key: k, x: e.clientX, y: e.clientY })}>
                <span className="kl-bar-label" title={k}>{k}</span>
                <span className="kl-bar-track">
                  <span className="kl-bar" style={{ width: `${(n / top) * 100}%` }} />
                </span>
                <span className="kl-bar-value">{n.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="kl-cols" onMouseLeave={() => setHover(null)}>
          {keys.map(k => {
            const n = counts[k] ?? 0;
            return (
              <span key={k} className="kl-col-hit" onMouseMove={e => setHover({ key: k, x: e.clientX, y: e.clientY })}>
                <span className="kl-col" style={{ height: `${(n / top) * 100}%` }} />
              </span>
            );
          })}
          <span className="kl-cols-axis"><span>{keys[0]}</span><span>{keys[keys.length - 1]}</span></span>
        </div>
      )}
      {hover && !table && (
        <div className="kl-tip" style={{ left: hover.x + 12, top: hover.y + 12 }} role="tooltip">
          <strong>{hover.key}</strong> {(counts[hover.key] ?? 0).toLocaleString()} {unit}
        </div>
      )}
    </figure>
  );
};
