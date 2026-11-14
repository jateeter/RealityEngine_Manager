// Lane TLS (RealityEngine_CI#668, RealityEngine_Manager#327): the checks the
// engines make (RealityEngine_CPP tests/http_tls_tests.cpp, LSP
// tests/tls-tests.lisp, Scala LaneTlsSpec). A throwaway PKI from the openssl
// CLI, a PE-like and an RE-like server on loopback, axios through installAxios,
// and tls.connect for the refusals.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as https from 'https';
import * as tls from 'tls';
import type { AddressInfo } from 'net';
import axios from 'axios';
import * as lane from '../laneTls.js';

const openssl = ['/opt/homebrew/opt/openssl@3/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl'].find(existsSync) ?? 'openssl';
const dir = mkdtempSync(join(tmpdir(), 're-mgr-tls-'));
const f = (n: string) => join(dir, n);
const sh = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' });

function makePki(): void {
  writeFileSync(f('ca.cnf'), `[ca]\ndefault_ca=d\n[d]\ndir=${dir}\ndatabase=$dir/index.txt\ncrlnumber=$dir/crlnumber\ndefault_md=sha384\ndefault_crl_days=2\n`);
  writeFileSync(f('index.txt'), '');
  writeFileSync(f('crlnumber'), '01\n');
  writeFileSync(f('leaf.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\nkeyUsage=critical,digitalSignature\n');
  writeFileSync(f('client.ext'), 'extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\n');
  for (const ca of ['ca', 'rogue-ca'])
    sh(`${openssl} req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-384 -nodes -sha384 -days 2 -subj /CN=${ca} -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign -keyout ${ca}.key -out ${ca}.crt`);
  for (const [name, issuer, ext] of [['ts-pe', 'ca', 'leaf.ext'], ['revoked', 'ca', 'client.ext'], ['rogue', 'rogue-ca', 'client.ext']]) {
    sh(`${openssl} req -newkey ec -pkeyopt ec_paramgen_curve:P-384 -nodes -subj /CN=${name} -keyout ${name}.key -out ${name}.csr`);
    sh(`${openssl} x509 -req -sha384 -days 2 -in ${name}.csr -CA ${issuer}.crt -CAkey ${issuer}.key -CAcreateserial -extfile ${ext} -out ${name}.crt`);
    writeFileSync(f(`${name}.chain`), Buffer.concat([readFileSync(f(`${name}.crt`)), readFileSync(f(`${issuer}.crt`))]));
  }
  sh(`${openssl} ca -config ca.cnf -keyfile ca.key -cert ca.crt -revoke revoked.crt`);
  sh(`${openssl} ca -config ca.cnf -keyfile ca.key -cert ca.crt -gencrl -out ca.crl`);
}

const servers: https.Server[] = [];
let rePort = 0;
let pePort = 0;

function listen(server: https.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function json(body: string) {
  return (_req: unknown, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }) => {
    res.setHeader('Content-Type', 'application/json'); res.end(body);
  };
}

/** One GET over tls.connect: the HTTP status line, or the error that refused it. */
function rawGet(port: number, path: string, opts: tls.ConnectionOptions, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: readFileSync(f('ca.crt')), ...opts }, () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${extra}Connection: close\r\n\r\n`);
    });
    s.setTimeout(4000, () => { s.destroy(); resolve(out || 'timeout'); });
    s.on('data', (d) => { out += d.toString(); });
    s.on('end', () => resolve(out || 'closed'));
    s.on('close', () => resolve(out || 'closed'));
    s.on('error', (e) => resolve(`error: ${e.message}`));
  });
}
const own = () => ({ cert: readFileSync(f('ts-pe.chain')), key: readFileSync(f('ts-pe.key')) });
const rogue = () => ({ cert: readFileSync(f('rogue.chain')), key: readFileSync(f('rogue.key')) });
const revoked = () => ({ cert: readFileSync(f('revoked.chain')), key: readFileSync(f('revoked.key')) });

beforeAll(async () => {
  makePki();
  process.env['RE_TLS_CERT'] = f('ts-pe.chain');
  process.env['RE_TLS_KEY'] = f('ts-pe.key');
  process.env['RE_TLS_CA'] = f('ca.crt');
  process.env['RE_TLS_CRL'] = f('ca.crl');
  lane.resetForTests();
  const settings = lane.servingSettings()!;

  const re = https.createServer(lane.serverOptions(settings, 'required'), json('{"status":"ok"}') as never);
  servers.push(re);
  rePort = await listen(re);

  const guard = lane.requireClientCertificate();
  const sourceGuard = lane.requireDeviceSourceCertificate();
  process.env['HEALTHKIT_CLIENT_CERTIFICATE_REQUIRED'] = 'pim';
  const pe = https.createServer(lane.serverOptions(settings, 'devices'), (req, res) => {
    guard(req, res, () => {
      // What Express's query parser gives the per-source guard.
      const query = Object.fromEntries(new URL(req.url ?? '/', 'https://x').searchParams);
      sourceGuard(Object.assign(req, { query }), res, () =>
        json(req.url?.startsWith('/api/integrations/healthkit/status') ? '{"device":true}' : '{"service":true}')(req, res));
    });
  });
  lane.refuseUntrustedPresented(pe);
  servers.push(pe);
  pePort = await listen(pe);
  lane.installAxios(axios);
});

afterAll(() => {
  for (const s of servers) s.close();
  lane.resetForTests();
  for (const v of ['RE_TLS_CERT', 'RE_TLS_KEY', 'RE_TLS_CA', 'RE_TLS_CRL', 'HEALTHKIT_CLIENT_CERTIFICATE_REQUIRED']) delete process.env[v];
  rmSync(dir, { recursive: true, force: true });
});

describe('the internal-peer rule', () => {
  it('matches C++, LSP and Scala', () => {
    for (const h of ['127.0.0.1', 'localhost', 'engine-cpp-re', 'cpp-1.localhost', 'host.docker.internal', '10.0.0.5',
      '172.16.0.1', '172.31.255.1', '192.168.1.20', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', 'printer.local'])
      expect(lane.isInternalHost(h), h).toBe(true);
    for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1', ''])
      expect(lane.isInternalHost(h), h).toBe(false);
  });
});

describe('the client (installAxios)', () => {
  it('reaches an IP SAN and a DNS SAN with the lane CA and its own certificate, on kept-alive connections', async () => {
    expect((await axios.get(`https://127.0.0.1:${rePort}/health`)).data).toEqual({ status: 'ok' });
    expect((await axios.get(`https://localhost:${rePort}/health`)).data).toEqual({ status: 'ok' });
    let ok = 0;
    for (let i = 0; i < 10; i++) if ((await axios.get(`https://127.0.0.1:${rePort}/health`)).data.status === 'ok') ok++;
    expect(ok).toBe(10);
  });
});

