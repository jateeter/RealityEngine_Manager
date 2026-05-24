import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useVisualizerStore } from '../store';
import { Machine } from '../types';
import {
  classifyMachine,
  DOMAINS,
  DOMAIN_ORDER,
  DomainId,
} from '../components/machineDomains';
import './MachineSelectionView.css';

// ── Tree shape ──────────────────────────────────────────────────────────────
// Three node kinds; flattened at render time into a single visible-rows list
// so keyboard navigation (Up/Down/Left/Right/Home/End/Enter) walks the tree
// in the order the user sees it.

type DomainNode = {
  kind: 'domain';
  id: string;            // `domain:<DomainId>`
  domainId: DomainId;
  label: string;
  color: string;
  machineCount: number;
  cesCount: number;
  children: MachineNode[];
};

type MachineNode = {
  kind: 'machine';
  id: string;            // `machine:<machineId>`
  domainId: DomainId;
  machine: Machine;
  children: CesNode[];
};

type CesNode = {
  kind: 'ces';
  id: string;            // `ces:<machineId>:<sequenceId>`
  domainId: DomainId;
  machineId: string;
  sequenceId: string;
  sequenceName: string;
};

type FlatRow =
  | { node: DomainNode; depth: 0 }
  | { node: MachineNode; depth: 1 }
  | { node: CesNode; depth: 2 };

