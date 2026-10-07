import { describe, it, expect } from 'vitest';
import { parseStepFrame } from '../reStepStream.js';

const STEP = {
  stepNumber: 7,
  machineResults: {
    'machine-falldetection': {
      transitionResult: { sequenceResults: { s1: { activatedEvents: ['e2'], matchedEvents: ['e1'] } } },
    },
  },
};

describe('parseStepFrame (#250)', () => {
  it('reads the SURFACE_SPEC envelope, as LSP sends it', () => {
    const step = parseStepFrame(JSON.stringify({ type: 'step-result', step: STEP }));
    expect(step).toEqual(STEP);
    // The fields the CES graphs read are reachable, not one level down.
    expect(step?.stepNumber).toBe(7);
    expect(Object.keys(step?.machineResults ?? {})).toEqual(['machine-falldetection']);
  });

  it('reads the bare step, as C++ and Scala send it', () => {
    expect(parseStepFrame(JSON.stringify(STEP))).toEqual(STEP);
  });

  it('reads a bare step that carries no machineResults (a caller declined them)', () => {
    expect(parseStepFrame(JSON.stringify({ stepNumber: 3, perceptualSpace: [] })))
      .toEqual({ stepNumber: 3, perceptualSpace: [] });
  });

  it('is not a step: malformed JSON, other event types, an envelope with no step, unrelated objects', () => {
    expect(parseStepFrame('{not json')).toBeNull();
    expect(parseStepFrame(JSON.stringify({ type: 'state-update', stepNumber: 1 }))).toBeNull();
    expect(parseStepFrame(JSON.stringify({ type: 'step-result' }))).toBeNull();
    expect(parseStepFrame(JSON.stringify({ type: 'step-result', step: [1, 2] }))).toBeNull();
    expect(parseStepFrame(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(parseStepFrame(JSON.stringify([STEP]))).toBeNull();
    expect(parseStepFrame('null')).toBeNull();
  });
});
