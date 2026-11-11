// The POST /api/sources create body (RealityEngine_CI SURFACE_SPEC.md,
// "POST /api/sources: the create body"; RealityEngine_CI#755).
//
// A create need not repeat the served shape. `type` names the kind, `kind` is
// accepted in its place (`type` wins), and with neither the source is
// simulated. `region` is required, and `sensorId` for a sensor; every other
// field takes the declared default the voting PEs apply (C++
// source_from_json, LSP source-from-json, Scala PerceptionJsonCodecs). This PE
// required `type` and `name`, so a sparse body the voting PEs accept answered
// 400 here.

import type { NewSourceConfig, Region } from './types.js';

export type CreateBody = Record<string, unknown>;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => num(x, 0)) : []);

/** The kind a create body names, lower-cased: `type`, else `kind`, else simulated. */
export function createKind(body: CreateBody): string {
  const named = typeof body['type'] === 'string' ? body['type'] : typeof body['kind'] === 'string' ? body['kind'] : 'simulated';
  return named.toLowerCase();
}

/**
 * The create body as a registration, with the declared defaults filled in.
 * Throws with a message for a 400 when a required field is missing or the kind
 * is unknown. Region bounds are the caller's check.
 */
export function normalizeCreateBody(body: CreateBody): NewSourceConfig & { id?: string } {
  const region = body['region'] as Partial<Region> | undefined;
  if (!region || typeof region !== 'object' || typeof region.offset !== 'number' || typeof region.length !== 'number') {
    throw new Error('region ({offset, length}) is required');
  }
  const common = {
    ...(typeof body['id'] === 'string' && body['id'] !== '' ? { id: body['id'] } : {}),
    name: str(body['name'], 'source'),
    region: { offset: region.offset, length: region.length },
    active: bool(body['active'], true),
    ...(typeof body['origin'] === 'string' ? { origin: body['origin'] } : {}),
  };
  const kind = createKind(body);
  switch (kind) {
    case 'sensor': {
      if (typeof body['sensorId'] !== 'string' || body['sensorId'] === '') throw new Error('sensorId is required for a sensor');
      const lastUpdated = body['lastUpdated'];
      return {
        ...common,
        type: 'sensor',
        sensorId: body['sensorId'],
        lastValue: numbers(body['lastValue']),
        lastUpdated: typeof lastUpdated === 'number' ? lastUpdated : null,
        ttlMs: num(body['ttlMs'], 5000),
      };
    }
    case 'test':
      return {
        ...common,
        type: 'test',
        machineId: str(body['machineId'], ''),
        machineName: str(body['machineName'], ''),
        sequenceName: str(body['sequenceName'], ''),
        inputs: Array.isArray(body['inputs']) ? (body['inputs'] as unknown[]).map(numbers) : [],
        loop: bool(body['loop'], true),
        ...(Array.isArray(body['segments']) ? { segments: body['segments'] as never } : {}),
      };
    case 'simulated':
      return {
        ...common,
        type: 'simulated',
        pattern: str(body['pattern'], 'constant') as never,
        frequency: num(body['frequency'], 1),
        amplitude: num(body['amplitude'], 1),
        dcOffset: num(body['dcOffset'], 0),
      };
    default:
      throw new Error(`Unknown source type: ${kind}`);
  }
}
