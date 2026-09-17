import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',

  // One worker, everywhere — not just in CI.
  //
  // This suite drives a single Manager backend process, and the active engine
  // is one mutable global in it:
  //
  //   app.post('/api/engines/active', …) {
  //     activeEngineId = id;
  //     invalidate('machine-graph'); invalidate('machines:');
  //     connectToREStream();            // tears down and reopens the SSE stream
  //   }
  //
  // Several specs switch it — pe-api-equivalence walks cpp → lsp → scala,
  // pe-manager does the same per engine, output-stream:203 clicks an instance
  // in the switcher. Under parallel workers those run concurrently with specs
  // that are reading /api/machines and /api/pe/sources through that same
  // backend, so a spec gets a different engine's data swapped underneath it
  // mid-assertion, plus a cache invalidation and an SSE reconnect.
  //
  // Measured against a live cpp-1/lsp-1/scala-1 universe at 1338 machines,
  // three consecutive full-suite runs each way:
  //
  //   parallel (default workers):  37 → 32 → 21 passed,  7 → 10 → 13 timed out
  //   workers: 1:                  45 → 45 → 46 passed,  0 timed out
  //
  // The failure set collapsed from 17 deterministic + 8 flipping to 5
  // deterministic + 0 flipping. RealityEngine_Manager#151's baseline was
  // measured with parallel workers, so most of what it recorded as flake was
  // this race — and its note that pe-manager "skipped rather than passed when
  // run in the same invocation as openclaw-portal, and passed when run alone"
  // is the same effect seen from the other side.
  //
  // `fullyParallel` is left true deliberately: it is inert at one worker, and
  // it should stay declared so that raising the worker count is all that is
  // needed once the backend no longer keeps the active engine in a global.
  // Until then this is a correctness setting, not a speed one.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
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
