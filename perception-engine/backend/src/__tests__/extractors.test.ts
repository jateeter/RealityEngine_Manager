/**
 * extractors — JSON-pointer extract + normalize contract tests.
 *
 * Aligned with the `extract` / `normalize` schema in
 * config/integrations.example.json.  The completion endpoint itself does
 * not call these helpers (matching C++); they are used by the Phase 4
 * provider adapters when raw provider payloads must be turned into a
 * numeric vector before commit.
 */

import { describe, it, expect } from '@jest/globals';
import {
  applyExtract, applyNormalize, coerceNumber, evalJsonPointer,
} from '../integrations/extractors.js';

describe('evalJsonPointer', () => {
  const doc = { a: { b: [10, 20, { c: 'x' }] }, '~weird/key': 7 };
  it('returns the document on empty pointer', () => {
    expect(evalJsonPointer(doc, '')).toBe(doc);
  });
  it('walks objects and arrays', () => {
    expect(evalJsonPointer(doc, '/a/b/0')).toBe(10);
    expect(evalJsonPointer(doc, '/a/b/2/c')).toBe('x');
  });
  it('returns undefined for unknown paths', () => {
    expect(evalJsonPointer(doc, '/a/nope')).toBeUndefined();
    expect(evalJsonPointer(doc, '/a/b/99')).toBeUndefined();
  });
  it('honours ~0 / ~1 escapes', () => {
    expect(evalJsonPointer(doc, '/~0weird~1key')).toBe(7);
  });
});

describe('coerceNumber', () => {
  it.each([
    [42, 42], [true, 1], [false, 0], ['3.14', 3.14],
    ['nope', 0], [null, 0], [undefined, 0], [Infinity, 0], [NaN, 0],
  ])('coerces %p → %p', (input, expected) => {
    expect(coerceNumber(input as any)).toBe(expected);
  });
});

describe('applyExtract', () => {
  it('extracts one cell per pointer', () => {
    const v = applyExtract(
      { completed: 1, failed: 0, confidence: 0.82, actionClass: 'page' },
      { type: 'json', pointers: ['/completed', '/failed', '/confidence', '/actionClass'] },
    );
    expect(v).toEqual([1, 0, 0.82, 0]); // 'page' → 0 (non-numeric string)
  });
  it('expands a single pointer that resolves to an array', () => {
    const v = applyExtract({ values: [1, 2, 3] }, { type: 'json', pointer: '/values' });
    expect(v).toEqual([1, 2, 3]);
  });
  it('passthrough accepts a raw numeric array', () => {
    expect(applyExtract([1, 2, 3], { type: 'passthrough' })).toEqual([1, 2, 3]);
    expect(applyExtract(0.5, { type: 'passthrough' })).toEqual([0.5]);
  });
});

describe('applyNormalize', () => {
  it('passthrough returns a copy by default', () => {
    const input = [0.1, 0.5, 0.9];
    const out = applyNormalize(input, { mode: 'passthrough' });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
  it('clamps to [0,1] when requested', () => {
    expect(applyNormalize([-0.5, 0.2, 1.5], { mode: 'passthrough', clamp: true })).toEqual([0, 0.2, 1]);
  });
  it('minmax normalizes across span and clamps', () => {
    expect(applyNormalize([0, 5, 10, 15], { mode: 'minmax', min: 0, max: 10, clamp: true }))
      .toEqual([0, 0.5, 1, 1]);
  });
  it('minmax with zero span returns zeros', () => {
    expect(applyNormalize([1, 2, 3], { mode: 'minmax', min: 5, max: 5 })).toEqual([0, 0, 0]);
  });
  it('linear applies scale + offset', () => {
    expect(applyNormalize([1, 2, 3], { mode: 'linear', scale: 2, offset: 1 })).toEqual([3, 5, 7]);
  });
});
