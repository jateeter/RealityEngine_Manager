import { describe, expect, it } from 'vitest';
import { clockTitle, formatClock, formatInstanceClocks } from '../instanceClock';

const RE = { instance: '01a20b16-0762-7cc5-a644-79b1c5ee4dd2', lamport: 7232531, commit: 412, step: 38 };
const PE = { instance: '01a2151c-7a87-7c06-9491-54dc94e61ad7', lamport: 5221071, commit: 40, step: -1 };

describe('instanceClock', () => {
  it('formats a clock, with step -1 shown as not yet stepped', () => {
    expect(formatClock(RE)).toBe('L 7232531 · c 412 · s 38');
    expect(formatClock(PE)).toBe('L 5221071 · c 40 · s —');
  });

  it('shows a missing or pre-#600 clock as a dash, never as zero', () => {
    expect(formatClock(null)).toBe('—');
    expect(formatClock({ instance: RE.instance, lamport: 1, step: 0 })).toBe('—');
    expect(formatClock({ error: 'Not found' })).toBe('—');
  });

  it('formats both halves of an instance', () => {
    expect(formatInstanceClocks({ id: 'cpp-1', re: RE, pe: PE }))
      .toBe('RE L 7232531 · c 412 · s 38   PE L 5221071 · c 40 · s —');
    expect(formatInstanceClocks(null)).toBe('RE —   PE —');
  });

  it('names each participant in the tooltip', () => {
    expect(clockTitle({ re: RE, pe: null })).toContain(`RE ${RE.instance}`);
    expect(clockTitle({ re: RE, pe: null })).toContain('PE no clock');
  });
});
