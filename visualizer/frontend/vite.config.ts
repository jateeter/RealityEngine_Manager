import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Agent } from 'https';

const certPath = resolve(__dirname, '../../certs/server.crt');
const keyPath  = resolve(__dirname, '../../certs/server.key');
const tlsAvailable = existsSync(certPath) && existsSync(keyPath);

// Lane TLS (RealityEngine_CI#668, RealityEngine_Manager#327). With RE_TLS_CERT
// set, the frontend serves TLS 1.3 with the lane certificate (a user-facing
// port: server TLS only; the browser trusts the install CA through the owner's
// trust-store step), and the /api and /ws proxy reaches the backend over https,
// verified against the lane CA. It takes precedence over certs/server.*.
const env = (n: string) => (process.env[n] ?? '').trim() || undefined;
const lane = env('RE_TLS_CERT') && env('RE_TLS_KEY') && env('RE_TLS_CA')
  ? { cert: readFileSync(env('RE_TLS_CERT')!), key: readFileSync(env('RE_TLS_KEY')!), ca: readFileSync(env('RE_TLS_CA')!) }
  : undefined;
const profile = { minVersion: 'TLSv1.3' as const, maxVersion: 'TLSv1.3' as const,
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256' };
const backendAgent = lane ? new Agent({ ...profile, ca: lane.ca, keepAlive: true }) : undefined;
const backend = lane ? 'https://localhost:3001' : 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
  },
  server: {
    port: 5173,
    // IPv4 loopback, not Vite's default `localhost`, which binds [::1] only on
    // macOS: Docker Desktop forwards host.docker.internal to the Mac's
    // 127.0.0.1, so a container (the OpenClaw browser sidecar) can open the UI
    // while it stays off the LAN. allowedHosts admits that Host header past
    // Vite's DNS-rebinding check (RealityEngine_CI#592).
    host: '127.0.0.1',
    allowedHosts: ['host.docker.internal'],
    https: lane
      ? { ...profile, cert: lane.cert, key: lane.key }
      : tlsAvailable
        ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
        : undefined,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        ...(backendAgent ? { secure: true, agent: backendAgent } : {})
      },
      '/ws': {
        target: lane ? 'wss://localhost:3001' : 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
        ...(backendAgent ? { secure: true, agent: backendAgent } : {})
      }
    }
  }
});
