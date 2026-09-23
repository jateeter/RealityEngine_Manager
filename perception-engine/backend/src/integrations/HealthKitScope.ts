/**
 * HealthKit scope and resync — localHealthkitBridge INGEST_CONTRACT.md,
 * "Scope and resync". The native runtimes hold it 3-of-3; this PE conforms.
 *
 * The data scope (which HealthKit types flow) changes through an
 * authorization workflow tied to the owner's Solid pod. The PE is the scope
 * authority. A bridge is open until its first scope message; from then on only
 * `active` types are ingested. Resync runs the other way: a consumer asks,
 * through the PE, for the producer to re-send.
 *
 * Pure: the routes do the HTTP and remove the sources this reports.
 */

export type ScopeState = 'active' | 'locked' | 'removed';

interface TypeEntry { state: ScopeState; source: string | null; updatedAt: number }
export interface ResyncRequest {
  id: string; bridgeId: string; types: string[]; requestedBy: string;
  requestedAt: number; state: 'pending' | 'fulfilled'; fulfilledAt: number | null;
}
interface Bridge {
  declared: boolean;
  generation: number;
  types: Map<string, TypeEntry>;
  sensors: Map<string, Set<string>>;
  resync: ResyncRequest[];
}

const STATES: Record<string, ScopeState> = { add: 'active', lock: 'locked', remove: 'removed' };

export class HealthKitScope {
  private readonly bridges = new Map<string, Bridge>();

  private of(id: string): Bridge {
    let b = this.bridges.get(id);
    if (!b) {
      b = { declared: false, generation: 0, types: new Map(), sensors: new Map(), resync: [] };
      this.bridges.set(id, b);
    }
    return b;
  }

  json(bridgeId: string): Record<string, unknown> {
    const b = this.of(bridgeId);
    const types: Record<string, TypeEntry> = {};
    for (const k of [...b.types.keys()].sort()) types[k] = { ...b.types.get(k)! };
    return { declared: b.declared, generation: b.generation, types, resyncRequests: b.resync.map((r) => ({ ...r })) };
  }

  /** null when the type may be ingested, otherwise the refusal reason. */
  refusal(bridgeId: string, type: string): 'locked' | 'not-in-scope' | null {
    const b = this.of(bridgeId);
    if (!b.declared) return null;
    const state = b.types.get(type)?.state;
    if (state === 'active') return null;
    return state === 'locked' ? 'locked' : 'not-in-scope';
  }

  noteSensor(bridgeId: string, type: string, sensorId: string): void {
    const b = this.of(bridgeId);
    const set = b.sensors.get(type) ?? new Set<string>();
    set.add(sensorId);
    b.sensors.set(type, set);
  }

  change(bridgeId: string, action: string, types: string[], source: string | null, now: number)
    : { ok: false; error: string } | { ok: true; body: Record<string, unknown>; removedSensors: string[] } {
    const target = STATES[action];
    if (!target) return { ok: false, error: 'scope action must be add, lock or remove' };
    if (types.length === 0) return { ok: false, error: 'scope requires a non-empty types array' };
    const b = this.of(bridgeId);
    b.declared = true;
    const removedSensors: string[] = [];
    const applied = types.map((type) => {
      const previous = b.types.get(type)?.state ?? null;
      b.types.set(type, { state: target, source, updatedAt: now });
      if (action === 'remove') {
        removedSensors.push(...[...(b.sensors.get(type) ?? [])].sort());
        b.sensors.delete(type);
      }
      return { type, state: target, previous };
    });
    b.generation += 1;
    return { ok: true, removedSensors, body: { success: true, bridgeId, action, generation: b.generation, applied } };
  }

  resync(bridgeId: string, types: string[], requestedBy: string | undefined, now: number, newId: () => string)
    : { status: number; body: Record<string, unknown> } {
    if (!requestedBy) return { status: 400, body: { error: 'resync requires requestedBy' } };
    const b = this.of(bridgeId);
    const requested = types.length > 0 ? types
      : b.declared ? [...b.types.entries()].filter(([, e]) => e.state === 'active').map(([t]) => t).sort()
      : [...b.sensors.keys()].sort();
    const accepted: string[] = [];
    const refused: Array<{ type: string; reason: string }> = [];
    for (const type of requested) {
      const state = b.types.get(type)?.state;
      const reason = !b.declared ? null : state === 'active' ? null : state === 'locked' ? 'locked' : 'not-in-scope';
      if (reason) refused.push({ type, reason }); else accepted.push(type);
    }
    if (accepted.length === 0) return { status: 409, body: { success: false, request: null, refused } };
    const request: ResyncRequest = {
      id: newId(), bridgeId, types: accepted, requestedBy, requestedAt: now, state: 'pending', fulfilledAt: null,
    };
    b.resync = [...b.resync, request].slice(-32);
    return { status: 202, body: { success: true, request: { ...request }, refused } };
  }

  fulfil(bridgeId: string, resyncId: string, now: number): void {
    for (const r of this.of(bridgeId).resync) {
      if (r.id === resyncId && r.state === 'pending') { r.state = 'fulfilled'; r.fulfilledAt = now; }
    }
  }
}
