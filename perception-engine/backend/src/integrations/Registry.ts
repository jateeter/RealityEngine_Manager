/**
 * Integration Registry — loader + status renderer.
 *
 * TS implementation of the C++ contract in
 * `RealityEngine_CPP/src/perception_engine_server.cpp`
 * (`load_integration_registry()` + `integration_status()`).  The wire
 * shape returned by `integrationStatus()` is intentionally byte-compatible
 * so adapters and the visualizer can talk to either engine.
 *
 * Path resolution (matches C++):
 *   1. `INTEGRATIONS_CONFIG` env var, if set.
 *   2. Else `config/integrations.json` relative to the process CWD, if it exists.
 *   3. Else no registry — the PE starts with an empty state and the status
 *      endpoint reports `loaded:false / path:null / error:null`.
 *
 * Failure mode (matches C++):
 *   On parse / read error, `loaded` is `false`, `path` reflects the path
 *   the loader attempted, and `error` carries the exception message.
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type {
  IntegrationStatusBody,
  IntegrationStatusEntry,
  RegistryFile,
  RegistryState,
  SourceMapping,
  SourceMappingRegion,
  SourceMappingStatusEntry,
} from './types.js';

export const COMPLETION_ENDPOINT = '/api/integrations/completions';

/**
 * Build an empty registry state — used when no path is configured / found,
 * and as the post-error fallback so the rest of the backend can rely on a
 * non-null state object.
 */
export function emptyRegistryState(): RegistryState {
  return {
    loaded: false,
    path: null,
    error: null,
    config: {},
    sourceMappingIndex: new Map(),
  };
}

/**
 * Resolve the registry path the loader will read.  Returns `null` when no
 * registry is configured, matching the C++ "no file → no-op" behaviour.
 */
export function resolveRegistryPath(
  envValue: string | undefined,
  cwd: string = process.cwd(),
): string | null {
  if (envValue && envValue.trim() !== '') {
    return isAbsolute(envValue) ? envValue : resolve(cwd, envValue);
  }
  const candidate = resolve(cwd, 'config/integrations.json');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Load a registry from disk.  Pass `null` (or omit) to get the empty state
 * without touching the filesystem.  Never throws; surfaces parse / IO
 * errors through `state.error` so the rest of the PE can boot cleanly.
 *
 * Log lines match the C++ wording so an operator reading mixed logs sees
 * one message:
 *   - `Integration registry loaded — path=… sourceMappings=…`
 *   - `Integration registry failed to load: …`
 */
export function loadRegistry(path: string | null | undefined): RegistryState {
  if (!path) return emptyRegistryState();

  const state: RegistryState = {
    loaded: false,
    path,
    error: null,
    config: {},
    sourceMappingIndex: new Map<string, SourceMapping>(),
  };

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('integrations config must be a JSON object');
    }
    const config = parsed as RegistryFile;
    state.config = config;

    const mappings = Array.isArray(config.sourceMappings) ? config.sourceMappings : [];
    for (const m of mappings) {
      if (!isPlainObject(m)) continue;
      const id = typeof (m as SourceMapping).id === 'string' ? (m as SourceMapping).id : '';
      if (id !== '') state.sourceMappingIndex.set(id, m as SourceMapping);
    }
    state.loaded = true;
    // eslint-disable-next-line no-console
    console.error(
      `Integration registry loaded — path=${path} sourceMappings=${state.sourceMappingIndex.size}`,
    );
  } catch (err) {
    state.config = {};
    state.sourceMappingIndex = new Map();
    state.error = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`Integration registry failed to load: ${state.error}`);
  }
  return state;
}

/**
 * Render the registry as the C++-compatible `GET /api/integrations/status`
 * response body.  Permissive about missing / malformed entries: missing
 * strings become `""`, missing regions/ttlMs become `null`, matching the
 * C++ `Json::as_string()` / `Json::is_object()` fallthrough.
 */
export function integrationStatus(state: RegistryState): IntegrationStatusBody {
  const integrationsRaw = Array.isArray(state.config.integrations)
    ? state.config.integrations
    : [];
  const integrations: IntegrationStatusEntry[] = integrationsRaw
    .filter(isPlainObject)
    .map((item) => ({
      id: stringOrEmpty((item as Record<string, unknown>).id),
      kind: stringOrEmpty((item as Record<string, unknown>).kind),
      enabled: (item as Record<string, unknown>).enabled === true,
    }));

  const sourceMappings: SourceMappingStatusEntry[] = [];
  for (const [id, mapping] of state.sourceMappingIndex.entries()) {
    sourceMappings.push({
      id,
      sensorId: stringOrEmpty(mapping.sensorId),
      sensorIdTemplate: stringOrEmpty(mapping.sensorIdTemplate),
      region: normalizeRegion(mapping.region),
      ttlMs: typeof mapping.ttlMs === 'number' && Number.isFinite(mapping.ttlMs)
        ? mapping.ttlMs
        : null,
    });
  }

  return {
    loaded: state.loaded,
    path: state.path,
    error: state.error,
    integrationCount: integrations.length,
    sourceMappingCount: state.sourceMappingIndex.size,
    integrations,
    sourceMappings,
    completionEndpoint: COMPLETION_ENDPOINT,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normalizeRegion(region: unknown): SourceMappingRegion | null {
  if (!isPlainObject(region)) return null;
  const offset = (region as Record<string, unknown>).offset;
  const length = (region as Record<string, unknown>).length;
  if (typeof offset !== 'number' || typeof length !== 'number') return null;
  return { offset, length };
}
