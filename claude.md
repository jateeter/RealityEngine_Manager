# RealityEngine_Manager Guidance

Last reviewed: 2026-06-22

See `/Users/johnt/workspace/GitHub/claude.md` for the integrated application map. Update both this file and the root map when Manager ownership of runtime surfaces, PE behavior, or integration paths changes.

## Role

This repo contains the user-facing Manager application and the TypeScript Perception Engine implementation.

## Codebase Map

- `visualizer/backend/src/`: Express backend, registry client, runtime proxying, audit logging, WebSocket bridge, and MQTT proxy endpoints.
- `visualizer/frontend/src/`: React/Vite Visualizer, engine switcher, graph views, MQTT controls, machine views, and PE Manager UI.
- `visualizer/frontend/e2e/`: Playwright UI and multi-engine parity tests.
- `perception-engine/backend/src/`: TypeScript PE implementation.
- `perception-engine/backend/src/integrations/`: source adapter pipeline, registry, ACP/OpenClaw, OpenAI, Ollama, HealthKit, and CareKit adapters.
- `perception-engine/backend/src/dispatch/`: ledger-backed dispatch records and types.
- `perception-engine/backend/src/triggers/`: trigger dispatch and envelope construction.
- `perception-engine/frontend/src/`: PE-facing management frontend.
- `docs/`: Manager, Visualizer, and PE docs/API references.

## Key Commands

```bash
./start.sh --re http://localhost:5101 --pe http://localhost:5100 --no-seed
./stop.sh
cd visualizer/backend && npm run build
cd visualizer/frontend && npm run build && npm run test:e2e -- --project=chromium --workers=1
cd perception-engine/backend && npm run build && npm test
cd perception-engine/frontend && npm run build
```

## Runtime Contract

- Manager must keep active RE and PE endpoints aligned when engine selection changes.
- Backend should read `RE_REGISTRY_URL` for multi-engine runtime state.
- PE integration config should come from `INTEGRATIONS_CONFIG`.
- OpenClaw source mapping should use `ACP_COMPLETION_SOURCE_MAPPING_ID=acp-openclaw-completion`.
- Use `VIZ_RATE_LIMIT_MAX` and `VIZ_MACHINES_RATE_LIMIT_MAX` for high-volume e2e runs.

## LSP Support

Use TypeScript language server in each Node/React subproject. Open the relevant subproject root for local `tsconfig` context. Use ESLint where configured, CSS/HTML support for frontend work, JSON schema support for config/API captures, and markdown LSP for docs.

## Editing Rules

- The Playwright report and test-results directories are generated artifacts. They may be staged only when the user explicitly asks.
- Treat `perception-engine/backend/src/dispatch` as an audit surface; ledger changes need tests.
- Treat `perception-engine/backend/src/integrations` and `src/triggers` as cross-system contract code.
- Keep frontend API helpers aligned with backend proxy additions.
