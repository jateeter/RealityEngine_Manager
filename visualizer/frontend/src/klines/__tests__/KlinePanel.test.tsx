/**
 * The K-line panel (Manager#372): its histogram and the panel's rendering of
 * the backend's state. The backend client is mocked; engines are never called
 * from the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Histogram } from '../Histogram';

vi.mock('../klineApi', () => ({
  klineApi: {
    state: vi.fn(), catalog: vi.fn(), schedules: vi.fn(), capture: vi.fn(), analysis: vi.fn(),
    archive: vi.fn(), setKnob: vi.fn(), resetKnob: vi.fn(), addSchedule: vi.fn(), removeSchedule: vi.fn(), runSchedule: vi.fn(),
  },
}));
import { klineApi } from '../klineApi';
import { KlinePanelView } from '../KlinePanelView';

const half = (on: boolean) => ({ supported: true, capture: on, feedbackHops: 3, storeMaxBytes: 2147483648, open: 0,
  stats: { segments: 1, bytes: 1024, budget: 2147483648, warnings: [] } });
const STATE = {
  bootCapture: false, archive: '/home/x/.reality-engine/kline-archive',
  knobs: { re: { klineFeedbackHops: { min: 0, max: 16, default: 3 }, klineStoreMaxBytes: { min: 0, max: 9e15, default: 2147483648 } },
           pe: { isreStoreMaxBytes: { min: 0, max: 9e15, default: 2147483648 } } },
  instances: [
    { id: 'cpp-1', runtime: 'cpp', role: 'voter', re: half(false), pe: { supported: true, capture: false, storeMaxBytes: 2147483648, taxonomy: 're-source-kinds/2' } },
    { id: 'go-1', runtime: 'go', role: 'follower', re: { supported: false }, pe: { supported: false } },
  ],
};

beforeEach(() => {
  vi.mocked(klineApi.state).mockResolvedValue(STATE as any);
  vi.mocked(klineApi.catalog).mockResolvedValue({ root: STATE.archive, catalog: [] });
  vi.mocked(klineApi.schedules).mockResolvedValue({ schedules: [] });
  vi.mocked(klineApi.capture).mockResolvedValue({ results: [{ id: 'cpp-1', ok: true, errors: [] }] });
});

describe('Histogram', () => {
  it('draws bars on the shared scale and offers a table of the same numbers', () => {
    render(<Histogram title="Outcomes" counts={{ completed: 5, abandoned: 1 }} max={10} testId="h" />);
    const bars = document.querySelectorAll('.kl-bar') as NodeListOf<HTMLElement>;
    expect([...bars].map(b => b.style.width)).toEqual(['10%', '50%']); // sorted keys, scale 10
    expect(screen.getByText('6 K-lines')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'table' }));
    expect(screen.getByRole('table').textContent).toContain('completed5');
  });
  it('shows a tooltip on hover', () => {
    render(<Histogram title="Paths" counts={{ 1: 3 }} />);
    fireEvent.mouseMove(document.querySelector('.kl-bar-row')!, { clientX: 5, clientY: 5 });
    expect(screen.getByRole('tooltip').textContent).toContain('3 K-lines');
  });
});

describe('KlinePanelView', () => {
  it('shows boot capture, each half, and a follower as unsupported rather than off', async () => {
    render(<KlinePanelView />);
    await waitFor(() => expect(screen.getByTestId('kline-row-cpp-1')).toBeTruthy());
    expect(screen.getByTestId('kline-boot').textContent).toContain('off');
    expect(screen.getByTestId('kline-row-cpp-1').textContent).toContain('K-lines off');
    expect(screen.getByTestId('kline-row-go-1').textContent).toContain('unsupported');
    expect(screen.getByTestId('kline-row-go-1').querySelector('button')).toBeNull();
  });
  it('switches capture for the whole universe through the backend', async () => {
    render(<KlinePanelView />);
    await waitFor(() => expect(screen.getByTestId('kline-row-cpp-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('kline-capture-all-on'));
    await waitFor(() => expect(klineApi.capture).toHaveBeenCalledWith(true, undefined));
  });
  it('names a voter split, never one engine as the reference', async () => {
    const k = { klines: 1, commits: [1, 1], byOutcome: { completed: 1 }, byMachine: {}, bySequence: {}, closedPerStep: { 1: 1 }, pathLengths: { 1: 1 }, nearMiss: {}, nearMissNoThreshold: 0 };
    vi.mocked(klineApi.analysis).mockResolvedValue({ source: 'store', from: 0, to: 9, errors: [],
      perInstance: { 'cpp-1': { klines: k, compositions: null } },
      sideBySide: { agree: [], differ: ['byOutcome'], missing: [] } } as any);
    render(<KlinePanelView />);
    await waitFor(() => expect(screen.getByTestId('kline-row-cpp-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('kline-analyze'));
    await waitFor(() => expect(screen.getByTestId('kline-agreement').textContent).toContain('differ on byOutcome'));
  });
});
