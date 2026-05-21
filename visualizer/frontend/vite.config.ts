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