const MachineSelectionView: React.FC = () => {
  const {
    machines,
    setMachines,
    setCurrentView,
  } = useVisualizerStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode,  setFilterMode]  = useState<'all' | 'examples' | 'custom'>('all');
  const [sortMode,    setSortMode]    = useState<'name' | 'recent' | 'sequences'>('name');
  const [isLoading,   setIsLoading]   = useState(false);

  // Expansion + focus state for the tree.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // ── Load machines on mount ────────────────────────────────────────────────
  useEffect(() => {
    const loadMachines = async () => {
      setIsLoading(true);
      try {
        const { api } = await import('../api');
        setMachines(await api.getMachines());
      } catch (error) {
        console.error('Error loading machines:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadMachines();
  }, [setMachines]);

  // ── Build the Domain → Machine → CES tree ────────────────────────────────
  const tree: DomainNode[] = useMemo(() => {
    // Filter + sort the raw machine list using the same toolbar controls as
    // before so the tree respects search/example/custom/sort settings.
    let filtered = machines;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(m => {
        if (m.name.toLowerCase().includes(q)) return true;
        if (m.description.toLowerCase().includes(q)) return true;
        // Match against CES names too so a user typing a sequence still finds
        // the parent machine.
        return m.sequences?.some(s => s.name.toLowerCase().includes(q));
      });
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

    // Group by classified domain.
    const groups = new Map<DomainId, Machine[]>();
    for (const m of sorted) {
      const d = classifyMachine(m).domain;
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(m);
    }

    const result: DomainNode[] = [];
    for (const domainId of DOMAIN_ORDER) {
      const list = groups.get(domainId);
      if (!list || list.length === 0) continue;
      const def = DOMAINS[domainId];

      const machineNodes: MachineNode[] = list.map(m => {
        const sequences = m.sequences ?? [];
        // CES list — filter against the search query when present so the tree
        // doesn't expand to irrelevant siblings while the user is hunting.
        const filteredSeqs = q
          ? sequences.filter(s => s.name.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
          : sequences;
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

      result.push({
        kind: 'domain',
        id: `domain:${domainId}`,
        domainId,
        label: def.label,
        color: def.color,
        machineCount: machineNodes.length,
        cesCount: machineNodes.reduce((acc, mn) => acc + mn.machine.sequenceCount, 0),
        children: machineNodes,
      });
    }
    return result;
  }, [machines, searchQuery, filterMode, sortMode]);

  // ── Auto-expand domains that contain search matches ──────────────────────
  // While typing, open every domain (and matching machine) so results are
  // immediately visible — without forgetting the user's prior manual choices
  // once the search clears.
  const baselineExpansion = useRef<Set<string> | null>(null);
  useEffect(() => {
    const q = searchQuery.trim();
    if (q) {
      if (!baselineExpansion.current) baselineExpansion.current = new Set(expanded);
      const next = new Set(expanded);
      for (const d of tree) {
        next.add(d.id);
        for (const m of d.children) {
          if (m.children.length > 0) next.add(m.id);
        }
      }
      setExpanded(next);
    } else if (baselineExpansion.current) {
      setExpanded(baselineExpansion.current);
      baselineExpansion.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, tree]);

  // ── Flatten visible rows for keyboard navigation ─────────────────────────
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

  // Keep focusedId valid as the row set changes (search/filter/expand).
  useEffect(() => {
    if (focusedId && flatRows.some(r => r.node.id === focusedId)) return;
    setFocusedId(flatRows[0]?.node.id ?? null);
  }, [flatRows, focusedId]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const toggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const focusAndScroll = useCallback((id: string) => {
    setFocusedId(id);
    const el = rowRefs.current.get(id);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, []);

  const activateRow = useCallback((row: FlatRow) => {
    const n = row.node;
    if (n.kind === 'domain' || n.kind === 'machine') {
      toggle(n.id);
      return;
    }
    // CES leaf — expand the parent machine node.
    toggle(`machine:${n.machineId}`);
  }, [toggle]);

  // ── Keyboard navigation (ARIA tree pattern) ──────────────────────────────
  const handleKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!focusedId) return;
    const idx = flatRows.findIndex(r => r.node.id === focusedId);
    if (idx === -1) return;
    const row = flatRows[idx];
    const n = row.node;

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
          // Already expanded — move to first child.
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
          // Jump to the parent row by walking back to the first row of lower depth.
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
        activateRow(row);
        break;
    }
  }, [flatRows, focusedId, expanded, toggle, focusAndScroll, activateRow]);

  // Expand / collapse all helpers for the toolbar.
  const expandAll = () => {
    const next = new Set<string>();
    for (const d of tree) {
      next.add(d.id);
      for (const m of d.children) if (m.children.length > 0) next.add(m.id);
    }
    setExpanded(next);
  };
  const collapseAll = () => setExpanded(new Set());

  return (
    <div className="msv-root">

      {/* ── Header ──────────────────────────────────────── */}
      <header className="msv-header">
        <div className="msv-wordmark">
          <div className="msv-title">
            Reality<span className="msv-title-accent"> Engine</span>
          </div>
          <div className="msv-subtitle">perception · sequence · visualization</div>
        </div>

        <div className="msv-header-actions">
          <input
            type="text"
            className="msv-search"
            placeholder="search domains · machines · CES…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />

          <button className="msv-nav-btn msv-nav-btn-interconnect" onClick={() => setCurrentView('interconnection')}>
            <span className="msv-btn-icon">⚡</span>
            Interconnect
          </button>
        </div>
      </header>

      {/* ── Toolbar ─────────────────────────────────────── */}
      <div className="msv-toolbar">
        <div className="msv-filter-group">
          {(['all', 'examples', 'custom'] as const).map(mode => (
            <button
              key={mode}
              className={`msv-filter-btn${filterMode === mode ? ' active' : ''}`}
              onClick={() => setFilterMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>

        <div className="msv-toolbar-right">
          <div className="msv-tree-controls">
            <button className="msv-tree-btn" onClick={expandAll}    title="Expand all domains and machines">expand all</button>
            <button className="msv-tree-btn" onClick={collapseAll}  title="Collapse all">collapse all</button>
          </div>
          <div className="msv-sort-group">
            <span className="msv-sort-label">sort</span>
            <select
              className="msv-sort-select"
              value={sortMode}
              onChange={e => setSortMode(e.target.value as any)}
            >
              <option value="name">name</option>
              <option value="recent">last accessed</option>
              <option value="sequences">sequences</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Tree ─────────────────────────────────────────── */}
      <div className="msv-tree-wrapper">
        {isLoading ? (
          <div className="msv-state">
            <span className="msv-state-text">loading machines…</span>
          </div>
        ) : flatRows.length === 0 ? (
          <div className="msv-state">
            <span className="msv-state-text">
              {searchQuery || filterMode !== 'all' ? 'no machines found' : 'no machines available'}
            </span>
            <span className="msv-state-hint">
              {searchQuery ? 'try a different search term' : 'no machines loaded'}
            </span>
          </div>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Machines grouped by domain"
            className="msv-tree"
            tabIndex={0}
            onKeyDown={handleKey}
          >
            {flatRows.map(row => {
              const n = row.node;
              const isFocused = focusedId === n.id;
              const isExp     = (n.kind === 'domain' || n.kind === 'machine') && expanded.has(n.id);
              const hasKids   = (n.kind === 'domain' || n.kind === 'machine') && (n.children?.length ?? 0) > 0;

              if (n.kind === 'domain') {
                return (
                  <div
                    key={n.id}
                    ref={el => { if (el) rowRefs.current.set(n.id, el); else rowRefs.current.delete(n.id); }}
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={hasKids ? isExp : undefined}
                    aria-selected={isFocused}
                    className={`msv-row msv-row-domain${isFocused ? ' is-focused' : ''}`}
                    style={{ ['--domain-color' as any]: n.color }}
                    onClick={() => { setFocusedId(n.id); toggle(n.id); }}
                  >
                    <span className={`msv-chevron${isExp ? ' is-open' : ''}`}>▶</span>
                    <span className="msv-domain-swatch" style={{ background: n.color }} />
                    <span className="msv-row-label msv-row-label-domain">{n.label}</span>
                    <span className="msv-row-meta">
                      {n.machineCount} machine{n.machineCount === 1 ? '' : 's'}
                      <span className="msv-meta-divider">·</span>
                      {n.cesCount} CES
                    </span>
                  </div>
                );
              }

              if (n.kind === 'machine') {
                const m = n.machine;
                const seqCount = m.sequenceCount ?? n.children.length;
                const lifeSafety = (m.severity ?? '').toString() === 'life-safety';
                return (
                  <div
                    key={n.id}
                    ref={el => { if (el) rowRefs.current.set(n.id, el); else rowRefs.current.delete(n.id); }}
                    role="treeitem"
                    aria-level={2}
                    aria-expanded={hasKids ? isExp : undefined}
                    aria-selected={isFocused}
                    className={`msv-row msv-row-machine${isFocused ? ' is-focused' : ''}`}
                    style={{ ['--domain-color' as any]: DOMAINS[n.domainId].color }}
                    onClick={() => { setFocusedId(n.id); toggle(n.id); }}
                  >
                    <span
                      className={`msv-chevron${isExp ? ' is-open' : ''}${hasKids ? '' : ' is-empty'}`}
                      onClick={(e) => { e.stopPropagation(); if (hasKids) toggle(n.id); }}
                    >
                      {hasKids ? '▶' : '·'}
                    </span>
                    <span className="msv-row-icon">⚙</span>
                    <span className="msv-row-label">{m.name}</span>
                    {m.isExample && <span className="msv-row-badge msv-badge-example">example</span>}
                    {lifeSafety && <span className="msv-row-badge msv-badge-safety">life-safety</span>}
                    <span className="msv-row-meta">
                      {seqCount} CES
                      <span className="msv-meta-divider">·</span>
                      {m.totalVectors} vectors
                    </span>
                  </div>
                );
              }

              // CES leaf row.
              return (
                <div
                  key={n.id}
                  ref={el => { if (el) rowRefs.current.set(n.id, el); else rowRefs.current.delete(n.id); }}
                  role="treeitem"
                  aria-level={3}
                  aria-selected={isFocused}
                  className={`msv-row msv-row-ces${isFocused ? ' is-focused' : ''}`}
                  style={{ ['--domain-color' as any]: DOMAINS[n.domainId].color }}
                  onClick={() => { setFocusedId(n.id); }}
                >
                  <span className="msv-chevron is-empty">·</span>
                  <span className="msv-row-icon msv-row-icon-ces">◆</span>
                  <span className="msv-row-label">{n.sequenceName}</span>
                  <span className="msv-row-meta msv-row-meta-ces">CES</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
};

export default MachineSelectionView;
