import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    // https, not http. The Visualizer's deployed surface is TLS on both paths
    // that serve it: nginx/tls-proxy.conf has `listen 5173 ssl`, and vite's own
    // dev server sets `https` whenever ../../certs/server.crt exists. A
    // plaintext request to either gets a 302 that Playwright does not follow,
    // so every test failed before reaching the app — including
    // `shows the active engine instance`, a single toBeVisible.
    // RealityEngine_Manager#117.
    baseURL: process.env.VIZ_FRONTEND_URL ?? 'https://localhost:5173',
    // The dev/deployment certificate is self-signed.
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: process.env.VIZ_FRONTEND_URL ?? 'https://localhost:5173',
    // The deployment gate runs against an already-running universe; only a bare
    // local run should start its own dev server.
    reuseExistingServer: !process.env.CI,
    ignoreHTTPSErrors: true,
    timeout: 120000,
  },
});
