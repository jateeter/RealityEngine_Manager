import type { SourceConfig, TestSourceConfig, SimulatedSourceConfig, SensorSourceConfig } from '../types.js';
import { DOMAINS } from './machineDomains.js';
import type { DomainId } from './machineDomains.js';

interface Props {
  source: SourceConfig;
  // Classification bucket — DomainId for test sources whose machine is
  // known, or 'other' for simulated/sensor sources (or when the machine
  // catalog hasn't loaded yet).
  domain: DomainId | 'other';
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
  onHover: (id: string | null) => void;
  hovered: boolean;
}

const TYPE_COLOR: Record<string, string> = {
  test: '#3b82f6',
  simulated: '#22c55e',
  sensor: '#f59e0b',
};

function subtitle(src: SourceConfig): string {
  if (src.type === 'test') {
    const t = src as TestSourceConfig;
    return `${t.sequenceName} — [${src.region.offset}:${src.region.offset + src.region.length}]`;
  }
  if (src.type === 'simulated') {
    const s = src as SimulatedSourceConfig;
    return `${s.pattern} f=${s.frequency}Hz — [${src.region.offset}:${src.region.offset + src.region.length}]`;
  }
  const se = src as SensorSourceConfig;
  const age = se.lastUpdated ? `${Math.round((Date.now() - se.lastUpdated) / 1000)}s ago` : 'no data';
  return `id=${se.sensorId} (${age}) — [${src.region.offset}:${src.region.offset + src.region.length}]`;
}

export default function SourceCard({ source, domain, onDelete, onToggle, onHover, hovered }: Props) {
  const color = TYPE_COLOR[source.type] ?? '#94a3b8';
  const domainColor = domain === 'other' ? '#94a3b8' : DOMAINS[domain].color;
  const domainLabel = domain === 'other' ? 'Other' : DOMAINS[domain].label;
  const domainShort = domain === 'other' ? 'OT' : DOMAINS[domain].short;

  return (
    <div
      onMouseEnter={() => onHover(source.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        // Left border keyed to the domain so a long source list can be
        // scanned for "which Ag rule is acting up" without reading labels.
        borderLeft: `3px solid ${domainColor}`,
        border: `1px solid ${hovered ? color : '#1e293b'}`,
        borderLeftColor: domainColor,
        borderLeftWidth: 3,
        background: hovered ? '#1e293b' : '#111827',
        marginBottom: 6,
        cursor: 'default',
        transition: 'border-color 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 5px',
          borderRadius: 3, background: color + '33', color,
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}>
          {source.type}
        </span>
        <span
          title={`Domain: ${domainLabel}`}
          style={{
            fontSize: 9, fontWeight: 700, padding: '1px 5px',
            borderRadius: 3,
            background: domainColor + '22',
            color: domainColor,
            border: `1px solid ${domainColor}44`,
            textTransform: 'uppercase', letterSpacing: 0.5,
            fontFamily: 'monospace',
          }}
        >
          {domainShort}
        </span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{source.name}</span>
        <button
          onClick={() => onToggle(source.id, !source.active)}
          style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 3, cursor: 'pointer',
            border: 'none', background: source.active ? '#14532d' : '#374151',
            color: source.active ? '#86efac' : '#9ca3af', fontWeight: 600,
          }}
        >
          {source.active ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => onDelete(source.id)}
          style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 3, cursor: 'pointer',
            border: 'none', background: '#1f2937', color: '#f87171', fontWeight: 700,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>{subtitle(source)}</div>
    </div>
  );
}
