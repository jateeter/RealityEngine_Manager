/**
 * OWL semantics manifest — machine semantic identity lookup.
 *
 * RealityEngine_Machines publishes `semantics/abox-manifest.json`: per-machine
 * name, ABox IRI, source file, and sha256 of the generated OWL ABox (see
 * docs/SEMANTIC_OWL_ROADMAP.md milestone M3 in that repo). Engines expose the
 * identity as `semanticsIri`/`semanticsHash` so cross-engine semantic
 * equivalence can be verified alongside byte equivalence (milestone M4).
 *
 * Resolution order: SEMANTICS_MANIFEST env (absolute path), then
 * `<MACHINES_DIR>/../semantics/abox-manifest.json`, then sibling
 * `RealityEngine_Machines/semantics/abox-manifest.json` walked up from cwd.
 * The parsed manifest is cached and invalidated on mtime change.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

export interface SemanticIdentity {
  name: string;
  machineKey: string;
  semanticsIri: string | null;
  semanticsHash: string | null;
  sourceFile: string | null;
  ontology: string | null;
}

interface ManifestEntry {
  name?: string;
  iri?: string;
  sha256?: string;
  sourceFile?: string;
}

interface ManifestDocument {
  ontology?: string;
  machines?: Record<string, ManifestEntry>;
}

let cached: { path: string; mtimeMs: number; byName: Map<string, SemanticIdentity> } | null = null;

export function resolveManifestPath(): string | null {
  const explicit = process.env['SEMANTICS_MANIFEST'];
  if (explicit && explicit.length > 0) return explicit;
  const candidates: string[] = [];
  const machinesDir = process.env['MACHINES_DIR'];
  if (machinesDir && machinesDir.length > 0) {
    candidates.push(join(machinesDir, '..', 'semantics', 'abox-manifest.json'));
  }
  let dir = resolve('.');
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(dir, 'RealityEngine_Machines', 'semantics', 'abox-manifest.json'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function loadManifest(path: string): Map<string, SemanticIdentity> {
  const mtimeMs = statSync(path).mtimeMs;
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.byName;
  const doc = JSON.parse(readFileSync(path, 'utf-8')) as ManifestDocument;
  const ontology = doc.ontology ?? null;
  const byName = new Map<string, SemanticIdentity>();
  for (const [machineKey, entry] of Object.entries(doc.machines ?? {}).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    if (!entry.name) continue;
    byName.set(entry.name, {
      name: entry.name,
      machineKey,
      semanticsIri: entry.iri ?? null,
      semanticsHash: entry.sha256 ?? null,
      sourceFile: entry.sourceFile ?? null,
      ontology,
    });
  }
  cached = { path, mtimeMs, byName };
  return byName;
}

/** Semantic identity for a machine name, or null when unknown/unavailable. */
export function semanticIdentityFor(name: string, manifestPath?: string): SemanticIdentity | null {
  const path = manifestPath ?? resolveManifestPath();
  if (!path || !existsSync(path)) return null;
  try {
    return loadManifest(path).get(name) ?? null;
  } catch {
    return null;
  }
}

/** All known identities (empty when no manifest is resolvable). */
export function allSemanticIdentities(manifestPath?: string): SemanticIdentity[] {
  const path = manifestPath ?? resolveManifestPath();
  if (!path || !existsSync(path)) return [];
  try {
    return Array.from(loadManifest(path).values());
  } catch {
    return [];
  }
}
