import React, { useMemo } from 'react';
import type { SourceConfig } from '../types.js';

interface Props {
  vector: number[];
  sources: SourceConfig[];
  hoveredSourceId: string | null;
}

// Return the dominant source type covering a given index, or null
function getSourceForIndex(index: number, sources: SourceConfig[]): SourceConfig | null {
  for (const src of sources) {
    if (!src.active) continue;
    if (index >= src.region.offset && index < src.region.offset + src.region.length) {
      return src;
    }
  }
  return null;
}

// Return whether a given index is within a hovered source's region
function isInHoveredRegion(index: number, hoveredSourceId: string | null, sources: SourceConfig[]): boolean {
  if (!hoveredSourceId) return false;
  const src = sources.find(s => s.id === hoveredSourceId);
  if (!src) return false;
  return index >= src.region.offset && index < src.region.offset + src.region.length;
}

const TYPE_BASE: Record<string, [number, number, number]> = {
  test: [59, 130, 246],       // blue-500
  simulated: [34, 197, 94],   // green-500
  sensor: [245, 158, 11],     // amber-500
};

function cellColor(value: number, src: SourceConfig | null, highlighted: boolean): string {
  if (!src || value < 0.001) {
    const v = Math.round(value * 30);
    return `rgb(${v}, ${v + 2}, ${v + 6})`;
  }
  const base = TYPE_BASE[src.type] ?? [148, 163, 184];
  const [r, g, b] = base;
  const intensity = highlighted ? 1 : 0.8;
  const mix = value * intensity;
  const br = Math.round(10 + mix * r);
  const bg = Math.round(10 + mix * g);
  const bb = Math.round(10 + mix * b);
  return `rgb(${br}, ${bg}, ${bb})`;
}

export default function VectorDisplay({ vector, sources, hoveredSourceId }: Props) {
  const [tooltip, setTooltip] = React.useState<{ index: number; value: number; x: number; y: number } | null>(null);

  const cells = useMemo(() => {
    return vector.map((v, i) => {
      const src = getSourceForIndex(i, sources);
      const highlighted = isInHoveredRegion(i, hoveredSourceId, sources);
      return { value: v, src, highlighted, color: cellColor(v, src, highlighted) };
    });
  }, [vector, sources, hoveredSourceId]);

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
          Input Vector <span style={{ color: '#475569', fontWeight: 400 }}>({vector.length})</span>
        </span>
        <span style={{ display: 'flex', gap: 8, fontSize: 10, color: '#475569' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: 1, background: 'rgb(59,130,246)', display: 'inline-block', flexShrink: 0 }} />
            Test
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: 1, background: 'rgb(34,197,94)', display: 'inline-block', flexShrink: 0 }} />
            Sim
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: 1, background: 'rgb(245,158,11)', display: 'inline-block', flexShrink: 0 }} />
            Sensor
          </span>
        </span>
      </div>
      <div
        style={{
          maxHeight: 80,
          overflowY: 'auto',
          background: '#0a0a0a',
          padding: 3,
          borderRadius: 6,
          border: '1px solid #1e293b',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, 5px)',
            gap: 1,
          }}
        >
          {cells.map((cell, i) => (
            <div
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: 1,
                background: cell.color,
                outline: cell.highlighted ? '1px solid rgba(255,255,255,0.5)' : undefined,
                cursor: 'default',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                const rect = (e.target as HTMLElement).getBoundingClientRect();
                setTooltip({ index: i, value: cell.value, x: rect.left, y: rect.top });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          ))}
        </div>
      </div>
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: tooltip.x + 12,
          top: tooltip.y - 8,
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 12,
          color: '#e2e8f0',
          pointerEvents: 'none',
          zIndex: 1000,
          whiteSpace: 'nowrap',
        }}>
          [{tooltip.index}] {tooltip.value.toFixed(4)}
        </div>
      )}
    </div>
  );
}
