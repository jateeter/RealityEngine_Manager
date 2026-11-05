# RealityEngine_Manager Guidance

Last reviewed: 2026-11-04

See `/Users/johnt/workspace/GitHub/CLAUDE.md` for the integrated application map. Update both this file and the root map when Manager ownership of runtime surfaces, PE behavior, or integration paths changes.

## Role

This repo contains the user-facing Manager application and the TypeScript Perception Engine implementation.

## Codebase Map

- `visualizer/backend/src/`: Express backend, instance registry client, runtime proxying, audit logging, WebSocket bridge, and MQTT proxy endpoints.
- `visualizer/backend/src/corpus.ts`: machine-corpus catalog (`GET /api/corpus/tree`) and domain-scoped load orchestration (`POST /api/corpus/load`) for the Load Machines modal. The catalog root is `MACHINES_CATALOG_DIR` (else `MACHINES_DIR`), plus colon-separated `MACHINES_CATALOG_EXTRA_DIRS`; startUniverse.sh passes the full corpus and localAIStack's `data/machines`, because `MACHINES_DIR` is the bounded corpus the engines boot (#256). Every load path (`POST /api/corpus/load`, `POST /api/machines`, `POST /api/machines/json/import`) interns the loaded machines' test sequences as `test` sources on the PE paired with each RE it reached; a corpus load opts out with `bootstrapPeSources: false` (#304). Backend unit tests run with `npm test` (vitest).
- `visualizer/frontend/src/`: React/Vite Visualizer, engine switcher, graph views, MQTT controls, machine views, and PE Manager UI.
  Two top-level views, Machines (`RealityEnginePanelView`, with the machine graph) and Perception (`PerceptualEngineView`), switched by `components/ViewNav.tsx` at the upper left of both headers; there is no Interconnection view and no back button (#306). A change to the engines' machine set calls the store's `notifyMachinesChanged()`, which the 2D and 3D graphs refetch on, and the backend's `invalidateMachines()` drops the machine and machine-graph caches (#307).
- `visualizer/frontend/e2e/`: Playwright UI and multi-engine parity tests.
- `perception-engine/backend/src/`: TypeScript PE implementation.
- `perception-engine/backend/src/integrations/`: source adapter pipeline, adapter registry, ACP/OpenClaw, OpenAI, Ollama, HealthKit, and CareKit adapters.
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
cd perception-engine/backend && npm run build && npm run typecheck && npm test
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

## Standing rules

The standing rules are in
`../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`, which is
authoritative. They are not listed or summarised here, so this file never
falls behind the contract. Read it before changing anything here.
