import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
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

  it('receives every request and stamps every response; a malformed header is a 400', async () => {
    const clock = new ParticipantClock();
    const app = express();
    app.use(clockMiddleware(clock));
    app.get('/x', (_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (path: string, header?: string) =>
      fetch(base + path, header ? { headers: { 'RE-Clock': header } } : {});
    try {
      const plain = await get('/x');
      expect(plain.status).toBe(200);
      expect(parseHeader(plain.headers.get('re-clock')!)).toBe(2);
      const injected = await get('/x', 'instance=0192f3a0-0000-7000-8000-000000000001; lamport=5000000');
      expect(parseHeader(injected.headers.get('re-clock')!)).toBe(5000002);
      const bad = await get('/x', 'bad');
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'malformed RE-Clock header' });
      expect(bad.headers.get('re-clock')).not.toBeNull();
      const missing = await get('/nope');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('re-clock')).not.toBeNull();
      expect(clock.headers()).toEqual({ received: 1, missing: 2, rejected: 1 });
    } finally {
      server.close();
    }
  });
});
