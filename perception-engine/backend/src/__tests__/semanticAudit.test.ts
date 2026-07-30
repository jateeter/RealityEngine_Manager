/**
 * Semantic audit records — contract tests for the M5 surface
 * (RealityEngine_Machines docs/SEMANTIC_AUDIT_CONTRACT.md): re:PerceptionEvent
 * shapes and the dispatch-record semantics link.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearSemanticAudit,
  dispatchSemantics,
  recentPerceptionEvents,
  recordPerceptionEvent,
  SEMANTIC_AUDIT_CAPACITY,
  semanticAuditSize,
} from '../semanticAudit.js';

const BASE = 'https://realityengine.example.org/machines/health-personal/FallDetection';
let dir: string;
let previousManifest: string | undefined;

describe('semanticAudit', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'semantic-audit-'));
    const manifestPath = join(dir, 'abox-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '1.0.0',
        ontology: 'semantics/ontology/re-core.ttl',
        machines: {
          'health-personal/FallDetection': {
            name: 'Fall Detection',
            iri: `${BASE}#machine`,
            sourceFile: 'machines/domains/health-personal/FallDetection.json',
            sha256: 'ab'.repeat(32),
          },
        },
      }),
    );
    previousManifest = process.env['SEMANTICS_MANIFEST'];
    process.env['SEMANTICS_MANIFEST'] = manifestPath;
    clearSemanticAudit();
  });

  afterEach(() => {
    if (previousManifest === undefined) delete process.env['SEMANTICS_MANIFEST'];
    else process.env['SEMANTICS_MANIFEST'] = previousManifest;
    rmSync(dir, { recursive: true, force: true });
    clearSemanticAudit();
  });

  it('records a perception event with the corpus machine IRI', () => {
    const event = recordPerceptionEvent({
      sourceId: 'source-abc',
      machineName: 'Fall Detection',
      offset: 3813,
      length: 2,
      at: 1690000000000,
    });
    expect(event).toEqual({
      type: 're:PerceptionEvent',
      at: 1690000000000,
      sourceId: 'source-abc',
      machineName: 'Fall Detection',
      machineIri: `${BASE}#machine`,
      offset: 3813,
      length: 2,
    });
    expect(recentPerceptionEvents(10)).toHaveLength(1);
  });

  it('leaves the IRI null for sources with no machine or an unknown machine', () => {
    expect(recordPerceptionEvent({ sourceId: 's1', offset: 0, length: 1 }).machineIri).toBeNull();
    expect(
      recordPerceptionEvent({ sourceId: 's2', machineName: 'Nope', offset: 0, length: 1 }).machineIri,
    ).toBeNull();
  });

  it('caps the buffer and returns the newest events last', () => {
    for (let i = 0; i < SEMANTIC_AUDIT_CAPACITY + 25; i += 1) {
      recordPerceptionEvent({ sourceId: `s${i}`, offset: i, length: 1 });
    }
    expect(semanticAuditSize()).toBe(SEMANTIC_AUDIT_CAPACITY);
    const tail = recentPerceptionEvents(3);
    expect(tail.map((e) => e.sourceId)).toEqual([
      `s${SEMANTIC_AUDIT_CAPACITY + 22}`,
      `s${SEMANTIC_AUDIT_CAPACITY + 23}`,
      `s${SEMANTIC_AUDIT_CAPACITY + 24}`,
    ]);
  });

  it('builds dispatch semantics with sanitized sequence IRIs', () => {
    expect(
      dispatchSemantics({
        machineName: 'Fall Detection',
        sequenceId: 'fall-confirmed',
        actionCode: 'emergency-dispatch',
      }),
    ).toEqual({
      machineIri: `${BASE}#machine`,
      sequenceIri: `${BASE}#seq-fall-confirmed`,
      actionCode: 'emergency-dispatch',
    });
    // Characters outside the generator's PN_LOCAL subset collapse to '_'.
    expect(
      dispatchSemantics({ machineName: 'Fall Detection', sequenceId: 'odd id/v2' }).sequenceIri,
    ).toBe(`${BASE}#seq-odd_id_v2`);
    expect(dispatchSemantics({ machineName: 'Nope', sequenceId: 'x' })).toEqual({
      machineIri: null,
      sequenceIri: null,
      actionCode: null,
    });
  });
});
