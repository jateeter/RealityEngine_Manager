import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SourceConfig } from '../types.js';
import type { BootstrapResult, MachineSummary } from '../api.js';
import {
  DOMAINS, DOMAIN_ORDER, classifyMachine,
} from './machineDomains.js';
import type { DomainId } from './machineDomains.js';
import SourceCard from './SourceCard.js';

// Synthetic bucket id for sources that have no machine (simulated/sensor).
// Treated as a first-class filter row alongside the real domains so an
// operator can isolate manually-configured non-machine sources.
type FilterBucket = DomainId | 'other';

/**
 * BootstrapResultBanner — typed-reasons summary after an Import action.
 *
 * The bootstrap endpoint walks every machine × inputSequence and bins each
 * one of {created, alreadyExisted, outOfRange, noSequences, outsideFilter}.
 * The dominant skip in production is outOfRange: the visualizer mints
 * inputSequences at offsets up to PERCEPTUAL_DIM (currently 4128) but PE's
 * VECTOR_SIZE defaults to 256, so anything past that is silently dropped.
 * Surface the breakdown plainly so the operator can see why and act on it
 * (e.g. set VECTOR_SIZE=4128 in the PE env).
 */
function BootstrapResultBanner({ result, onDismiss }: { result: BootstrapResult; onDismiss: () => void }) {
  const r = result.reasons;
  const outOfRangeBlocking = (r?.outOfRange ?? 0) > 0;
  const recommendedSize = result.vectorSize ?? 256;

  return (
    <div style={{
      padding: '8px 12px', fontSize: 11,
      background: outOfRangeBlocking ? '#1c1407' : '#0f172a',
      borderBottom: `1px solid ${outOfRangeBlocking ? '#7c4d0c' : '#1e293b'}`,
      display: 'flex', flexDirection: 'column', gap: 4,
      color: '#cbd5e1',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
          background: result.created > 0 ? '#14532d' : '#1e293b',
          color: result.created > 0 ? '#86efac' : '#7dd3fc',
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}>
          {result.created > 0 ? `+${result.created} new` : 'no new sources'}
        </span>
        <span style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 10 }}>
          {result.machinesSeen} machines · vector size {recommendedSize}
        </span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            marginLeft: 'auto', background: 'transparent', border: 'none',
            color: '#64748b', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
          }}
        >
          ✕
        </button>
      </div>
      {r && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2,
          fontFamily: 'monospace', fontSize: 10, color: '#94a3b8',
        }}>
          {r.alreadyExisted > 0 && <span title="Sequence already imported"           >{r.alreadyExisted} already imported</span>}
          {r.outOfRange     > 0 && <span title="Offset/length exceeds PE vector size" style={{ color: '#fbbf24' }}>{r.outOfRange} out of range</span>}
          {r.noSequences    > 0 && <span title="Sequence missing name or vectors"    >{r.noSequences} invalid</span>}
          {r.outsideFilter  > 0 && <span title="Machine excluded by domain filter"   >{r.outsideFilter} filtered out</span>}
        </div>
      )}
      {outOfRangeBlocking && (
        <div style={{
          marginTop: 4, fontSize: 10.5, color: '#fbbf24',
          lineHeight: 1.45,
        }}>
          <strong>{r!.outOfRange} sequences exceed VECTOR_SIZE={recommendedSize}.</strong>{' '}
          Raise the PE's <code style={{ background: '#1c1407', padding: '0 4px', borderRadius: 3 }}>VECTOR_SIZE</code> env
          var (typically to 4128 to match the visualizer's <code>PERCEPTUAL_DIM</code>) and restart the PE container —
          these machines will then bootstrap on the next Import.
        </div>
      )}
      {result.errors?.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: '#fca5a5' }}>
          {result.errors.length} error{result.errors.length === 1 ? '' : 's'}: {result.errors[0]}
        </div>
      )}
    </div>
  );
}

interface Props {
  sources: SourceConfig[];
  machines: MachineSummary[];
  machineDomain: ReadonlyMap<string, DomainId>;
  onAdd: () => void;
  onBootstrap: (opts?: { machineIds?: string[] }) => Promise<BootstrapResult>;
  onRefreshMachines: () => Promise<void>;
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
  onToggleAll: (active: boolean) => void;
  onHover: (id: string | null) => void;
  hoveredSourceId: string | null;
}

