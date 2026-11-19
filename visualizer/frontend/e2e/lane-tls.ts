import fs from 'node:fs';

/**
 * Lane TLS for the live specs (RealityEngine_CI#668). The same module as
 * RealityEngine_Machines tests/support/lane-tls.ts, which it follows; keep them
 * in step.
 *
 * With the lane on (RE_TLS=on), RealityEngine_CI's lane-tls.sh exports the
 * lane CA and the harness's client certificate as RE_HARNESS_TLS_CA,
 * RE_HARNESS_TLS_CERT and RE_HARNESS_TLS_KEY. Then every spec's `request`
 * fixture verifies the engines against the lane CA, with verification on
 * (`ignoreHTTPSErrors: false`), and presents the harness certificate to every
 * origin the instance registry lists. The engines require it (mTLS).
 * Nothing falls back to unverified: a missing file is an error.
 *
 * Playwright matches client certificates by exact origin, so the origins come
 * from the instance registry *file* the universe wrote (RE_REGISTRY_FILE,
 * default /tmp/re-registry/re-registry.json), read here when the config loads.
 * The CA reaches the test workers through NODE_EXTRA_CA_CERTS, which Node reads
 * at startup; workers are forked after the config loads and inherit it.
 *
 * With the lane off this returns {} and the config is as before.
 */
export interface LaneTlsUse {
  ignoreHTTPSErrors?: boolean;
  clientCertificates?: Array<{ origin: string; certPath: string; keyPath: string }>;
}

export function laneOn(): boolean {
  return (process.env.RE_TLS ?? 'off') === 'on';
}

function harness(): { ca: string; cert: string; key: string } {
  const names = ['RE_HARNESS_TLS_CA', 'RE_HARNESS_TLS_CERT', 'RE_HARNESS_TLS_KEY'] as const;
  const missing = names.filter((n) => !process.env[n] || !fs.existsSync(process.env[n]!));
  if (missing.length) {
    throw new Error(`RE_TLS=on but ${missing.join(', ')} is unset or not a file; run the specs from ` +
      'RealityEngine_CI with the lane prepared (lane_tls_init). There is no unverified fallback.');
  }
  return { ca: process.env.RE_HARNESS_TLS_CA!, cert: process.env.RE_HARNESS_TLS_CERT!, key: process.env.RE_HARNESS_TLS_KEY! };
}

/** Every https origin the instance registry file names: instances and services. */
export function registryOrigins(file = process.env.RE_REGISTRY_FILE ?? '/tmp/re-registry/re-registry.json',
                                extra: string[] = []): string[] {
  const urls: string[] = [...extra];
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      instances?: Array<Record<string, unknown>>; services?: Record<string, unknown>;
    };
    for (const inst of doc.instances ?? []) for (const k of ['re_url', 'pe_url']) {
      if (typeof inst[k] === 'string') urls.push(inst[k] as string);
    }
    // The instance registry writes each service as {url, port}
    // (RealityEngine_CI registry_add); a bare string is accepted too. Only
    // strings were read, so no service origin got the harness certificate and
    // the mTLS services (localAI, Qdrant) refused the smoke specs on the lane
    // (RealityEngine_CI deployment gate, 2026-11-18).
    for (const v of Object.values(doc.services ?? {})) {
      if (typeof v === 'string') urls.push(v);
      else if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') urls.push((v as { url: string }).url);
    }
  } catch {
    // No registry file yet: only the extra origins.
  }
  const origins = new Set<string>();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'https:') origins.add(parsed.origin);
    } catch { /* not a URL */ }
  }
  return [...origins].sort();
}

export function laneTlsUse(extraUrls: string[] = []): LaneTlsUse {
  if (!laneOn()) return {};
  const h = harness();
  process.env.NODE_EXTRA_CA_CERTS = h.ca;
  return {
    ignoreHTTPSErrors: false,
    clientCertificates: registryOrigins(undefined, extraUrls).map((origin) => ({ origin, certPath: h.cert, keyPath: h.key })),
  };
}
