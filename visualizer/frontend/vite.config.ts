import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const certPath = resolve(__dirname, '../../certs/server.crt');
const keyPath  = resolve(__dirname, '../../certs/server.key');
const tlsAvailable = existsSync(certPath) && existsSync(keyPath);

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
    https: tlsAvailable
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true
      }
    }
  }
});