export default function SourcesPanel({
  sources, machines, machineDomain,
  onAdd, onBootstrap, onRefreshMachines,
  onDelete, onToggle, onToggleAll,
  onHover, hoveredSourceId,
}: Props) {
  const [bootstrapping, setBootstrapping] = useState(false);
  // Last bootstrap response — drives the under-header status block.  Holds
  // the full reasons breakdown so the operator can see exactly why entries
  // were skipped (the dominant case is offset >= VECTOR_SIZE).
  const [lastBootstrap, setLastBootstrap] = useState<BootstrapResult | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  // Import-menu state.  Closed → just a button.  Open → popover with the
  // global "all" action plus a per-domain checklist.
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [importPicks, setImportPicks] = useState<Set<DomainId>>(() => new Set());
  const importBtnRef  = useRef<HTMLButtonElement>(null);
  const importMenuRef = useRef<HTMLDivElement>(null);

  // Viewport-anchored menu rect — recomputed on open / scroll / resize so
  // the portal-rendered menu sits flush against the button regardless of
  // parent overflow.  Without this the menu gets clipped by the panel's
  // overflow: hidden container.
  const [menuRect, setMenuRect] = useState<{ top: number; left: number } | null>(null);

  const MENU_WIDTH = 280;

  useLayoutEffect(() => {
    if (!importMenuOpen) { setMenuRect(null); return; }
    const update = () => {
      const btn = importBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      // Align menu's RIGHT edge with the button's right edge — i.e. menu
      // hangs leftward.  Clamp so its LEFT edge stays at least 8px inside
      // the viewport; without the clamp the menu gets cut off when the
      // button sits in a narrow left sidebar.
      const minLeft = 8;
      const maxLeft = Math.max(minLeft, window.innerWidth - MENU_WIDTH - 8);
      const idealLeft = r.right - MENU_WIDTH;
      const left = Math.min(maxLeft, Math.max(minLeft, idealLeft));
      setMenuRect({ top: r.bottom + 4, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [importMenuOpen]);

  // Source-list filter.  Empty = show everything (this matches the "all on"
  // affordance — same shape as the master toggle).  A user can drill down
  // to one or more domains; sources outside the active set are hidden.
  const [filter, setFilter] = useState<Set<FilterBucket>>(() => new Set());

  // ── Derived: which domains the loaded machine catalog actually covers ───
  // Drives both the import checklist and the filter chip row so we never
  // surface domains that have no machines / no sources to back them.
  const sourceBucket = (s: SourceConfig): FilterBucket => {
    if (s.type !== 'test') return 'other';
    const d = machineDomain.get(s.machineId);
    return d ?? 'other';
  };

  const machinesByDomain = useMemo(() => {
    const groups = new Map<DomainId, MachineSummary[]>();
    for (const m of machines) {
      const d = classifyMachine(m);
      let list = groups.get(d);
      if (!list) { list = []; groups.set(d, list); }
      list.push(m);
    }
    return groups;
  }, [machines]);

  const sourcesByBucket = useMemo(() => {
    const groups = new Map<FilterBucket, SourceConfig[]>();
    for (const s of sources) {
      const b = sourceBucket(s);
      let list = groups.get(b);
      if (!list) { list = []; groups.set(b, list); }
      list.push(s);
    }
    return groups;
    // sourceBucket closure captures machineDomain — that's what we depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, machineDomain]);

  // Visible filter rows: every domain that has either machines OR sources,
  // plus 'other' if there are any non-machine sources.
  const filterBuckets: FilterBucket[] = useMemo(() => {
    const out: FilterBucket[] = [];
    for (const d of DOMAIN_ORDER) {
      if (machinesByDomain.get(d)?.length || sourcesByBucket.get(d)?.length) out.push(d);
    }
    if ((sourcesByBucket.get('other')?.length ?? 0) > 0) out.push('other');
    return out;
  }, [machinesByDomain, sourcesByBucket]);

  const importableDomains: DomainId[] = useMemo(() => {
    const out: DomainId[] = [];
    for (const d of DOMAIN_ORDER) if ((machinesByDomain.get(d)?.length ?? 0) > 0) out.push(d);
    return out;
  }, [machinesByDomain]);

  // Filter logic — empty set means "no filter applied".  This is symmetric
  // with the master toggle's "all on" semantics so the UI doesn't have to
  // distinguish between "filter unset" and "filter has every bucket".
  const filterActive    = filter.size > 0;
  const visibleSources  = !filterActive
    ? sources
    : sources.filter(s => filter.has(sourceBucket(s)));

  // ── Master toggle (acts on the filtered set, not the global list) ─────
  // Operators expect the master toggle to follow what they're looking at:
  // if the filter shows only Agriculture, "all on" should flip on only the
  // Ag sources.  This matches the principle of least surprise.
  const totalShown   = visibleSources.length;
  const activeShown  = visibleSources.filter(s => s.active).length;
  const allShownOn   = totalShown > 0 && activeShown === totalShown;
  const allShownOff  = activeShown === 0;
  const partial      = !allShownOn && !allShownOff;
  const handleAllClick = () => {
    if (totalShown === 0) return;
    const target = !allShownOn;
    // If a filter is active, toggle ONLY those sources by routing through
    // per-id updates; the parent's onToggleAll flips every source.
    if (filterActive) {
      visibleSources.filter(s => s.active !== target).forEach(s => onToggle(s.id, target));
    } else {
      onToggleAll(target);
    }
  };
  const checkboxLabel = totalShown === 0
    ? 'No sources'
    : allShownOn
      ? 'All shown sources on — click to disable'
      : partial
        ? `${activeShown}/${totalShown} active — click to enable all shown`
        : 'All shown sources off — click to enable';

  // ── Filter chip handlers ──────────────────────────────────────────────
  const toggleFilter = (b: FilterBucket) => {
    setFilter(prev => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });
  };
  const clearFilter = () => setFilter(new Set());

  // ── Import popover handlers ───────────────────────────────────────────
  // Refresh the machine list every time the menu opens so a freshly
  // imported domain shows up without a page reload.
  useEffect(() => {
    if (importMenuOpen) void onRefreshMachines();
  }, [importMenuOpen, onRefreshMachines]);

  useEffect(() => {
    if (!importMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (importMenuRef.current?.contains(t)) return;
      if (importBtnRef.current?.contains(t))  return;
      setImportMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setImportMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown',   onKey);
    };
  }, [importMenuOpen]);

  const togglePick = (d: DomainId) => {
    setImportPicks(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });
  };

  const runImport = async (opts?: { machineIds?: string[] }) => {
    if (bootstrapping) return;
    setBootstrapping(true);
    setLastBootstrap(null);
    setBootstrapError(null);
    setImportMenuOpen(false);
    try {
      const r = await onBootstrap(opts);
      setLastBootstrap(r);
    } catch (err: any) {
      setBootstrapError(`Bootstrap failed: ${err?.message ?? String(err)}`);
    } finally {
      setBootstrapping(false);
      // Auto-dismiss after a longer window since the breakdown often warrants
      // a close read.  Errors stay until the next attempt.
      window.setTimeout(() => setLastBootstrap(null), 12000);
    }
  };

  const handleImportAll = () => runImport();

  const handleImportPicked = () => {
    if (importPicks.size === 0) return;
    const ids: string[] = [];
    for (const d of importPicks) for (const m of machinesByDomain.get(d) ?? []) ids.push(m.id);
    void runImport({ machineIds: ids });
  };

  const labelOfBucket = (b: FilterBucket): string =>
    b === 'other' ? 'Other' : DOMAINS[b].label;
  const colorOfBucket = (b: FilterBucket): string =>
    b === 'other' ? '#94a3b8' : DOMAINS[b].color;

  return (
    <div style={{
      width: 300, flexShrink: 0,
      borderRight: '1px solid #1e293b',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden', background: '#0a0f1e',
    }}>
      <div style={{
        padding: '10px 12px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8,
      }}>
        {/* Master toggle — tri-state, scoped to the filtered set */}
        <button
          type="button"
          role="checkbox"
          aria-checked={allShownOn ? 'true' : partial ? 'mixed' : 'false'}
          aria-label={checkboxLabel}
          title={checkboxLabel}
          onClick={handleAllClick}
          disabled={totalShown === 0}
          style={{
            width: 16, height: 16,
            flexShrink: 0,
            borderRadius: 3,
            border: `1.5px solid ${allShownOn ? '#3b82f6' : partial ? '#7dd3fc' : '#475569'}`,
            background: allShownOn ? '#1e3a5f' : 'transparent',
            cursor: totalShown === 0 ? 'not-allowed' : 'pointer',
            opacity: totalShown === 0 ? 0.4 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0,
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          {allShownOn && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 5.2L4.2 7.5L8.2 2.5" stroke="#7dd3fc" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {partial && (
            <span style={{ width: 8, height: 2, background: '#7dd3fc', borderRadius: 1 }} />
          )}
        </button>

        <span style={{
          fontWeight: 700, fontSize: 12, color: '#94a3b8',
          textTransform: 'uppercase', letterSpacing: 1,
          flex: 1,
        }}>
          Sources ({filterActive ? `${visibleSources.length}/${sources.length}` : sources.length})
        </span>

        {/* Import button + popover */}
        <div style={{ position: 'relative' }}>
          <button
            ref={importBtnRef}
            onClick={() => setImportMenuOpen(o => !o)}
            disabled={bootstrapping}
            title="Import test sources from machine inputSequences — pick domains or import everything"
            aria-expanded={importMenuOpen}
            aria-haspopup="menu"
            style={{
              padding: '3px 10px', borderRadius: 4, border: '1px solid #334155',
              background: bootstrapping ? '#0f172a' : '#1e293b',
              color: bootstrapping ? '#475569' : '#94a3b8', fontSize: 12,
              fontWeight: 600, cursor: bootstrapping ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {bootstrapping ? '…' : 'Import'}
            <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
          </button>
          {importMenuOpen && menuRect && createPortal(
            <div
              ref={importMenuRef}
              role="menu"
              // Rendered via portal so it escapes the panel's overflow: hidden.
              // Position is fixed-relative and recomputed on open/scroll/resize
              // via useLayoutEffect above.
              style={{
                position: 'fixed', top: menuRect.top, left: menuRect.left,
                width: MENU_WIDTH, maxHeight: 'min(60vh, 420px)', overflowY: 'auto',
                background: '#0f172a', border: '1px solid #1e293b',
                borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                zIndex: 1000,
                padding: 8,
              }}
            >
              <button
                onClick={handleImportAll}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '7px 10px', borderRadius: 4,
                  border: '1px solid #3b82f6',
                  background: '#1e3a5f', color: '#7dd3fc',
                  fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  marginBottom: 8,
                }}
              >
                Import all machines ({machines.length})
              </button>
              <div style={{
                fontSize: 10, color: '#64748b',
                textTransform: 'uppercase', letterSpacing: 1,
                margin: '4px 4px 6px 4px',
              }}>
                Or by domain
              </div>
              {importableDomains.length === 0 ? (
                <div style={{ fontSize: 11, color: '#64748b', padding: '6px 8px' }}>
                  No machines loaded.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {importableDomains.map(d => {
                    const list = machinesByDomain.get(d) ?? [];
                    const picked = importPicks.has(d);
                    return (
                      <label
                        key={d}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 8px', borderRadius: 4,
                          background: picked ? '#1e293b' : 'transparent',
                          border: `1px solid ${picked ? DOMAINS[d].color + '88' : 'transparent'}`,
                          cursor: 'pointer', fontSize: 12, color: '#cbd5e1',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={() => togglePick(d)}
                          style={{ accentColor: DOMAINS[d].color, margin: 0 }}
                        />
                        <span style={{
                          width: 9, height: 9, borderRadius: 2,
                          background: DOMAINS[d].color, flexShrink: 0,
                        }} />
                        <span style={{ flex: 1 }}>{DOMAINS[d].label}</span>
                        <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
                          {list.length}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button
                  onClick={handleImportPicked}
                  disabled={importPicks.size === 0}
                  style={{
                    flex: 1, padding: '6px 10px', borderRadius: 4,
                    border: '1px solid #3b82f6',
                    background: importPicks.size === 0 ? '#0f172a' : '#1e3a5f',
                    color: importPicks.size === 0 ? '#475569' : '#7dd3fc',
                    fontSize: 12, fontWeight: 700,
                    cursor: importPicks.size === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  Import selected
                </button>
                <button
                  onClick={() => setImportPicks(new Set())}
                  disabled={importPicks.size === 0}
                  style={{
                    padding: '6px 10px', borderRadius: 4,
                    border: '1px solid #334155',
                    background: 'transparent', color: '#94a3b8',
                    fontSize: 12, fontWeight: 600,
                    cursor: importPicks.size === 0 ? 'not-allowed' : 'pointer',
                    opacity: importPicks.size === 0 ? 0.5 : 1,
                  }}
                >
                  Clear
                </button>
              </div>
            </div>,
            document.body,
          )}
        </div>

        <button
          onClick={onAdd}
          style={{
            padding: '3px 10px', borderRadius: 4, border: '1px solid #3b82f6',
            background: '#1e3a5f', color: '#7dd3fc', fontSize: 12,
            fontWeight: 600, cursor: 'pointer',
          }}
        >
          + Add
        </button>
      </div>

      {bootstrapError && (
        <div style={{
          padding: '6px 12px', fontSize: 11, color: '#fca5a5',
          background: '#1f1010', borderBottom: '1px solid #3f1d1d',
        }}>
          {bootstrapError}
        </div>
      )}
      {lastBootstrap && <BootstrapResultBanner result={lastBootstrap} onDismiss={() => setLastBootstrap(null)} />}

      {/* Domain filter chips.  Shown only when there's at least one bucket
          worth filtering on; otherwise the row collapses to keep the panel
          tight on tiny universes (e.g. a fresh start with no machines). */}
      {filterBuckets.length > 0 && (
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid #1e293b',
          background: '#0a0f1e',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 5,
          }}>
            <span style={{
              fontSize: 9, color: '#475569',
              textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700,
            }}>
              Filter by domain
            </span>
            {filterActive && (
              <button
                onClick={clearFilter}
                style={{
                  background: 'transparent', border: 'none',
                  color: '#7dd3fc', fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', padding: 0,
                }}
              >
                clear ({filter.size})
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {filterBuckets.map(b => {
              const count = sourcesByBucket.get(b)?.length ?? 0;
              const on = filter.has(b);
              const color = colorOfBucket(b);
              return (
                <button
                  key={b}
                  onClick={() => toggleFilter(b)}
                  title={`${labelOfBucket(b)} — ${count} source${count === 1 ? '' : 's'}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 7px', borderRadius: 10,
                    border: `1px solid ${on ? color : '#1e293b'}`,
                    background: on ? color + '22' : '#0f172a',
                    color: on ? color : '#64748b',
                    fontSize: 10, fontWeight: 600, cursor: 'pointer',
                    transition: 'all 0.12s ease',
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', background: color,
                    opacity: on ? 1 : 0.55,
                  }} />
                  {labelOfBucket(b)}
                  <span style={{
                    fontSize: 9, fontFamily: 'monospace',
                    color: on ? color : '#475569', opacity: 0.85,
                  }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        {sources.length === 0 ? (
          <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', marginTop: 24 }}>
            No sources yet.<br />Click + Add to create one, or Import to populate from machines.
          </div>
        ) : visibleSources.length === 0 ? (
          <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', marginTop: 24 }}>
            No sources match the active filter.<br />
            <button
              onClick={clearFilter}
              style={{
                marginTop: 8, padding: '4px 10px', borderRadius: 4,
                border: '1px solid #334155', background: '#0f172a',
                color: '#7dd3fc', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Clear filter
            </button>
          </div>
        ) : (
          visibleSources.map(src => (
            <SourceCard
              key={src.id}
              source={src}
              domain={sourceBucket(src)}
              onDelete={onDelete}
              onToggle={onToggle}
              onHover={onHover}
              hovered={hoveredSourceId === src.id}
            />
          ))
        )}
      </div>
    </div>
  );
}
