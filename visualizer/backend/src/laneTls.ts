// Lane TLS (RealityEngine_CI#668, RealityEngine_Manager#327).
//
// The runtime contract is RealityEngine_CI docs/TRANSPORT_SECURITY.md:
// RE_TLS_CERT, RE_TLS_KEY, RE_TLS_CA, RE_TLS_CRL. With RE_TLS_CERT set this
// service serves TLS 1.3 only on its own port with the profile's suites and
// groups; with RE_TLS_CA set its https calls to internal peers trust the lane
// CA alone and present its certificate. With neither set nothing here runs,
// and TLS_CERT_PATH / CA_CERT_PATH (the legacy proxied pair) keep working.
//
// The same file is in visualizer/backend and perception-engine/backend. The
// engines (C++ src/http.cpp, LSP src/tls.lisp, Scala LaneTls) make the same
// choices; the TypeScript PE is measured against them.

import { readFileSync } from 'fs';
import * as https from 'https';
import * as tls from 'tls';
import { isIP } from 'net';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AxiosInstance } from 'axios';

export const PROFILE_SUITES = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
export const GROUPS_PQ = 'X25519MLKEM768:X25519:secp384r1';
export const GROUPS_FALLBACK = 'X25519:secp384r1';
export const CLIENT_CERTIFICATE_REQUIRED = '{"error":"client certificate required"}';

/** The PE's device routes: the HealthKit bridge on a phone reaches them with
 * server TLS and its bearer token (localHealthkitBridge docs/INGEST_CONTRACT.md).
 * resync is called by a service and is not one of them. */
export const PE_DEVICE_ROUTES: readonly string[] = [
  '/api/integrations/healthkit/ingest',
  '/api/integrations/healthkit/status',
  '/api/integrations/healthkit/scope',
];

export interface LaneTlsSettings { cert: string; key: string; ca: string; crl?: string }

const env = (name: string): string | undefined => {
  const v = (process.env[name] ?? '').trim();
  return v === '' ? undefined : v;
};

/** RE_TLS_CERT set: serve TLS. A partial configuration is an error, never a plaintext start. */
export function servingSettings(): LaneTlsSettings | undefined {
  const cert = env('RE_TLS_CERT');
  if (!cert) return undefined;
  const key = env('RE_TLS_KEY');
  const ca = env('RE_TLS_CA');
  if (!key || !ca) throw new Error('TLS: RE_TLS_CERT is set, so RE_TLS_KEY and RE_TLS_CA must be too');
  return { cert, key, ca, crl: env('RE_TLS_CRL') };
}

export const laneOn = (): boolean => env('RE_TLS_CA') !== undefined;

let groupsInForce: string | undefined;
/** The profile's groups this Node's OpenSSL accepts: the PQ hybrid first. */
export function profileGroups(): string {
  if (groupsInForce) return groupsInForce;
  try {
    tls.createSecureContext({ ecdhCurve: GROUPS_PQ });
    groupsInForce = GROUPS_PQ;
  } catch {
    groupsInForce = GROUPS_FALLBACK;
  }
  return groupsInForce;
}

function profile(): tls.SecureContextOptions {
  return { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: PROFILE_SUITES, ecdhCurve: profileGroups() };
}

function read(path: string, what: string): Buffer {
  try { return readFileSync(path); } catch (e) { throw new Error(`TLS: cannot load ${what} ${path}: ${(e as Error).message}`); }
}

function laneTrust(s: { ca: string; crl?: string }): tls.SecureContextOptions {
  return { ca: read(s.ca, 'RE_TLS_CA'), ...(s.crl ? { crl: read(s.crl, 'RE_TLS_CRL') } : {}) };
}

/**
 * Server options. `clientCertificate`:
 *  - 'required': the handshake refuses a client without a lane certificate;
 *  - 'devices': one is requested and verified when presented, and
 *    [[requireClientCertificate]] answers 403 for every route but PE_DEVICE_ROUTES;
 *  - 'none': server TLS only (a user-facing port: the Manager backend).
 */
