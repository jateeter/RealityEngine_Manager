# Manager Visualizer Frontend Guidance

This package is the React/Vite user interface for the integrated application.

- `src/App.tsx`, `src/api.ts`, and `src/store.ts` coordinate runtime state.
- `src/components/EngineSwitcher.tsx`, `MqttPanel.tsx`, `MachinePESourcesPanel.tsx`, and graph components are key integration views.
- `e2e/` contains Playwright workflows for Manager, PE Manager, and multi-engine parity.
- Treat `playwright-report/` and `test-results/` as generated artifacts unless explicitly requested.
- Run `npm run build` and targeted `npm run test:e2e` when UI behavior changes.

