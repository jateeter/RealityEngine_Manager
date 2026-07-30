/**
 * OWL semantics manifest lookup — contract tests for the M4 semantic
 * identity surface (`semanticsIri`/`semanticsHash`), mirroring
 * RealityEngine_Scala SemanticIdentitySpec.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { allSemanticIdentities, semanticIdentityFor } from '../semanticsManifest.js';

const HASH = 'ab'.repeat(32);

function writeManifest(dir: string, name = 'Test Machine', hash = HASH): string {
  const path = join(dir, 'abox-manifest.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: '1.0.0',
      generator: 'scripts/generate-owl.py',
      ontology: 'semantics/ontology/re-core.ttl',
      machines: {
        'test/TestMachine': {
          name,
          iri: 'https://realityengine.example.org/machines/test/TestMachine#machine',
          sourceFile: 'machines/domains/test/TestMachine.json',
          sha256: hash,
        },
      },
    }),
  );
  return path;
}

describe('semanticsManifest', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'semantics-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('returns the manifest identity for a known machine', () => {
    const path = writeManifest(tempDir());
    const identity = semanticIdentityFor('Test Machine', path);
    expect(identity).not.toBeNull();
    expect(identity!.machineKey).toBe('test/TestMachine');
    expect(identity!.semanticsIri).toBe(
      'https://realityengine.example.org/machines/test/TestMachine#machine',
    );
    expect(identity!.semanticsHash).toBe(HASH);
    expect(identity!.sourceFile).toBe('machines/domains/test/TestMachine.json');
    expect(identity!.ontology).toBe('semantics/ontology/re-core.ttl');
  });

  it('returns null for unknown machines and missing manifests', () => {
    const path = writeManifest(tempDir());
    expect(semanticIdentityFor('Nope', path)).toBeNull();
    expect(semanticIdentityFor('Test Machine', join(tempDir(), 'missing.json'))).toBeNull();
  });

  it('lists all identities and refreshes when the manifest mtime changes', () => {
    const dir = tempDir();
    const path = writeManifest(dir);
    expect(allSemanticIdentities(path)).toHaveLength(1);
    const newHash = 'cd'.repeat(32);
    writeManifest(dir, 'Test Machine', newHash);
    const future = Date.now() / 1000 + 5;
    utimesSync(path, future, future);
    expect(semanticIdentityFor('Test Machine', path)!.semanticsHash).toBe(newHash);
  });
});