export function serverOptions(s: LaneTlsSettings, clientCertificate: 'required' | 'devices' | 'none'): https.ServerOptions {
  return {
    ...profile(),
    cert: read(s.cert, 'RE_TLS_CERT'),
    key: read(s.key, 'RE_TLS_KEY'),
    ...laneTrust(s),
    requestCert: clientCertificate !== 'none',
    rejectUnauthorized: clientCertificate === 'required',
  };
}

/** For 'devices': a presented certificate the lane CA does not verify is refused
 * outright, as the other engines refuse it at the handshake. */
export function refuseUntrustedPresented(server: https.Server): void {
  server.on('secureConnection', (socket: tls.TLSSocket) => {
    if (socket.authorized) return;
    const peer = socket.getPeerCertificate();
    if (peer && Object.keys(peer).length > 0) socket.destroy();
  });
}

/** Express/connect middleware for 'devices': 403 without a verified certificate,
 * except on the device routes. */
export function requireClientCertificate(deviceRoutes: readonly string[] = PE_DEVICE_ROUTES) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const socket = req.socket as tls.TLSSocket;
    const path = (req.url ?? '/').split('?')[0];
    if (socket.authorized || deviceRoutes.includes(path)) { next(); return; }
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(CLIENT_CERTIFICATE_REQUIRED);
  };
}

export function startupLine(port: number | string, clientCertificate: 'required' | 'devices' | 'none'): string {
  const req = clientCertificate === 'required' ? 'client certificate required'
    : clientCertificate === 'devices' ? 'client certificate required except device routes'
    : 'server TLS only';
  const g = profileGroups();
  return `listening on ${port} (TLS 1.3, ${req}, groups ${g}${g === GROUPS_FALLBACK ? ' - this OpenSSL has no X25519MLKEM768' : ''})`;
}

/** An internal peer: loopback, a private or link-local address, a single-label
 * name (a compose service), or a name under .localhost, .internal or .local. */
export function isInternalHost(raw: string): boolean {
  const h = (raw ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '') return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (kind === 6) {
    if (h === '::1') return true;
    const first = parseInt(h.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return !h.includes('.');
}

let internalAgent: https.Agent | undefined;
let externalAgent: https.Agent | undefined;

/** The agent for an https URL with the lane on: the lane CA and this service's
 * certificate for an internal peer, the system store for any other; both held
 * to the profile, kept alive, with Node's host/IP check. Undefined with the lane
 * off, so the caller's own behaviour stands. */
export function agentFor(url: string | URL): https.Agent | undefined {
  if (!laneOn()) return undefined;
  let u: URL;
  try { u = typeof url === 'string' ? new URL(url) : url; } catch { return undefined; }
  if (u.protocol !== 'https:') return undefined;
  if (isInternalHost(u.hostname)) {
    if (!internalAgent) {
      const own = (() => { const c = env('RE_TLS_CERT'); const k = env('RE_TLS_KEY');
        return c && k ? { cert: read(c, 'RE_TLS_CERT'), key: read(k, 'RE_TLS_KEY') } : {}; })();
      internalAgent = new https.Agent({ keepAlive: true, ...profile(), ...laneTrust({ ca: env('RE_TLS_CA')!, crl: env('RE_TLS_CRL') }), ...own });
    }
    return internalAgent;
  }
  if (!externalAgent) externalAgent = new https.Agent({ keepAlive: true, ...profile() });
  return externalAgent;
}

/** Give every https request an axios instance makes the lane agent (lane on only). */
export function installAxios(instance: AxiosInstance): void {
  instance.interceptors.request.use((config) => {
    if (!laneOn()) return config;
    try {
      const url = new URL(config.url ?? '', config.baseURL);
      const agent = agentFor(url);
      if (agent) config.httpsAgent = agent;
    } catch { /* a relative URL with no base: leave it to axios */ }
    return config;
  });
}

/** Test hook: forget cached agents and groups. */
export function resetForTests(): void {
  internalAgent?.destroy(); externalAgent?.destroy();
  internalAgent = undefined; externalAgent = undefined; groupsInForce = undefined;
}
