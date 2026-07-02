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
