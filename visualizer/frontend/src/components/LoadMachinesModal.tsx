/**
 * LoadMachinesModal — interactive multi-domain corpus ingest into the
 * currently active RE/PE engine (Manager#31 Phase 3).
 *
 * Presents the corpus catalog (GET /api/corpus/tree) as a navigable tree
 * with tri-state checkboxes; confirming POSTs the selection to
 * /api/corpus/load (registry-aware — always targets the active engine).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CorpusSelection,
  type CorpusTreeNode,
  emptySelection,
  filterTree,
  machineChecked,
  nodeState,
  selectionCount,
  selectionToRequest,
  toggleMachine,
  toggleNode,
} from './corpusTree';
import { useVisualizerStore } from '../store';
import './LoadMachinesModal.css';

interface LoadMachinesModalProps {
  onClose: () => void;
}

interface CorpusTreeResponse {
  machinesDir: string;
  totalMachines: number;
  engineMachineCount: number;
  tree: CorpusTreeNode[];
}

interface LoadSummary {
  engine: string;
  loaded: number;
  skipped: number;
  failed: number;
  results: Array<{ id: string; relFile: string; status: string; error?: string }>;
}

export function LoadMachinesModal({ onClose }: LoadMachinesModalProps) {
  const setMachines = useVisualizerStore(s => s.setMachines);

  const [catalog, setCatalog] = useState<CorpusTreeResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [activeEngine, setActiveEngine] = useState<string>('');
  const [sel, setSel] = useState<CorpusSelection>(emptySelection());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['domains']));
  const [query, setQuery] = useState('');
  const [bootstrapPe, setBootstrapPe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<LoadSummary | null>(null);

  const refreshCatalog = useCallback(async () => {
    try {
      const r = await fetch('/api/corpus/tree');
      if (!r.ok) throw new Error(`corpus tree: HTTP ${r.status}`);
      setCatalog(await r.json());
      setCatalogError(null);
    } catch (e: any) {
      setCatalogError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refreshCatalog();
    fetch('/api/engines')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const active = d?.instances?.find((i: any) => i.id === d.activeId) ?? d?.instances?.[0];
        if (active) setActiveEngine(`${active.id} (${active.runtime ?? '?'})`);
      })
      .catch(() => { /* registry-less single-engine mode */ });
  }, [refreshCatalog]);

  const visibleTree = useMemo(
    () => (catalog ? filterTree(catalog.tree, query) : []),
    [catalog, query],
  );
  const selected = useMemo(
    () => (catalog ? selectionCount(catalog.tree, sel) : 0),
    [catalog, sel],
  );

  const toggleExpand = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const doLoad = async () => {
    if (!catalog || selected === 0 || loading) return;
    setLoading(true);
    setSummary(null);
    try {
      const body = { ...selectionToRequest(sel), bootstrapPeSources: bootstrapPe };
      const r = await fetch('/api/corpus/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      setSummary(data);
      // Refresh machine list + catalog loaded-annotations for the app.
      try {
        const m = await fetch('/api/machines');
        if (m.ok) setMachines((await m.json()).machines ?? []);
      } catch { /* engine list refresh is best-effort */ }
      await refreshCatalog();
      setSel(emptySelection());
    } catch (e: any) {
      setSummary({
        engine: '', loaded: 0, skipped: 0, failed: 0,
        results: [{ id: '', relFile: '', status: 'failed', error: String(e?.message ?? e) }],
      });
    } finally {
      setLoading(false);
    }
  };

  const renderMachine = (node: CorpusTreeNode, m: CorpusTreeNode['machines'][number]) => (
    <label key={m.relFile} className="lmm-machine">
      <input
        type="checkbox"
        checked={machineChecked(m.name, node.key, sel)}
        onChange={() => setSel(prev => toggleMachine(node, m.name, prev))}
      />
      <span className="lmm-machine-name">{m.name || m.relFile}</span>
      {m.loaded && <span className="lmm-badge">loaded</span>}
    </label>
  );

  const renderNode = (node: CorpusTreeNode, depth: number): React.ReactNode => {
    const state = nodeState(node, sel);
    const isExpanded = expanded.has(node.key) || query.trim() !== '';
    const hasContent = (node.children?.length ?? 0) > 0 || node.machines.length > 0;
    return (
      <div key={node.key} className="lmm-node" style={{ marginLeft: depth * 16 }}>
        <div className="lmm-node-row">
          <button
            className="lmm-expander"
            aria-label={isExpanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
            onClick={() => toggleExpand(node.key)}
            disabled={!hasContent}
          >
            {hasContent ? (isExpanded ? '▾' : '▸') : '·'}
          </button>
          <input
            type="checkbox"
            aria-label={`Select ${node.label}`}
            checked={state === 'checked'}
            ref={el => { if (el) el.indeterminate = state === 'partial'; }}
            onChange={() => setSel(prev => toggleNode(node, prev))}
          />
          <span className="lmm-node-label">{node.label}</span>
          <span className="lmm-node-count">
            {node.loadedCount ?? 0}/{node.count} loaded
          </span>
        </div>
        {isExpanded && (
          <div className="lmm-node-body">
            {(node.children ?? []).map(c => renderNode(c, depth + 1))}
            {node.machines.map(m => renderMachine(node, m))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="lmm-overlay" role="dialog" aria-modal="true" aria-label="Load Machines">
      <div className="lmm-modal">
        <div className="lmm-header">
          <h2>Load Machines</h2>
          <button className="lmm-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="lmm-meta">
          <span>Target engine: <strong>{activeEngine || 'active engine'}</strong></span>
          {catalog && (
            <span>{catalog.totalMachines} corpus machines · {catalog.engineMachineCount} on engine</span>
          )}
        </div>

        <input
          className="lmm-filter"
          type="search"
          placeholder="Filter domains and machines…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />

        <div className="lmm-tree">
          {catalogError && <div className="lmm-error">Corpus catalog unavailable: {catalogError}</div>}
          {!catalog && !catalogError && <div className="lmm-loading">Scanning corpus…</div>}
          {visibleTree.map(n => renderNode(n, 0))}
        </div>

        {summary && (
          <div className={`lmm-summary${summary.failed > 0 ? ' has-failures' : ''}`}>
            Loaded {summary.loaded} · skipped {summary.skipped} · failed {summary.failed}
            {summary.results.filter(r => r.status === 'failed').slice(0, 3).map((r, i) => (
              <div key={i} className="lmm-failure">{r.relFile || 'request'}: {r.error}</div>
            ))}
          </div>
        )}

        <div className="lmm-footer">
          <label className="lmm-bootstrap">
            <input
              type="checkbox"
              checked={bootstrapPe}
              onChange={e => setBootstrapPe(e.target.checked)}
            />
            Bootstrap PE test sources after load
          </label>
          <span className="lmm-count">{selected} selected</span>
          <button
            className="lmm-load-btn"
            disabled={selected === 0 || loading}
            onClick={doLoad}
          >
            {loading ? 'Loading…' : 'Load into engine'}
          </button>
        </div>
      </div>
    </div>
  );
}
