/**
 * engineBinding — resolution, isolation and cache scoping.
 *
 * These are the properties the per-request binding exists to provide, and none
 * of them could be asserted while the logic lived in server.ts, which binds
 * ports on import. The most important is the concurrency one: two requests
 * addressed to different engines must not see each other's binding, which is
 * the whole defect (RealityEngine_Manager#156).
 */

import { describe, it, expect } from 'vitest';
import {
  RE_INSTANCE_HEADER, resolveBinding, runBound, boundInstance,
  bindingScope, scopedKey, unscope,
  type BindableInstance,
} from '../engineBinding.js';

const INSTANCES: BindableInstance[] = [
  { id: 'cpp-1',   re_url: 'http://h:5301', pe_url: 'http://h:5300' },
  { id: 'lsp-1',   re_url: 'http://h:5601', pe_url: 'http://h:5600' },
  { id: 'scala-1', re_url: 'http://h:5101', pe_url: 'http://h:5100' },
];

describe('resolveBinding', () => {
  it('is unbound when no header is present', () => {
    expect(resolveBinding(undefined, INSTANCES)).toEqual({ kind: 'unbound' });
  });

  it('is unbound for an empty header rather than treating it as a name', () => {
    expect(resolveBinding('', INSTANCES)).toEqual({ kind: 'unbound' });
  });

  it('binds a running instance to its own urls', () => {
    const r = resolveBinding('lsp-1', INSTANCES);
    expect(r).toEqual({
      kind: 'bound',
      binding: { id: 'lsp-1', re_url: 'http://h:5601', pe_url: 'http://h:5600' },
    });
  });

  it('takes the first value when a header is repeated', () => {
    const r = resolveBinding(['cpp-1', 'lsp-1'], INSTANCES);
    expect(r.kind).toBe('bound');
    expect(r.kind === 'bound' && r.binding.id).toBe('cpp-1');
  });

  it('rejects a malformed id instead of searching for it', () => {
    expect(resolveBinding('../../etc/passwd', INSTANCES).kind).toBe('invalid');
    expect(resolveBinding('a'.repeat(129), INSTANCES).kind).toBe('invalid');
  });

  // The property that matters most: a named-but-absent engine must not be
  // answered by a different one. Substituting is the cross-talk the binding
  // exists to prevent, and it would be invisible at the call site.
  it('refuses an unknown instance rather than substituting the active one', () => {
    const r = resolveBinding('lsp-2', INSTANCES);
    expect(r.kind).toBe('unknown');
    expect(r.kind === 'unknown' && r.available).toEqual(['cpp-1', 'lsp-1', 'scala-1']);
  });

  it('refuses every instance when none are registered', () => {
    expect(resolveBinding('cpp-1', []).kind).toBe('unknown');
  });

  it('names the header in lower case, as Node delivers it', () => {
    expect(RE_INSTANCE_HEADER).toBe('x-re-instance');
  });
});

describe('binding isolation', () => {
  it('reports no binding outside a bound context', () => {
    expect(boundInstance()).toBeNull();
  });

  it('pins the binding for the duration of the call', () => {
    runBound(INSTANCES[1] as never, () => {
      expect(boundInstance()?.id).toBe('lsp-1');
    });
    expect(boundInstance()).toBeNull();
  });

  // Two interleaved async contexts, each addressed to a different engine. With
  // a module-global this fails: whichever ran last wins for both.
  it('keeps concurrent bindings independent', async () => {
    const seen: string[] = [];

    const work = (inst: BindableInstance, delayMs: number) =>
      new Promise<void>(resolve => {
        runBound(inst as never, () => {
          setTimeout(() => {
            seen.push(`${inst.id}:${boundInstance()?.id}`);
            resolve();
          }, delayMs);
        });
      });

    // cpp-1 is bound first but resolves last, so a global would report lsp-1.
    await Promise.all([work(INSTANCES[0], 20), work(INSTANCES[1], 1)]);

    expect(seen.sort()).toEqual(['cpp-1:cpp-1', 'lsp-1:lsp-1']);
  });

  it('does not leak a binding into work started outside it', async () => {
    let observed: string | null | undefined;
    const outside = new Promise<void>(resolve => {
      setTimeout(() => { observed = boundInstance()?.id ?? null; resolve(); }, 5);
    });
    runBound(INSTANCES[2] as never, () => { /* bound only in here */ });
    await outside;
    expect(observed).toBeNull();
  });
});

describe('cache scoping', () => {
  it('scopes to the bound instance', () => {
    runBound(INSTANCES[1] as never, () => {
      expect(bindingScope('cpp-1', 'cpp-1')).toBe('lsp-1');
    });
  });

  it('falls back to the active engine when unbound', () => {
    expect(bindingScope('scala-1', 'cpp-1')).toBe('scala-1');
  });

  it('falls back to the first instance when nothing is active', () => {
    expect(bindingScope(null, 'cpp-1')).toBe('cpp-1');
  });

  it('has a last resort when there are no instances at all', () => {
    expect(bindingScope(null, undefined)).toBe('default');
  });

  // The point of scoping: the same logical key must not collide across engines,
  // or one engine's machines get served for another.
  it('keys the same logical entry differently per engine', () => {
    expect(scopedKey('cpp-1', 'machines:list'))
      .not.toBe(scopedKey('lsp-1', 'machines:list'));
  });

  it('round-trips the logical key so prefix invalidation still works', () => {
    expect(unscope(scopedKey('cpp-1', 'machines:list'))).toBe('machines:list');
    expect(unscope(scopedKey('lsp-1', 'pe:sources'))).toBe('pe:sources');
  });

  it('leaves an unscoped key alone', () => {
    expect(unscope('machines:list')).toBe('machines:list');
  });

  it('preserves a logical key that itself contains a space', () => {
    expect(unscope(scopedKey('cpp-1', 'machines:by name'))).toBe('machines:by name');
  });
});
