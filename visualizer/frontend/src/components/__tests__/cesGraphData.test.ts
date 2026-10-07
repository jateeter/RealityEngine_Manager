import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  exportToTooltipData,
  fetchTooltipMachineData,
  stepToTooltipLive,
} from '../MachineSequenceTooltip';
import { isStaleStep } from '../../hooks/useOnEngineSwitch';

// #250: the CES graph's arcs and live activity, read the same way from every
// engine. Fixtures follow what cpp, lsp and scala returned for the same machine
// on 2026-10-07 (all three identical for the export).

const EXPORT = {
  machine: {
    id: 'machine-dlx017-start-busy-done',
    name: 'DLX-017 Start Busy Done',
    description: 'start → busy → done',
    sequences: [
      {
        id: 'seq-a',
        name: 'A',
        events: [
          { id: 'start', isInitial: true, metadata: { name: 'start' }, nextEventIds: ['busy'], outputEvents: [] },
          { id: 'busy', metadata: { name: 'busy' }, nextEventIds: ['done'], outputEvents: [] },
          { id: 'done', metadata: { name: 'done' }, nextEventIds: [], outputEvents: [{ id: 'o1' }] },
        ],
      },
      {
        id: 'seq-b',
        name: 'B',
        events: [
          { id: 'b1', isInitial: true, nextEventIds: ['b2'] },
          { id: 'b2' },
        ],
      },
    ],
  },
};

describe('exportToTooltipData (#250)', () => {
  it('draws one arc per nextEventIds entry, per sequence', () => {
    const data = exportToTooltipData(EXPORT, 'machine-dlx017-start-busy-done', 'fallback');
    expect(data.sequences.map(s => s.edges)).toEqual([
      [{ source: 'start', target: 'busy' }, { source: 'busy', target: 'done' }],
      [{ source: 'b1', target: 'b2' }],
    ]);
    expect(data.sequences[0].nodes.map(n => [n.id, n.isInitial, n.hasOutput]))
      .toEqual([['start', true, false], ['busy', false, false], ['done', false, true]]);
    expect(data.error).toBeUndefined();
  });

  it('reads an unwrapped export the same way', () => {
    const data = exportToTooltipData(EXPORT.machine, 'x', 'fallback');
    expect(data.sequences.flatMap(s => s.edges)).toHaveLength(3);
  });
});

describe('fetchTooltipMachineData (#250)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('maps a good export', async () => {
    respond(200, EXPORT);
    const data = await fetchTooltipMachineData('machine-dlx017-start-busy-done', 'fallback');
    expect(data.error).toBeUndefined();
    expect(data.sequences.flatMap(s => s.edges)).toHaveLength(3);
  });

  it('says why, instead of drawing an empty graph, when the engine does not know the id', async () => {
    // What cpp and lsp answer for a localAI machine id scala minted.
    respond(404, { error: 'Machine not found' });
    const data = await fetchTooltipMachineData('machine-01a1184f-0526-7000-8d3e-e584d1dd4ff6', 'agent_activity_classifier');
    expect(data.sequences).toEqual([]);
    expect(data.error).toMatch(/Machine not found/);
  });

  it('treats a 200 that carries only an error as a failure', async () => {
    respond(200, { error: 'Machine not found' });
    expect((await fetchTooltipMachineData('x', 'x')).error).toMatch(/Machine not found/);
  });

  it('reports an unreachable engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect((await fetchTooltipMachineData('x', 'x')).error).toMatch(/ECONNREFUSED/);
  });
});

describe('stepToTooltipLive (#250)', () => {
  const STEP = {
    stepNumber: 12,
    machineResults: {
      m: {
        outputVector: [1, 0],
        transitionResult: {
          sequenceResults: {
            'seq-a': { activatedEvents: ['busy'], matchedEvents: ['start'] },
            'seq-b': { activatedEvents: ['b2'], matchedEvents: [] },
          },
        },
      },
    },
  };

  it('unions activated and matched events across sequences', () => {
    const live = stepToTooltipLive(STEP, 'm');
    expect([...live.activatedIds].sort()).toEqual(['b2', 'busy']);
    expect([...live.matchedIds]).toEqual(['start']);
    expect(live.stepNumber).toBe(12);
    expect(live.hasOutput).toBe(true);
    expect(live.activityReported).toBe(true);
  });

  it('does not throw on a step with no machineResults, and says activity was not reported', () => {
    const live = stepToTooltipLive({ stepNumber: 3, perceptualSpace: [] }, 'm');
    expect(live.activatedIds.size).toBe(0);
    expect(live.stepNumber).toBe(3);
    expect(live.activityReported).toBe(false);
  });

  it('distinguishes "not reported" from "nothing active"', () => {
    const quiet = { stepNumber: 4, machineResults: { m: { transitionResult: { sequenceResults: {} } } } };
    expect(stepToTooltipLive(quiet, 'm').activityReported).toBe(true);
    expect(stepToTooltipLive({ stepNumber: 4, machineResults: { m: {} } }, 'm').activityReported).toBe(false);
  });

  it('is empty before any step', () => {
    expect(stepToTooltipLive(null, 'm').stepNumber).toBeUndefined();
  });
});

describe('isStaleStep (#250)', () => {
  it('drops a frame from an engine other than the one switched to', () => {
    expect(isStaleStep({ engineId: 'scala-1' }, 'cpp-1')).toBe(true);
    expect(isStaleStep({ engineId: 'cpp-1' }, 'cpp-1')).toBe(false);
  });
  it('accepts frames before any switch, and frames with no engine tag', () => {
    expect(isStaleStep({ engineId: 'scala-1' }, null)).toBe(false);
    expect(isStaleStep({}, 'cpp-1')).toBe(false);
  });
});
