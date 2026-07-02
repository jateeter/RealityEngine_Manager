/**
 * corpusTree — pure tri-state selection logic for the Load Machines modal
 * (Manager#31). Side-effect-free so it can be unit-tested without DOM.
 *
 * Selection model: a set of tree-node keys (each covering every machine in
 * that node and its descendants) plus a set of individual machine names —
 * corpus files carry no machine id, so the name is the selection key, the
 * same identity the backend uses for presence checks.
 */

export interface CorpusTreeMachine {
  id: string;
  name: string;
  relFile: string;
  loaded?: boolean;
}

export interface CorpusTreeNode {
  key: string;
  label: string;
  count: number;
  loadedCount?: number;
  machines: CorpusTreeMachine[];
  children?: CorpusTreeNode[];
}

export interface CorpusSelection {
  nodes: Set<string>;
  machines: Set<string>;
}

export const emptySelection = (): CorpusSelection => ({
  nodes: new Set(),
  machines: new Set(),
});

/** True when `key` is covered by a selected node key (itself or an ancestor). */
export function nodeCovered(key: string, sel: CorpusSelection): boolean {
  for (const k of sel.nodes) {
    if (key === k || key.startsWith(`${k}/`)) return true;
  }
  return false;
}

export function machineChecked(
  name: string,
  parentKey: string,
  sel: CorpusSelection,
): boolean {
  return sel.machines.has(name) || nodeCovered(parentKey, sel);
}

export type NodeState = 'checked' | 'partial' | 'none';

export function nodeState(node: CorpusTreeNode, sel: CorpusSelection): NodeState {
  if (nodeCovered(node.key, sel)) return 'checked';
  const kids = node.children ?? [];
  const states = kids.map(c => nodeState(c, sel));
  const ownSelected = node.machines.filter(m => sel.machines.has(m.name)).length;
  const anySelected =
    ownSelected > 0 || states.some(s => s !== 'none');
  if (!anySelected) return 'none';
  // Vacuous truths: no children / no own machines don't block 'checked'.
  const kidsAllChecked = states.every(s => s === 'checked');
  const ownAllChecked = ownSelected === node.machines.length;
  return kidsAllChecked && ownAllChecked ? 'checked' : 'partial';
}

function pruneUnder(key: string, sel: CorpusSelection, node: CorpusTreeNode): void {
  sel.nodes.delete(node.key);
  for (const m of node.machines) sel.machines.delete(m.name);
  for (const c of node.children ?? []) pruneUnder(key, sel, c);
}

/** Toggle a whole node: on → covers all descendants; off → clears them. */
export function toggleNode(node: CorpusTreeNode, sel: CorpusSelection): CorpusSelection {
  const next: CorpusSelection = {
    nodes: new Set(sel.nodes),
    machines: new Set(sel.machines),
  };
  const state = nodeState(node, sel);
  pruneUnder(node.key, next, node);
  if (state !== 'checked') next.nodes.add(node.key);
  return next;
}

/** Toggle one machine. Unchecking a machine under a selected node demotes
 *  that node's coverage to explicit sibling selections. */
export function toggleMachine(
  node: CorpusTreeNode,
  name: string,
  sel: CorpusSelection,
): CorpusSelection {
  const next: CorpusSelection = {
    nodes: new Set(sel.nodes),
    machines: new Set(sel.machines),
  };
  if (nodeCovered(node.key, sel)) {
    // Expand covering selection into explicit machine names minus this one.
    for (const k of [...next.nodes]) {
      if (node.key === k || node.key.startsWith(`${k}/`)) next.nodes.delete(k);
    }
    for (const m of node.machines) {
      if (m.name !== name) next.machines.add(m.name);
    }
    return next;
  }
  if (next.machines.has(name)) next.machines.delete(name);
  else next.machines.add(name);
  return next;
}

/** Count of machines the current selection resolves to. */
export function selectionCount(tree: CorpusTreeNode[], sel: CorpusSelection): number {
  let n = 0;
  const walk = (node: CorpusTreeNode) => {
    for (const m of node.machines) {
      if (machineChecked(m.name, node.key, sel)) n++;
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (const t of tree) walk(t);
  return n;
}

/** POST /api/corpus/load body from a selection. */
export function selectionToRequest(sel: CorpusSelection): {
  domains: string[];
  machineIds: string[];
} {
  return {
    domains: [...sel.nodes].sort(),
    machineIds: [...sel.machines].sort(),
  };
}

/** Filter the tree to nodes/machines matching `query` (case-insensitive). */
export function filterTree(tree: CorpusTreeNode[], query: string): CorpusTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  const walk = (node: CorpusTreeNode): CorpusTreeNode | null => {
    const machines = node.machines.filter(m => m.name.toLowerCase().includes(q));
    const children = (node.children ?? [])
      .map(walk)
      .filter((c): c is CorpusTreeNode => c !== null);
    if (machines.length === 0 && children.length === 0 && !node.label.toLowerCase().includes(q)) {
      return null;
    }
    const keepAllMachines = node.label.toLowerCase().includes(q) && machines.length === 0;
    return {
      ...node,
      machines: keepAllMachines ? node.machines : machines,
      children: children.length > 0 ? children : node.children && !keepAllMachines ? [] : node.children,
    };
  };
  return tree.map(walk).filter((t): t is CorpusTreeNode => t !== null);
}
