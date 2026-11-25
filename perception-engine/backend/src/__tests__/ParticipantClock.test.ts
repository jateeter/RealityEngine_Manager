import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ParticipantClock, causedBy, clockMiddleware, parseHeader, MAX_LAMPORT } from '../participantClock.js';

// RealityEngine_CI#600; SURFACE_SPEC.md "The instance clock".
describe('participant clock', () => {
  it('mints a canonical version-7 UUID', () => {
    const c = new ParticipantClock();
    expect(c.instance).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([c.lamport, c.commit]).toEqual([0, 0]);
  });

  it('ticks lamport on sends and receives, both on a commit', () => {
    const c = new ParticipantClock();
    expect(c.send()).toBe(1);
    expect(c.receive(null)).toBe(2);
    expect(c.receive(10)).toBe(11);
    expect(c.receive(3)).toBe(12);
    expect(c.commitStep()).toEqual({ lamport: 13, commit: 1 });
  });

  it('parses the header as the spec says', () => {
    expect(parseHeader('instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd; lamport=42')).toBe(42);
    expect(parseHeader('instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd;lamport=0')).toBe(0);
    expect(parseHeader(`instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd; lamport=${MAX_LAMPORT}`)).toBe(MAX_LAMPORT);
    for (const bad of [
      '', 'bad',
      'lamport=1; instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd',
      'instance=0192F3A4-5B6C-7D8E-9F01-23456789ABCD; lamport=1',
      'instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd; lamport=01',
      'instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd; lamport=-1',
      'instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd; lamport=9007199254740992',
      'instance=0192f3a4-5b6c-7d8e-9f01-23456789abcd; lamport=1; x=2',
    ]) expect(parseHeader(bad), bad).toBeNull();
  });

  it('prefers the record for causedBy, then a well-formed echo', () => {
    const own = { instance: '0192f3a0-0000-7000-8000-0000000000c2', lamport: 7 };
    const echo = { instance: '0192f3a0-0000-7000-8000-000000000009', lamport: 42 };
    expect(causedBy(own, echo)).toEqual(own);
    expect(causedBy(undefined, echo)).toEqual(echo);
    expect(causedBy(undefined, { instance: 'NOPE', lamport: 42 })).toBeNull();
    expect(causedBy(undefined, { instance: '0192F3A0-0000-7000-8000-000000000009', lamport: 42 })).toBeNull();
    expect(causedBy(undefined, { instance: echo.instance, lamport: -1 })).toBeNull();
    expect(causedBy(undefined, null)).toBeNull();
  });

  it('receives every request and stamps every response; a malformed header is a 400', () => {
    // The middleware driven directly: no socket, so no plaintext transport.
    const clock = new ParticipantClock();
    const middleware = clockMiddleware(clock);
    const call = (header?: string | string[]) => {
      const headers: Record<string, string> = {};
      let status = 200;
      let body: unknown;
      let nextCalled = false;
      const res = {
        headersSent: false,
        setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
        writeHead() { return res; },
        status(code: number) { status = code; return res; },
        json(value: unknown) { body = value; (res as { writeHead: () => unknown }).writeHead(); return res; },
      };
      const values = header === undefined ? [] : Array.isArray(header) ? header : [header];
      const req = { headersDistinct: values.length ? { 're-clock': values } : {} };
      middleware(req as unknown as Request, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);
      // A handled request answers afterwards, through the same writeHead.
      if (nextCalled) (res as { writeHead: () => unknown }).writeHead();
      return { status, body, nextCalled, stamp: headers['re-clock'] };
    };

    const plain = call();
    expect(plain.nextCalled).toBe(true);
    expect(parseHeader(plain.stamp!)).toBe(2);
    const injected = call('instance=0192f3a0-0000-7000-8000-000000000001; lamport=5000000');
    expect(parseHeader(injected.stamp!)).toBe(5000002);
    const bad = call('bad');
    expect([bad.status, bad.body, bad.nextCalled]).toEqual([400, { error: 'malformed RE-Clock header' }, false]);
    expect(bad.stamp).toBeDefined();
    const repeated = call([
      'instance=0192f3a0-0000-7000-8000-000000000001; lamport=1',
      'instance=0192f3a0-0000-7000-8000-000000000001; lamport=2',
    ]);
    expect(repeated.status).toBe(400);
    expect(clock.headers()).toEqual({ received: 1, missing: 1, rejected: 2 });
  });
});
