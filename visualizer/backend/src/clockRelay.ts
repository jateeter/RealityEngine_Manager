/**
 * The Manager backend relays the Lamport clock; it never ticks (RealityEngine_Manager#293,
 * RealityEngine_CI#600 SURFACE_SPEC "The instance clock": "Manager's backend and the MCP
 * gateway only relay: they pass RE-Clock through unchanged and do not tick").
 *
 * - A caller's `RE-Clock` goes to the engine unchanged, so the engine applies the
 *   receive rule to the caller's clock.
 * - The engine's `RE-Clock` comes back to the caller unchanged, on success and on an
 *   engine error alike (a malformed header is the engine's 400 to report).
 * - A request that presents `RE-Clock` bypasses the response cache: a cached answer
 *   never reached the engine, so it could carry no receive and no engine clock.
 */

import type { Request, Response } from 'express';

export const CLOCK_HEADER = 'RE-Clock';

/** The caller's RE-Clock, unchanged, for the upstream request; {} when it sent none. */
export function clockRequestHeaders(req: Pick<Request, 'headers'>): Record<string, string> {
  const value = req.headers['re-clock'];
  if (value === undefined) return {};
  return { [CLOCK_HEADER]: Array.isArray(value) ? value.join(', ') : value };
}

/** Whether the caller presented RE-Clock (and so must not be answered from cache). */
export function presentsClock(req: Pick<Request, 'headers'>): boolean {
  return req.headers['re-clock'] !== undefined;
}

/** Copy the engine's RE-Clock onto the reply, unchanged. */
export function relayClock(res: Pick<Response, 'setHeader'>, upstreamHeaders: unknown): void {
  const headers = upstreamHeaders as Record<string, unknown> | undefined;
  const value = headers?.['re-clock'];
  if (typeof value === 'string' && value) res.setHeader(CLOCK_HEADER, value);
}
