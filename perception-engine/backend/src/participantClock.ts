/**
 * The PE's participant clock (RealityEngine_CI#600; SURFACE_SPEC.md "The
 * instance clock"): `{instance, lamport, commit, step}`, the rule the three
 * voters implement.
 *
 * - `lamport` is the full Lamport clock: it ticks on every completed push,
 *   every send and every receive, and a receive is `max(local, received) + 1`.
 * - `commit` counts completed pushes.
 *
 * This PE is a conformance follower bound to Manager. CI never allocates it a
 * participant UUID (Manager's pair is not an engine instance, RealityEngine_CI
 * #363), so it runs what the spec gives a participant without an allocation: a
 * version-7 UUID minted at boot, unpersisted. Node takes no POSIX record lock,
 * so it cannot hold the `<uuid>.lock` an allocated participant must hold; a
 * `PE_INSTANCE_UUID` handed to it is reported and not used.
 *
 * - Server ({@link clockMiddleware}): every request is a receive, applied before
 *   it is handled, and a malformed or repeated `RE-Clock` header is refused with
 *   400 (still a receive). Every response is a send, stamped `RE-Clock`.
 * - Client ({@link installClockInterceptors}): every call to an internal peer is
 *   a send and its response a receive. An external party is never stamped.
 */
import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AxiosInstance } from 'axios';
import { isInternalHost } from './laneTls.js';

export const HEADER = 're-clock';
/** 2^53 - 1: the largest lamport an RE-Clock header may carry. */
export const MAX_LAMPORT = Number.MAX_SAFE_INTEGER;

const CANONICAL = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A version-7 UUID (RFC 9562): 48 bits of Unix milliseconds, then random bits. */
export function mintV7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(40 - 8 * i)) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * An RE-Clock header value, parsed: the sender's lamport, or null when the
 * value is malformed (a canonical lower-case UUID and an integer in
 * [0, 2^53 - 1] with no sign or leading zeros, each once, in that order,
 * separated by `;` with optional spaces).
 */
export function parseHeader(value: string): number | null {
  const parts = value.split(';');
  if (parts.length !== 2) return null;
  const first = parts[0]!.replace(/^ +| +$/g, '');
  const second = parts[1]!.replace(/^ +| +$/g, '');
  if (!first.startsWith('instance=') || !second.startsWith('lamport=')) return null;
  const uuid = first.slice('instance='.length);
  const digits = second.slice('lamport='.length);
  if (!LOWER.test(uuid)) return null;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(digits)) return null;
  const n = Number(digits);
  return n <= MAX_LAMPORT ? n : null;
}

export class ParticipantClock {
  readonly instance: string;
  private lamportValue = 0;
  private commitValue = 0;
  private counts = { received: 0, missing: 0, rejected: 0 };

  constructor(instance: string = mintV7()) {
    this.instance = instance;
  }

  get lamport(): number { return this.lamportValue; }
  get commit(): number { return this.commitValue; }

  /** A completed push: commit and lamport tick together. */
  commitStep(): { lamport: number; commit: number } {
    this.commitValue += 1;
    this.lamportValue += 1;
    return { lamport: this.lamportValue, commit: this.commitValue };
  }

  /** A send -- a response or an outbound call: lamport ticks. */
  send(): number {
    this.lamportValue += 1;
    return this.lamportValue;
  }

  /** A receive: max(local, received) + 1, or local + 1 when none was presented. */
  receive(received: number | null): number {
    this.lamportValue = Math.max(this.lamportValue, received ?? 0) + 1;
    return this.lamportValue;
  }

  header(lamport: number): string {
    return `instance=${this.instance}; lamport=${lamport}`;
  }

  countHeader(kind: 'received' | 'missing' | 'rejected'): void {
    this.counts[kind] += 1;
  }

  /** `headers` on the clock route: the inbound RE-Clock headers since boot. */
  headers(): { received: number; missing: number; rejected: number } {
    return { ...this.counts };
  }

  /** `clock` on a message this PE stores or forwards: a tick, as {instance, lamport}. */
  event(): { instance: string; lamport: number } {
    return { instance: this.instance, lamport: this.send() };
  }
}

function bootClock(): ParticipantClock {
  const allocated = process.env['PE_INSTANCE_UUID'];
  if (allocated) {
    console.warn(
      `PE_INSTANCE_UUID ${allocated} is not used: this PE cannot hold the participant lock, so it runs a minted, unpersisted clock (RealityEngine_CI#600)`,
    );
  }
  return new ParticipantClock();
}

/** This process's clock. */
export const peClock = bootClock();

/** The server half, before every route. */
export function clockMiddleware(clock: ParticipantClock = peClock) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const values = req.headersDistinct?.[HEADER] ?? [];
    // Every response is a send: tick, then stamp, as its head is written.
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = (...args: unknown[]) => {
      if (!res.headersSent) res.setHeader('RE-Clock', clock.header(clock.send()));
      return writeHead(...args);
    };
    const parsed = values.length === 0 ? null : values.length === 1 ? parseHeader(values[0]!) : null;
    if (values.length > 0 && parsed === null) {
      clock.countHeader('rejected');
      clock.receive(null);
      res.status(400).json({ error: 'malformed RE-Clock header' });
      return;
    }
    clock.countHeader(values.length === 1 ? 'received' : 'missing');
    clock.receive(parsed);
    next();
  };
}

/** The client half on an axios instance: internal peers only. */
export function installClockInterceptors(instance: AxiosInstance, clock: ParticipantClock = peClock): void {
  const clocked = Symbol.for('re-clock.clocked');
  instance.interceptors.request.use((config) => {
    let host = '';
    try {
      host = new URL(config.url ?? '', config.baseURL ?? undefined).hostname;
    } catch {
      host = '';
    }
    if (host && isInternalHost(host)) {
      config.headers.set('RE-Clock', clock.header(clock.send()));
      (config as unknown as Record<symbol, boolean>)[clocked] = true;
    }
    return config;
  });
  const onResponse = (headers: unknown, config: unknown): void => {
    if (!(config as Record<symbol, boolean> | undefined)?.[clocked]) return;
    const value = (headers as Record<string, unknown> | undefined)?.[HEADER];
    clock.receive(typeof value === 'string' ? parseHeader(value) : null);
  };
  instance.interceptors.response.use(
    (response) => {
      onResponse(response.headers, response.config);
      return response;
    },
    (error: { response?: { headers?: unknown; config?: unknown } }) => {
      if (error?.response) onResponse(error.response.headers, error.response.config);
      return Promise.reject(error);
    },
  );
}

/**
 * A completion's causedBy: the PE's own dispatch record's clock when it has one,
 * else the sender's well-formed echo (a canonical lower-case UUID and a lamport
 * in [0, 2^53 - 1]), else null.
 */
export function causedBy(own: unknown, echo: unknown): { instance: string; lamport: number } | null {
  if (own && typeof own === 'object') return own as { instance: string; lamport: number };
  if (!echo || typeof echo !== 'object') return null;
  const { instance, lamport } = echo as { instance?: unknown; lamport?: unknown };
  if (typeof instance !== 'string' || !CANONICAL.test(instance) || instance.toLowerCase() !== instance) return null;
  if (typeof lamport !== 'number' || !Number.isInteger(lamport) || lamport < 0 || lamport > MAX_LAMPORT) return null;
  return { instance, lamport };
}
