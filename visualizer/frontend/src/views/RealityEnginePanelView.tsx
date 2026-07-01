import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useVisualizerStore } from '../store';
import { Machine, HealthStatus, EngineActive, PEState } from '../types';
import { EngineSwitcher } from '../components/EngineSwitcher';
import { MachineGraphView } from '../components/MachineGraphView';
import { SettingsModal } from '../components/SettingsModal';
import {
  classifyMachine,
  DOMAINS,
  DOMAIN_ORDER,
  DomainId,
} from '../components/machineDomains';
import {
  SequenceTooltip,
  EMPTY_LIVE,
} from '../components/MachineSequenceTooltip';
import type {
  TooltipState,
  TooltipMachineData,
  TooltipSeqNode,
  TooltipVectorElement,
} from '../components/MachineSequenceTooltip';
import './RealityEnginePanelView.css';

// ── Surface status polling ────────────────────────────────────────────────────
// Polls RE and PE health + engine-active every STATUS_POLL_MS milliseconds.
// Uses a shared AbortController so inflight requests are cancelled on unmount.

const STATUS_POLL_MS = 6_000;

interface SurfaceStatus {
  reHealth:   HealthStatus | null;
  peHealth:   HealthStatus | null;
  peState:    PEState | null;
  engineActive: EngineActive | null;
  reError:    boolean;
  peError:    boolean;
}

function useSurfaceStatus(): SurfaceStatus {
  const [status, setStatus] = useState<SurfaceStatus>({
    reHealth: null, peHealth: null, peState: null, engineActive: null,
    reError: false, peError: false,
  });

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const [reH, peH, peS, eng] = await Promise.allSettled([
        fetch('/api/health').then(r => r.json()),
        fetch('/api/pe/health').then(r => r.json()),
        fetch('/api/pe/state').then(r => r.json()),
        fetch('/api/engine/active').then(r => r.json()),
      ]);

      if (cancelled) return;

      setStatus({
        reHealth:     reH.status === 'fulfilled' ? reH.value  : null,
        peHealth:     peH.status === 'fulfilled' ? peH.value  : null,
        peState:      peS.status === 'fulfilled' ? peS.value  : null,
        engineActive: eng.status === 'fulfilled' ? eng.value  : null,
        reError:      reH.status === 'rejected',
        peError:      peH.status === 'rejected',
      });
    };

    poll();
    const id = setInterval(poll, STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}

// ── Tree node types ──────────────────────────────────────────────────────────

type DomainNode = {
  kind: 'domain';
  id: string;
  domainId: DomainId;
  label: string;
  color: string;
  machineCount: number;
  cesCount: number;
  children: MachineNode[];
};

type MachineNode = {
  kind: 'machine';
  id: string;
  domainId: DomainId;
  machine: Machine;
  children: CesNode[];
};

type CesNode = {
  kind: 'ces';
  id: string;
  domainId: DomainId;
  machineId: string;
  sequenceId: string;
  sequenceName: string;
};

type FlatRow =
  | { node: DomainNode; depth: 0 }
  | { node: MachineNode; depth: 1 }
  | { node: CesNode; depth: 2 };

// ── StatusPill — RE / PE health indicator ────────────────────────────────────

interface StatusPillProps {
  label: string;
  health: HealthStatus | null;
  error: boolean;
  title?: string;
}

const StatusPill: React.FC<StatusPillProps> = ({ label, health, error, title }) => {
  const dotClass = error
    ? 'is-error'
    : health == null
      ? 'is-pending'
      : health.status === 'healthy'
        ? 'is-ok'
        : 'is-warn';

  const statusText = error
    ? 'offline'
    : health == null
      ? '…'
      : health.status;

  return (
    <span className="rep-status-item" title={title}>
      <span className={`rep-status-dot ${dotClass}`} />
      <span className="rep-status-text">
        {label}
        <span className="rep-status-dim"> {statusText}</span>
        {health?.version && <span className="rep-status-dim"> {health.version}</span>}
      </span>
    </span>
  );
};

// ── Help content ─────────────────────────────────────────────────────────────

const KEYBOARD_SHORTCUTS: [string, string][] = [
  ['↑ / ↓',       'Move focus up or down'],
  ['→',           'Expand node, or enter first child'],
  ['←',           'Collapse node, or jump to parent'],
  ['Enter / Space','Toggle expand / collapse'],
  ['Home',        'Jump to first row'],
  ['End',         'Jump to last row'],
  ['Esc',         'Close this panel'],
];