describe('an RE-like port (client certificate required)', () => {
  it('serves a lane client over TLS 1.3 with a profile suite', async () => {
    const out = await rawGet(rePort, '/health', own());
    expect(out).toContain('HTTP/1.1 200');
  });
  it('refuses no certificate, TLS 1.2, a suite outside the profile, another CA and a revoked certificate', async () => {
    expect(await rawGet(rePort, '/health', {})).not.toContain('HTTP/1.1 200');
    expect(await rawGet(rePort, '/health', { ...own(), maxVersion: 'TLSv1.2' })).not.toContain('HTTP/1.1 200');
    expect(await rawGet(rePort, '/health', { ...own(), ciphers: 'TLS_AES_128_GCM_SHA256' })).not.toContain('HTTP/1.1 200');
    expect(await rawGet(rePort, '/health', rogue())).not.toContain('HTTP/1.1 200');
    expect(await rawGet(rePort, '/health', revoked())).not.toContain('HTTP/1.1 200');
  });
});

describe('a PE-like port (device routes)', () => {
  it('serves a device route without a client certificate', async () => {
    expect(await rawGet(pePort, '/api/integrations/healthkit/status', {})).toContain('HTTP/1.1 200');
  });
  it('answers 403 for any other route without one, and serves it to a lane client', async () => {
    const out = await rawGet(pePort, '/service', {});
    expect(out).toContain('HTTP/1.1 403');
    expect(out).toContain(lane.CLIENT_CERTIFICATE_REQUIRED);
    expect(await rawGet(pePort, '/service', own())).toContain('HTTP/1.1 200');
  });
  it('still refuses a presented untrusted certificate', async () => {
    expect(await rawGet(pePort, '/api/integrations/healthkit/status', rogue())).not.toContain('HTTP/1.1 200');
  });
  it('requires a certificate of a source listed in HEALTHKIT_CLIENT_CERTIFICATE_REQUIRED, and of no other', async () => {
    const refused = await rawGet(pePort, '/api/integrations/healthkit/status?bridgeId=pim', {});
    expect(refused).toContain('HTTP/1.1 403');
    expect(refused).toContain(lane.CLIENT_CERTIFICATE_REQUIRED);
    expect(await rawGet(pePort, '/api/integrations/healthkit/status?bridgeId=pim', own())).toContain('HTTP/1.1 200');
    expect(await rawGet(pePort, '/api/integrations/healthkit/status?bridgeId=phone', {})).toContain('HTTP/1.1 200');
  });
  it('believes a proxy that says it verified no caller certificate, and only a proxy with a lane certificate', async () => {
    const via = (header: string, opts: tls.ConnectionOptions) => rawGet(pePort, '/api/integrations/healthkit/status?bridgeId=pim',
      opts, { 'X-Client-Certificate': header });
    expect(await via('NONE', own())).toContain('HTTP/1.1 403');
    expect(await via('SUCCESS', own())).toContain('HTTP/1.1 200');
    expect(await via('SUCCESS', {})).toContain('HTTP/1.1 403');
  });
});

describe('per-source device certificates (owner, 2026-11-12)', () => {
  it('reads the sources as a trimmed comma list', () => {
    expect([...lane.certificateSources(' pim , other,')]).toEqual(['pim', 'other']);
    expect(lane.certificateSources('').size).toBe(0);
  });
  it('takes the source from the query, then the body, then the configured bridge', () => {
    expect(lane.deviceSource({ bridgeId: 'phone-2' }, {})).toBe('phone-2');
    expect(lane.deviceSource({}, { source: 'pim', bridgeId: 'phone' })).toBe('pim');
    expect(lane.deviceSource({}, { source: '', bridgeId: 'phone' })).toBe('phone');
    expect(lane.deviceSource(undefined, undefined)).toBe('healthkit-ios-bridge');
  });
});
