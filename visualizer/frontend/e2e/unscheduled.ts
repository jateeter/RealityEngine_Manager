// Mirrors RealityEngine_CI/e2e/lib/unscheduled.ts (its unit tests live there).
// Change the two together: a rule that differs between the CI and Manager
// equivalence specs would let one pass what the other fails.
/**
 * What a cross-engine byte comparison sets aside before it compares
 * (RealityEngine_CI#518). Two things, each recognisable from the body alone:
 *
 * **Minted identity.** Every runtime mints the ids it invents as
 * `<kind>-<uuid>` (`machine-…`, `source-…`), so the three engines are unique
 * in the universe and a minted id is recognisable by shape: corpus ids are
 * never UUIDs. A minted id differs by construction between engines and is
 * never compared (SURFACE_SPEC.md, engine-specific ids). Each is replaced with
 * `minted:<kind>`, keeping the kind, so a body that gains or loses an id still
 * fails.
 *
 * **Unscheduled slots.** Some sources appear on their own schedule, not the
 * engines': localAIStack's HealthKit slots (`localai/health/slot/<band>`) come
 * and go with each engine's HealthKit scope and a reconciliation loop, so two
 * engines in parity can be compared a moment apart and differ only in which
 * slots exist yet. A slot is any source with a `slot` segment in its name.
 * Slot sources are dropped from every list, as is any entry that sits over a
 * slot's region, and a slot's cells in a perceptual vector are zeroed. What
 * remains is still compared byte for byte.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The kind is everything before the UUID: `machine`, `source`, and the composed
// forms a runtime derives from them (`test-machine` for a test source built on
// a minted machine). Bare UUIDs are minted too.
const MINTED = new RegExp(`(?:\\b([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-)?(${UUID})\\b`, 'gi');

/** `text` with every minted id replaced by `minted:<kind>`. */
export function withoutMintedIds(text: string): string {
  return text.replace(MINTED, (_m, kind: string | undefined) => `minted:${kind ? kind.toLowerCase() : 'id'}`);
}

/** True when a source name has a `slot` segment: `localai/health/slot/pulse`. */
export function isSlotName(name: unknown): boolean {
  return typeof name === 'string' && /(^|\/)slot(\/|$)/.test(name);
}

export type Region = readonly [offset: number, length: number];

function regionOf(entry: Record<string, unknown>): Region | null {
  const r = entry.region as Record<string, unknown> | undefined;
  if (r && typeof r.offset === 'number' && typeof r.length === 'number') return [r.offset, r.length];
  if (typeof entry.offset === 'number' && typeof entry.length === 'number') return [entry.offset, entry.length];
  return null;
}

/** The regions of every slot source found anywhere in `value`. */
export function slotRegionsOf(value: unknown, into: Region[] = []): Region[] {
  if (Array.isArray(value)) {
    for (const v of value) slotRegionsOf(v, into);
  } else if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>;
    const region = regionOf(entry);
    if (region && isSlotName(entry.name)) into.push(region);
    for (const v of Object.values(entry)) slotRegionsOf(v, into);
  }
  return into;
}

function insideSlot(region: Region, slots: readonly Region[]): boolean {
  const [o, l] = region;
  return slots.some(([so, sl]) => o >= so && o + Math.max(l, 1) <= so + sl);
}

function isSlotEntry(value: unknown, slots: readonly Region[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (isSlotName(entry.name)) return true;
  const region = regionOf(entry);
  return region !== null && slots.length > 0 && insideSlot(region, slots);
}

/** `value` with slot sources, entries over slot regions, and slot cells removed. */
export function withoutSlots(value: unknown, slots: readonly Region[]): unknown {
  if (Array.isArray(value)) {
    const end = slots.reduce((m, [o, l]) => Math.max(m, o + l), 0);
    if (end > 0 && value.length >= end && value.every(v => typeof v === 'number')) {
      const masked = [...value] as number[];
      for (const [o, l] of slots) for (let i = o; i < o + l; i++) masked[i] = 0;
      return masked;
    }
    return value.filter(v => !isSlotEntry(v, slots)).map(v => withoutSlots(v, slots));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withoutSlots(v, slots)]));
  }
  return value;
}
