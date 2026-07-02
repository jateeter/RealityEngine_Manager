import { describe, it, expect } from 'vitest';
import {
  emptySelection,
  filterTree,
  machineChecked,
  nodeState,
  selectionCount,
  selectionToRequest,
  toggleMachine,
  toggleNode,
  type CorpusTreeNode,
} from '../corpusTree';

const machine = (name: string, loaded = false) =>
  ({ id: '', name, relFile: `${name}.json`, loaded });

const TREE: CorpusTreeNode[] = [
  {
    key: 'domains',
    label: 'Domains',
    count: 3,
    machines: [],
    children: [
      {
        key: 'domains/energy',
        label: 'energy',
        count: 3,
        machines: [machine('E1'), machine('E2'), machine('E3', true)],
      },
    ],
  },
  {
    key: 'corpus',
    label: 'Corpus',
    count: 2,
    machines: [],
    children: [
      {
        key: 'corpus/agriculture',
        label: 'agriculture',
        count: 2,
        machines: [machine('A1'), machine('A2')],
      },
    ],
  },
];

const energy = TREE[0].children![0];
const agriculture = TREE[1].children![0];

describe('toggleNode / nodeState', () => {
  it('selecting a node covers all its machines', () => {
    const sel = toggleNode(energy, emptySelection());
    expect(nodeState(energy, sel)).toBe('checked');
    expect(machineChecked('E1', energy.key, sel)).toBe(true);
    expect(machineChecked('A1', agriculture.key, sel)).toBe(false);
    expect(selectionCount(TREE, sel)).toBe(3);
  });

  it('parent shows checked when its only child is selected, partial when mixed', () => {
    const sel = toggleNode(energy, emptySelection());
    expect(nodeState(TREE[0], sel)).toBe('checked');
    const mixed = toggleMachine(agriculture, 'A1', sel);
    expect(nodeState(TREE[1], mixed)).toBe('partial');
  });

  it('toggling a checked node off clears its coverage', () => {
    let sel = toggleNode(energy, emptySelection());
    sel = toggleNode(energy, sel);
    expect(nodeState(energy, sel)).toBe('none');
    expect(selectionCount(TREE, sel)).toBe(0);
  });
});

describe('toggleMachine', () => {
  it('individual machines accumulate and flip the node to partial then checked', () => {
    let sel = toggleMachine(energy, 'E1', emptySelection());
    expect(nodeState(energy, sel)).toBe('partial');
    sel = toggleMachine(energy, 'E2', sel);
    sel = toggleMachine(energy, 'E3', sel);
    expect(nodeState(energy, sel)).toBe('checked');
  });

  it('unchecking one machine under a covering node demotes to explicit siblings', () => {
    let sel = toggleNode(energy, emptySelection());
    sel = toggleMachine(energy, 'E2', sel);
    expect(machineChecked('E1', energy.key, sel)).toBe(true);
    expect(machineChecked('E2', energy.key, sel)).toBe(false);
    expect(machineChecked('E3', energy.key, sel)).toBe(true);
    expect(nodeState(energy, sel)).toBe('partial');
    expect(selectionCount(TREE, sel)).toBe(2);
  });
});

describe('selectionToRequest', () => {
  it('emits node keys as domains and machine names as machineIds', () => {
    let sel = toggleNode(energy, emptySelection());
    sel = toggleMachine(agriculture, 'A2', sel);
    expect(selectionToRequest(sel)).toEqual({
      domains: ['domains/energy'],
      machineIds: ['A2'],
    });
  });
});

describe('filterTree', () => {
  it('narrows to matching machines and drops empty nodes', () => {
    const filtered = filterTree(TREE, 'E2');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].children![0].machines.map(m => m.name)).toEqual(['E2']);
  });

  it('matching a node label keeps its machines', () => {
    const filtered = filterTree(TREE, 'agriculture');
    expect(filtered[0].children![0].machines).toHaveLength(2);
  });

  it('empty query returns the tree unchanged', () => {
    expect(filterTree(TREE, '  ')).toBe(TREE);
  });
});
