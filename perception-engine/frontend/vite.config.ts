import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const certPath = resolve(__dirname, '../../certs/server.crt');
const keyPath  = resolve(__dirname, '../../certs/server.key');
const tlsAvailable = existsSync(certPath) && existsSync(keyPath);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    https: tlsAvailable
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined,
    proxy: {
      '/api': {
        target: 'http://localhost:3004',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3004',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
