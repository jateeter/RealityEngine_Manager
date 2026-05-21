import { readFileSync, existsSync, mkdirSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import type { SourceConfig } from './types.js';

interface PersistedData {
  version: 1;
  sources: SourceConfig[];
}

/**
 * Persists perception engine sources to a JSON file using atomic writes
 * (write to .tmp then rename) to prevent corruption on crash.
 *
 * Sensor sources are stripped of their live data fields (lastValue,
 * lastUpdated) before saving — those are runtime state and would be
 * stale on reload anyway.
 */
export class SourceStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = join(dataDir, 'perception-sources.json');
  }

  load(): SourceConfig[] {
    if (!existsSync(this.filePath)) return [];

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedData;
      const sources: SourceConfig[] = parsed.sources ?? [];

      // Reset live sensor fields so stale data doesn't appear on restart
      return sources.map(src => {
        if (src.type === 'sensor') {
          return { ...src, lastValue: [], lastUpdated: null };
        }
        return src;
      });
    } catch (err) {
      console.warn('[SourceStore] Failed to load sources file, starting fresh:', err);
      return [];
    }
  }

  async save(sources: SourceConfig[]): Promise<void> {
    // Strip transient sensor runtime data before persisting
    const sanitized: SourceConfig[] = sources.map(src => {
      if (src.type === 'sensor') {
        return { ...src, lastValue: [], lastUpdated: null };
      }
      return src;
    });

    const payload: PersistedData = { version: 1, sources: sanitized };
    const tmp = this.filePath + '.tmp';

    try {
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('[SourceStore] Failed to save sources:', err);
    }
  }
}