// ── Component ────────────────────────────────────────────────────────────────

const RealityEnginePanelView: React.FC = () => {
  const { machines, setMachines, setCurrentView } = useVisualizerStore();
  const surface = useSurfaceStatus();

  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode,  setFilterMode]  = useState<'all' | 'examples' | 'custom'>('all');
  const [sortMode,    setSortMode]    = useState<'name' | 'recent' | 'sequences'>('name');
  const [isLoading,   setIsLoading]   = useState(false);
  const [showHelp,     setShowHelp]     = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const settingsGearRef = useRef<HTMLButtonElement>(null);
  const [expanded,    setExpanded]    = useState<Set<string>>(() => new Set<string>());
  const [focusedId,   setFocusedId]   = useState<string | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // ── Sequence tooltip (machine hover) ────────────────────────────────────
  const [seqTooltip, setSeqTooltip] = useState<TooltipState | null>(null);
  const seqCacheRef = useRef<Map<string, TooltipMachineData>>(new Map());
  const seqTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load machines ────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const { api } = await import('../api');
        setMachines(await api.getMachines());
      } catch (err) {
        console.error('Error loading machines:', err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [setMachines]);

  // ── Build domain → machine → CES tree ───────────────────────────────────
  const tree: DomainNode[] = useMemo(() => {
    let filtered = machines;
    const q = searchQuery.trim().toLowerCase();

    if (q) {
      filtered = filtered.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.sequences?.some(s => s.name.toLowerCase().includes(q))
      );
    }
    if (filterMode === 'examples') filtered = filtered.filter(m =>  m.isExample);
    if (filterMode === 'custom')   filtered = filtered.filter(m => !m.isExample);

    const sorted = [...filtered].sort((a, b) => {
      switch (sortMode) {
        case 'name':      return a.name.localeCompare(b.name);
        case 'recent':    return (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0);
        case 'sequences': return b.sequenceCount - a.sequenceCount;
        default:          return 0;
      }
    });

    const groups = new Map<DomainId, Machine[]>();
    for (const m of sorted) {
      const d = classifyMachine(m).domain;
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(m);
    }

    return DOMAIN_ORDER
      .filter(id => (groups.get(id)?.length ?? 0) > 0)
      .map(domainId => {
        const list = groups.get(domainId)!;
        const def  = DOMAINS[domainId];

        const machineNodes: MachineNode[] = list.map(m => {
          const seqs = m.sequences ?? [];
          const filteredSeqs = q
            ? seqs.filter(s => s.name.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
            : seqs;
          return {
            kind: 'machine',
            id: `machine:${m.id}`,
            domainId,
            machine: m,
            children: filteredSeqs.map(s => ({
              kind: 'ces',
              id: `ces:${m.id}:${s.id}`,
              domainId,
              machineId: m.id,
              sequenceId: s.id,
              sequenceName: s.name,
            })),
          };
        });

        return {
          kind: 'domain',
          id: `domain:${domainId}`,
          domainId,
          label: def.label,
          color: def.color,
          machineCount: machineNodes.length,
          cesCount: machineNodes.reduce((n, mn) => n + mn.machine.sequenceCount, 0),
          children: machineNodes,
        } satisfies DomainNode;
      });
  }, [machines, searchQuery, filterMode, sortMode]);

  // ── Auto-expand during search ────────────────────────────────────────────
  const baselineExpansion = useRef<Set<string> | null>(null);
  useEffect(() => {
    const q = searchQuery.trim();
    if (q) {
      if (!baselineExpansion.current) baselineExpansion.current = new Set(expanded);
      const next = new Set(expanded);
      for (const d of tree) {
        next.add(d.id);
        for (const m of d.children) if (m.children.length > 0) next.add(m.id);
      }
      setExpanded(next);
    } else if (baselineExpansion.current) {
      setExpanded(baselineExpansion.current);
      baselineExpansion.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, tree]);

  // ── Flatten visible rows ─────────────────────────────────────────────────
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const d of tree) {
      rows.push({ node: d, depth: 0 });
      if (!expanded.has(d.id)) continue;
      for (const m of d.children) {
        rows.push({ node: m, depth: 1 });
        if (!expanded.has(m.id)) continue;
        for (const c of m.children) rows.push({ node: c, depth: 2 });
      }
    }
    return rows;
  }, [tree, expanded]);

  useEffect(() => {
    if (focusedId && flatRows.some(r => r.node.id === focusedId)) return;
    setFocusedId(flatRows[0]?.node.id ?? null);
  }, [flatRows, focusedId]);

  const showSeqTooltip = useCallback((id: string, name: string, x: number, y: number) => {
    setSeqTooltip(prev => {
      if (prev?.pinned) return prev;
      return { machineId: id, name, x, y, pinned: false, data: null };
    });

    const cached = seqCacheRef.current.get(id);
    if (cached) {
      setSeqTooltip(prev => prev?.machineId === id ? { ...prev, data: cached } : prev);
      return;
    }

    fetch(`/api/machines/${id}/export`)
      .then(r => r.json())
      .then((json: any) => {
        const m = json.machine ?? json;
        const data: TooltipMachineData = {
          id,
          name:        m.name        ?? name,
          description: m.description ?? '',
          sequences: (m.sequences ?? []).map((seq: any) => {
            const nodes: TooltipSeqNode[] = (seq.vectors ?? []).map((v: any) => ({
              id:        v.id,
              label:     v.metadata?.name ?? v.id.slice(-6),
              isInitial: v.isInitial ?? false,
              hasOutput: Array.isArray(v.outputVectors) && v.outputVectors.length > 0,
              elements:  Array.isArray(v.elements) ? (v.elements as TooltipVectorElement[]) : [],
            }));
            const edges: Array<{ source: string; target: string }> = [];
            for (const v of (seq.vectors ?? [])) {
              for (const nid of (v.nextVectorIds ?? [])) edges.push({ source: v.id, target: nid });
            }
            return { sequenceId: seq.id, name: seq.name, nodes, edges };
          }),
        };
        seqCacheRef.current.set(id, data);
        setSeqTooltip(prev => prev?.machineId === id ? { ...prev, data } : prev);
      })
      .catch(() => {});
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const toggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const focusAndScroll = useCallback((id: string) => {
    setFocusedId(id);
    rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' });
  }, []);

  const expandAll = useCallback(() => {
    const next = new Set<string>();
    for (const d of tree) {
      next.add(d.id);
      for (const m of d.children) if (m.children.length > 0) next.add(m.id);
    }
    setExpanded(next);
  }, [tree]);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  const handleKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!focusedId) return;
    const idx = flatRows.findIndex(r => r.node.id === focusedId);
    if (idx === -1) return;
    const row = flatRows[idx];
    const n   = row.node;

    switch (e.key) {
      case 'ArrowDown': {
        const next = flatRows[idx + 1];
        if (next) { e.preventDefault(); focusAndScroll(next.node.id); }
        break;
      }
      case 'ArrowUp': {
        const prev = flatRows[idx - 1];
        if (prev) { e.preventDefault(); focusAndScroll(prev.node.id); }
        break;
      }
      case 'ArrowRight': {
        if (n.kind === 'ces') break;
        e.preventDefault();
        if (!expanded.has(n.id)) {
          if (n.children.length > 0) toggle(n.id);
        } else {
          const next = flatRows[idx + 1];
          if (next && next.depth > row.depth) focusAndScroll(next.node.id);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if ((n.kind === 'domain' || n.kind === 'machine') && expanded.has(n.id)) {
          toggle(n.id);
        } else {
          for (let j = idx - 1; j >= 0; j--) {
            if (flatRows[j].depth < row.depth) { focusAndScroll(flatRows[j].node.id); break; }
          }
        }
        break;
      }
      case 'Home':
        if (flatRows[0]) { e.preventDefault(); focusAndScroll(flatRows[0].node.id); }
        break;
      case 'End':
        if (flatRows.length) { e.preventDefault(); focusAndScroll(flatRows[flatRows.length - 1].node.id); }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (n.kind === 'domain' || n.kind === 'machine') toggle(n.id);
        break;
    }
  }, [flatRows, focusedId, expanded, toggle, focusAndScroll]);

  // ── Help Esc handler ─────────────────────────────────────────────────────
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowHelp(false); };
    if (showHelp) window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [showHelp]);

  // ── Derived stats ────────────────────────────────────────────────────────
  const totalMachines = tree.reduce((n, d) => n + d.machineCount, 0);
  const totalCES      = tree.reduce((n, d) => n + d.cesCount,     0);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="rep-root">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="rep-header">

        <div className="rep-wordmark">
          <div className="rep-title">
            Reality<span className="rep-title-accent"> Engine</span>
          </div>
          <div className="rep-subtitle">perception · sequence · visualization</div>
        </div>

        <div className="rep-header-center">
          <div className="rep-search-wrap">
            <span className="rep-search-icon">⌕</span>
            <input
              type="text"
              className="rep-search"
              placeholder="search domains · machines · CES…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="rep-search-clear" onClick={() => setSearchQuery('')} title="Clear search">✕</button>
            )}
          </div>
        </div>

        <div className="rep-header-right">
          <EngineSwitcher />

          <button
            className="rep-nav-btn rep-nav-interconnect"
            onClick={() => setCurrentView('interconnection')}
            title="Open interconnection graph"
          >
            <span className="rep-btn-icon">⚡</span>
            Interconnect
          </button>

          <button
            className="rep-nav-btn"
            onClick={() => setCurrentView('perceptual-engine')}
            title="Open Perception Engine management"
            style={{ borderColor: 'rgba(125,211,252,0.3)', color: '#7dd3fc' }}
          >
            <span className="rep-btn-icon">◎</span>
            Perception
          </button>

          <button
            className={`rep-help-btn${showHelp ? ' is-active' : ''}`}
            onClick={() => setShowHelp(v => !v)}
            aria-label="Help"
            title="Keyboard shortcuts and navigation"
          >
            ?
          </button>

          <button
            ref={settingsGearRef}
            className={`rep-help-btn rep-settings-btn${showSettings ? ' is-active' : ''}`}
            onClick={() => setShowSettings(v => !v)}
            aria-label="Visualizer settings"
            title="Visualizer settings"
          >
            ⚙
          </button>
        </div>

      </header>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="rep-toolbar">

        <div className="rep-filter-group">
          {(['all', 'examples', 'custom'] as const).map(mode => (
            <button
              key={mode}
              className={`rep-filter-btn${filterMode === mode ? ' is-active' : ''}`}
              onClick={() => setFilterMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>

        <div className="rep-toolbar-stats">
          <span className="rep-stat-value">{totalMachines}</span>
          <span className="rep-stat-label"> machines</span>
          <span className="rep-stat-sep">·</span>
          <span className="rep-stat-value">{totalCES}</span>
          <span className="rep-stat-label"> CES</span>
          <span className="rep-stat-sep">·</span>
          <span className="rep-stat-value">{tree.length}</span>
          <span className="rep-stat-label"> domains</span>
        </div>

        <div className="rep-toolbar-right">
          <div className="rep-tree-controls">
            <button className="rep-tree-btn" onClick={expandAll}  title="Expand all">expand all</button>
            <button className="rep-tree-btn" onClick={collapseAll} title="Collapse all">collapse all</button>
          </div>
          <div className="rep-sort-group">
            <span className="rep-sort-label">sort</span>
            <select
              className="rep-sort-select"
              value={sortMode}
              onChange={e => setSortMode(e.target.value as typeof sortMode)}
            >
              <option value="name">name</option>
              <option value="recent">last accessed</option>
              <option value="sequences">sequences</option>
            </select>
          </div>
        </div>

      </div>

      {/* ── Main split: tree (left) · interconnection graph (right) ────── */}
      <div className="rep-main">

      {/* ── Tree body ──────────────────────────────────────────────────── */}
      <div className="rep-body">
        {isLoading ? (
          <div className="rep-empty">
            <div className="rep-empty-pulse" />
            <span className="rep-empty-text">loading machines…</span>
          </div>
        ) : flatRows.length === 0 ? (
          <div className="rep-empty">
            <span className="rep-empty-text">
              {searchQuery || filterMode !== 'all' ? 'no machines found' : 'no machines available'}
            </span>
            <span className="rep-empty-hint">
              {searchQuery ? 'try a different search term' : 'no machines loaded'}
            </span>
          </div>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Machines grouped by domain"
            className="rep-tree"
            tabIndex={0}
            onKeyDown={handleKey}
          >
            {flatRows.map(row => {
              const n        = row.node;
              const isFocused = focusedId === n.id;
              const isExp    = (n.kind === 'domain' || n.kind === 'machine') && expanded.has(n.id);
              const hasKids  = (n.kind === 'domain' || n.kind === 'machine') && (n.children?.length ?? 0) > 0;
              const ref = (el: HTMLDivElement | null) => {
                if (el) rowRefs.current.set(n.id, el);
                else    rowRefs.current.delete(n.id);
              };

              if (n.kind === 'domain') return (
                <div
                  key={n.id}
                  ref={ref}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={hasKids ? isExp : undefined}
                  aria-selected={isFocused}
                  className={`rep-row rep-row-domain${isFocused ? ' is-focused' : ''}`}
                  style={{ ['--dc' as any]: n.color }}
                  onClick={() => { setFocusedId(n.id); toggle(n.id); }}
                >
                  <span className={`rep-chevron${isExp ? ' is-open' : ''}`}>▶</span>
                  <span className="rep-domain-swatch" style={{ background: n.color }} />
                  <span className="rep-row-label rep-domain-label">{n.label}</span>
                  <span className="rep-row-meta">
                    {n.machineCount}<span className="rep-meta-unit"> m</span>
                    <span className="rep-meta-dot">·</span>
                    {n.cesCount}<span className="rep-meta-unit"> ces</span>
                  </span>
                </div>
              );

              if (n.kind === 'machine') {
                const m          = n.machine;
                const seqCount   = m.sequenceCount ?? n.children.length;
                const lifeSafety = String(m.severity ?? '') === 'life-safety';
                return (
                  <div
                    key={n.id}
                    ref={ref}
                    role="treeitem"
                    aria-level={2}
                    aria-expanded={hasKids ? isExp : undefined}
                    aria-selected={isFocused}
                    className={`rep-row rep-row-machine${isFocused ? ' is-focused' : ''}`}
                    style={{ ['--dc' as any]: DOMAINS[n.domainId].color }}
                    onClick={() => { setFocusedId(n.id); toggle(n.id); }}
                    onMouseEnter={(e) => {
                      if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
                      const x = e.clientX + 14;
                      const y = e.clientY - 10;
                      seqTimerRef.current = setTimeout(() => {
                        showSeqTooltip(m.id, m.name, x, y);
                      }, 160);
                    }}
                    onMouseLeave={() => {
                      if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
                      seqTimerRef.current = setTimeout(
                        () => setSeqTooltip(prev => (prev?.pinned ? prev : null)),
                        220,
                      );
                    }}
                  >
                    <span
                      className={`rep-chevron${isExp ? ' is-open' : ''}${hasKids ? '' : ' is-leaf'}`}
                      onClick={e => { e.stopPropagation(); if (hasKids) toggle(n.id); }}
                    >
                      {hasKids ? '▶' : '·'}
                    </span>
                    <span className="rep-machine-icon">⚙</span>
                    <span className="rep-row-label">{m.name}</span>
                    {m.isExample  && <span className="rep-badge rep-badge-example">example</span>}
                    {lifeSafety   && <span className="rep-badge rep-badge-safety">life-safety</span>}
                    <span className="rep-row-meta">
                      {seqCount}<span className="rep-meta-unit"> ces</span>
                      <span className="rep-meta-dot">·</span>
                      {m.totalVectors}<span className="rep-meta-unit"> vec</span>
                    </span>
                  </div>
                );
              }

              return (
                <div
                  key={n.id}
                  ref={ref}
                  role="treeitem"
                  aria-level={3}
                  aria-selected={isFocused}
                  className={`rep-row rep-row-ces${isFocused ? ' is-focused' : ''}`}
                  style={{ ['--dc' as any]: DOMAINS[n.domainId].color }}
                  onClick={() => setFocusedId(n.id)}
                >
                  <span className="rep-chevron is-leaf">·</span>
                  <span className="rep-ces-icon">◆</span>
                  <span className="rep-row-label rep-ces-label">{n.sequenceName}</span>
                  <span className="rep-row-meta rep-ces-meta">CES</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

        {/* ── Interconnection graph panel (right) ────────────────────────── */}
        <aside className="rep-graph-panel" aria-label="Machine interconnection graph">
          <MachineGraphView />
        </aside>

      </div>

      {/* ── Status footer ─────────────────────────────────────────────── */}
      <footer className="rep-status-bar">

        <StatusPill
          label="RE"
          health={surface.reHealth}
          error={surface.reError}
          title="Reality Engine runtime health"
        />

        <span className="rep-status-sep" />

        <StatusPill
          label="PE"
          health={surface.peHealth}
          error={surface.peError}
          title="Perception Engine runtime health"
        />

        {surface.peState && (
          <>
            <span className="rep-status-sep" />
            <span className="rep-status-item" title="Perception Engine push state">
              <span className={`rep-status-dot ${surface.peState.running ? 'is-ok' : 'is-idle'}`} />
              <span className="rep-status-text">
                PE {surface.peState.running ? 'running' : 'idle'}
                {surface.peState.activeSources > 0 && ` · ${surface.peState.activeSources}/${surface.peState.sourceCount} src`}
              </span>
            </span>
          </>
        )}

        {surface.engineActive && (
          <>
            <span className="rep-status-sep" />
            <span className="rep-status-item" title="Active RE sequences">
              <span className="rep-status-text rep-status-dim">
                {surface.engineActive.total ?? surface.engineActive.activeSequences?.length ?? 0} seq active
              </span>
            </span>
          </>
        )}

        <span className="rep-status-spacer" />

        <span className="rep-status-item rep-status-dim" title="SURFACE_SPEC v1.1.0">
          surface v1.1.0
        </span>

      </footer>

      {/* ── Sequence tooltip portal ───────────────────────────────────── */}
      {seqTooltip && ReactDOM.createPortal(
        <SequenceTooltip
          tooltip={seqTooltip}
          live={EMPTY_LIVE}
          onMouseEnter={() => {
            if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
          }}
          onMouseLeave={() => {
            if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
            seqTimerRef.current = setTimeout(
              () => setSeqTooltip(prev => (prev?.pinned ? prev : null)),
              220,
            );
          }}
          onPin={() => setSeqTooltip(prev => prev ? { ...prev, pinned: !prev.pinned } : null)}
          onClose={() => setSeqTooltip(null)}
          extraStyle={{ position: 'fixed' }}
        />,
        document.body,
      )}

      {/* ── Help overlay ───────────────────────────────────────────────── */}
      {showHelp && (
        <div className="rep-help-overlay" onClick={() => setShowHelp(false)}>
          <div className="rep-help-panel" onClick={e => e.stopPropagation()}>

            <div className="rep-help-header">
              <span className="rep-help-eyebrow">Reality Engine</span>
              <span className="rep-help-title">Navigation Guide</span>
              <button className="rep-help-close" onClick={() => setShowHelp(false)} aria-label="Close">✕</button>
            </div>

            <div className="rep-help-body">

              <section className="rep-help-section">
                <div className="rep-help-section-heading">Keyboard Shortcuts</div>
                <div className="rep-help-shortcut-list">
                  {KEYBOARD_SHORTCUTS.map(([key, desc]) => (
                    <div key={key} className="rep-help-shortcut-row">
                      <kbd className="rep-kbd">{key}</kbd>
                      <span className="rep-help-shortcut-desc">{desc}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rep-help-section">
                <div className="rep-help-section-heading">Tree Structure</div>
                <div className="rep-help-legend">
                  <div className="rep-help-legend-row">
                    <span className="rep-help-legend-icon domain-icon">▶</span>
                    <div>
                      <span className="rep-help-legend-label">Domain</span>
                      <span className="rep-help-legend-desc"> — area of effect; groups related machines</span>
                    </div>
                  </div>
                  <div className="rep-help-legend-row">
                    <span className="rep-help-legend-icon machine-icon">⚙</span>
                    <div>
                      <span className="rep-help-legend-label">Machine</span>
                      <span className="rep-help-legend-desc"> — perception engine with sequences and vectors</span>
                    </div>
                  </div>
                  <div className="rep-help-legend-row">
                    <span className="rep-help-legend-icon ces-icon">◆</span>
                    <div>
                      <span className="rep-help-legend-label">CES</span>
                      <span className="rep-help-legend-desc"> — Critical Event Sequence; a named stimulus pattern</span>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rep-help-section">
                <div className="rep-help-section-heading">Domains</div>
                <div className="rep-help-domains">
                  {DOMAIN_ORDER.map(id => (
                    <div key={id} className="rep-help-domain-row">
                      <span className="rep-help-domain-swatch" style={{ background: DOMAINS[id].color }} />
                      <span className="rep-help-domain-label">{DOMAINS[id].label}</span>
                      <span className="rep-help-domain-short">{DOMAINS[id].short}</span>
                    </div>
                  ))}
                </div>
              </section>

            </div>
          </div>
        </div>
      )}

      {/* ── Settings modal ─────────────────────────────────────────────── */}
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        triggerRef={settingsGearRef}
      />

    </div>
  );
};

export default RealityEnginePanelView;
