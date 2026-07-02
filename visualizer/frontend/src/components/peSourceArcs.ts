/**
 * peSourceArcs — pure grouping of PE sources into provenance feed-forward
 * arcs for the interconnection graph (Manager#27).
 *
 * Integration-fed sensor sources (MQTT / OpenClaw / Ollama / HealthKit /
 * bare signals) write their region into the assembled perception vector;
 * every machine whose input mapping overlaps that region is stimulated.
 * This module computes, per provenance (`origin`, falling back to
 * 'sensor'), the set of target machines and aggregate overlap so the graph
 * can draw one provenance node with one arc per stimulated machine.
 *
 * Side-effect-free so it can be unit-tested without DOM/D3/React.
 */

/** Provenance colors shared by graph views. Fallback for unknown origins. */
export const PE_SOURCE_COLORS: Record<string, string> = {
  mqtt:      '#22c55e',
  openclaw:  '#ff6b35',
  acp:       '#ff6b35',
  ollama:    '#a78bfa',
  openai:    '#10a37f',
  healthkit: '#f472b6',
  signal:    '#facc15',
  sensor:    '#94a3b8',
};
export const peSourceColor = (origin: string) => PE_SOURCE_COLORS[origin] ?? '#94a3b8';
export const peSourceNodeId = (origin: string) => `pe-source:${origin}`;

export interface PeArcSource {
  type: string;
  active: boolean;
  origin?: string;
  region?: { offset: number; length: number };
}

export interface PeArcMachine {
  id: string;
  perceptualMapping?: {
    input: { offset: number; length: number };
  };
}

export interface PeArcTarget {
  overlap: number;
  count: number;
  targetRegion: { offset: number; length: number };
}

export interface PeSourceGroup {
  origin: string;
  sourceCount: number;
  envelope: { offset: number; length: number };
  perTarget: Map<string, PeArcTarget>;
}

/** Sensor-type, active, region-carrying sources — the arc-eligible subset. */
export function arcEligibleSources(sources: PeArcSource[]): PeArcSource[] {
  return sources.filter(s => s.type === 'sensor' && s.active && !!s.region);
}

/**
 * Group arc-eligible sources by provenance against a set of machines.
 * Only sources overlapping at least one machine's input mapping produce a
 * group entry; sourceCount counts contributing sources, perTarget carries
 * the aggregate overlap per stimulated machine.
 */
export function buildPeSourceGroups(
  sources: PeArcSource[],
  machines: PeArcMachine[],
): Map<string, PeSourceGroup> {
  const groups = new Map<string, PeSourceGroup>();
  for (const src of arcEligibleSources(sources)) {
    const origin = src.origin ?? 'sensor';
    const sOff = src.region!.offset;
    const sEnd = sOff + src.region!.length;
    let touched = false;
    for (const m of machines) {
      if (!m.perceptualMapping) continue;
      const ti = m.perceptualMapping.input;
      const overlap = Math.min(sEnd, ti.offset + ti.length) - Math.max(sOff, ti.offset);
      if (overlap <= 0) continue;
      let gr = groups.get(origin);
      if (!gr) {
        gr = {
          origin,
          sourceCount: 0,
          envelope: { offset: sOff, length: sEnd - sOff },
          perTarget: new Map(),
        };
        groups.set(origin, gr);
      }
      const t = gr.perTarget.get(m.id) ?? { overlap: 0, count: 0, targetRegion: ti };
      t.overlap += overlap;
      t.count++;
      gr.perTarget.set(m.id, t);
      const envMin = Math.min(gr.envelope.offset, sOff);
      const envMax = Math.max(gr.envelope.offset + gr.envelope.length, sEnd);
      gr.envelope = { offset: envMin, length: envMax - envMin };
      touched = true;
    }
    if (touched) groups.get(origin)!.sourceCount++;
  }
  return groups;
}

// ── Phase 2: domain-bus / portal arc routing ─────────────────────────────────

export interface ArcTargetInfo {
  domain: string;
  /** Domain interconnect bus node id, when one is present in the graph. */
  busId?: string;
  /** Domain OpenClaw portal node id, when one is present in the graph. */
  portalId?: string;
}

export interface RoutedArc {
  /** Node the arc terminates on — a machine, a domain bus, or a portal. */
  terminatorId: string;
  overlap: number;
  count: number;
  /** Stimulated machines represented by this arc (1 when direct). */
  machineIds: string[];
  targetRegion: { offset: number; length: number };
}

const OPENCLAW_ORIGINS = new Set(['openclaw', 'acp']);

/**
 * Route a provenance group's per-machine arcs onto domain aggregation
 * points. Per domain: OpenClaw-fed groups terminate on the domain's
 * OpenClaw portal when present (the completion "return" arc); otherwise,
 * when at least `minFanIn` machines of one domain are stimulated and the
 * domain has an interconnect bus, one arc terminates on the bus. Everything
 * else stays a direct machine arc. A machine that *is* the bus/portal is
 * always direct.
 */
export function routeArcsToBuses(
  perTarget: Map<string, PeArcTarget>,
  targetInfo: Map<string, ArcTargetInfo>,
  origin: string,
  minFanIn = 3,
): RoutedArc[] {
  const byDomain = new Map<string, Array<[string, PeArcTarget]>>();
  const direct: RoutedArc[] = [];

  for (const [machineId, t] of perTarget) {
    const info = targetInfo.get(machineId);
    if (!info) {
      direct.push({ terminatorId: machineId, overlap: t.overlap, count: t.count,
        machineIds: [machineId], targetRegion: t.targetRegion });
      continue;
    }
    const list = byDomain.get(info.domain) ?? [];
    list.push([machineId, t]);
    byDomain.set(info.domain, list);
  }

  const routed: RoutedArc[] = [...direct];
  for (const [domain, entries] of byDomain) {
    const info = targetInfo.get(entries[0][0])!;
    const isOpenClaw = OPENCLAW_ORIGINS.has(origin);
    const terminator = isOpenClaw && info.portalId
      ? info.portalId
      : entries.length >= minFanIn && info.busId
        ? info.busId
        : null;

    // The aggregation point may itself be a stimulated machine — keep it direct.
    const aggregatable = terminator
      ? entries.filter(([id]) => id !== terminator)
      : [];

    if (!terminator || aggregatable.length === 0) {
      for (const [id, t] of entries) {
        routed.push({ terminatorId: id, overlap: t.overlap, count: t.count,
          machineIds: [id], targetRegion: t.targetRegion });
      }
      continue;
    }

    let overlap = 0;
    let count = 0;
    let envMin = Infinity;
    let envMax = -Infinity;
    const machineIds: string[] = [];
    for (const [id, t] of aggregatable) {
      overlap += t.overlap;
      count += t.count;
      envMin = Math.min(envMin, t.targetRegion.offset);
      envMax = Math.max(envMax, t.targetRegion.offset + t.targetRegion.length);
      machineIds.push(id);
    }
    routed.push({ terminatorId: terminator, overlap, count, machineIds,
      targetRegion: { offset: envMin, length: envMax - envMin } });

    for (const [id, t] of entries) {
      if (id === terminator) {
        routed.push({ terminatorId: id, overlap: t.overlap, count: t.count,
          machineIds: [id], targetRegion: t.targetRegion });
      }
    }
    void domain;
  }
  return routed;
}
