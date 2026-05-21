/**
 * Integration Registry — public types.
 *
 * The registry shape mirrors `config/integrations.example.json` and the C++
 * implementation in `RealityEngine_CPP/src/perception_engine_server.cpp`
 * (`load_integration_registry()` + `integration_status()`).  The TS loader
 * is intentionally permissive: provider-specific keys are passed through
 * unchanged so adapters can read them later without redefining the schema.
 */

export interface SourceMappingRegion {
  offset: number;
  length: number;
}

export interface IntegrationEntry {
  id: string;
  kind: string;
  enabled?: boolean;
  /** Provider-specific keys are kept as-is for downstream adapters. */
  [key: string]: unknown;
}

export interface SourceMapping {
  id: string;
  sensorId?: string;
  sensorIdTemplate?: string;
  region?: SourceMappingRegion;
  ttlMs?: number;
  /** Extract/normalize blocks are stored verbatim for Phase 1's SourceMapper. */
  [key: string]: unknown;
}

export interface RegistryFile {
  version?: string;
  defaults?: Record<string, unknown>;
  integrations?: IntegrationEntry[];
  sourceMappings?: SourceMapping[];
  [key: string]: unknown;
}

/**
 * In-memory state. `config` holds the raw parsed JSON (or `{}` on error);
 * `sourceMappingIndex` is the by-id lookup used by Phase 1's completion
 * resolver.  Both fields stay `loaded === false` until a registry parses
 * cleanly so callers can fail closed.
 */
export interface RegistryState {
  loaded: boolean;
  path: string | null;
  error: string | null;
  config: RegistryFile;
  sourceMappingIndex: Map<string, SourceMapping>;
}

// ── /api/integrations/status response shape ─────────────────────────────────
// Wire-compatible with `RealityEngine_CPP::integration_status()`.  Tests in
// __tests__/Registry.test.ts assert the field set byte-for-byte against the
// example registry so the two engines remain drop-in interchangeable for
// adapters and dashboards.

export interface IntegrationStatusEntry {
  id: string;
  kind: string;
  enabled: boolean;
}

export interface SourceMappingStatusEntry {
  id: string;
  sensorId: string;
  sensorIdTemplate: string;
  region: SourceMappingRegion | null;
  ttlMs: number | null;
}

export interface IntegrationStatusBody {
  loaded: boolean;
  path: string | null;
  error: string | null;
  integrationCount: number;
  sourceMappingCount: number;
  integrations: IntegrationStatusEntry[];
  sourceMappings: SourceMappingStatusEntry[];
  completionEndpoint: string;
}
