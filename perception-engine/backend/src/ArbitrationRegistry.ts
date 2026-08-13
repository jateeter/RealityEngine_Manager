import fs from 'fs';
import path from 'path';
import type { RegistryEntry } from './Arbiter.js';

/**
 * Loads domains/arbitration-registry.json — the declaration of how each
 * contended universal-vector position resolves.
 *
 * Resolution is declared, not defaulted: an undeclared contended cell is a
 * corpus error (contract §5). The PE still has to do something when it meets one
 * anyway, and what it does is apply PRECEDENCE — which at least keeps a
 * generated contribution from overriding a deterministic one. The corpus gate
 * (`build-arbitration-registry.py --check`) is what actually prevents the
 * situation arising.
 */
class Registry {
  private entries = new Map<number, RegistryEntry>();
  private loadedFrom: string | null = null;

  get size(): number {
    return this.entries.size;
  }

  get source(): string | null {
    return this.loadedFrom;
  }

  entryFor(cell: number): RegistryEntry | undefined {
    return this.entries.get(cell);
  }

  private candidatePaths(): string[] {
    const explicit = process.env.ARBITRATION_REGISTRY ? [process.env.ARBITRATION_REGISTRY] : [];
    const machinesDir = process.env.MACHINES_DIR;
    const beside = machinesDir
      ? [
          path.join(machinesDir, '..', 'domains', 'arbitration-registry.json'),
          path.join(machinesDir, 'domains', 'arbitration-registry.json'),
        ]
      : [];
    return [
      ...explicit,
      ...beside,
      path.resolve(process.cwd(), '../../../RealityEngine_Machines/domains/arbitration-registry.json'),
      path.resolve(process.cwd(), '../RealityEngine_Machines/domains/arbitration-registry.json'),
    ];
  }

  load(): void {
    const found = this.candidatePaths().find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!found) {
      console.log('[arbiter] no arbitration registry found; contended cells fall back to PRECEDENCE');
      return;
    }
    try {
      const doc = JSON.parse(fs.readFileSync(found, 'utf8')) as { entries?: RegistryEntry[] };
      this.entries = new Map((doc.entries ?? []).map((e) => [e.cell, e]));
      this.loadedFrom = found;
      console.log(`[arbiter] loaded ${this.entries.size} contended cell declaration(s) from ${found}`);
    } catch (err) {
      console.warn(`[arbiter] failed to read ${found}: ${(err as Error).message}`);
    }
  }
}

export const arbitrationRegistry = new Registry();
