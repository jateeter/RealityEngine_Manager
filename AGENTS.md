# Codex Guidance: RealityEngine_Manager

Read `claude.md` for the current codebase map and integration context.

## Role

This repo contains the Manager UI/backend, Visualizer, and TypeScript Perception Engine implementation.

## Development Rules

- Keep active RE and PE endpoint selection aligned across backend proxy routes and frontend state.
- Treat `perception-engine/backend/src/integrations`, `src/dispatch`, and `src/triggers` as contract code.
- Keep frontend API helpers aligned with backend route changes.
- Use `RE_REGISTRY_URL` for multi-engine behavior and explicit rate-limit env vars for e2e-scale runs.

## Bug Triage

- For UI failures, inspect the proxied backend response before changing frontend assertions.
- For PE source failures, verify source store state, dispatch ledger records, adapter mapping, and assembled vector separately.
- For rate-limit symptoms, check `VIZ_RATE_LIMIT_MAX` and `VIZ_MACHINES_RATE_LIMIT_MAX`.
- For OpenClaw issues, validate gateway health, adapter response, ledger write, and PE source activation in that order.

## Verification

Common commands:

```bash
cd visualizer/backend && npm run build
cd visualizer/frontend && npm run build
cd visualizer/frontend && npm run test:e2e -- --project=chromium --workers=1
cd perception-engine/backend && npm run build && npm test
cd perception-engine/frontend && npm run build
```

## Artifact Hygiene

`visualizer/frontend/playwright-report/` and `visualizer/frontend/test-results/` are generated artifacts. Do not stage them unless the user explicitly requests it. If they are already staged for another task, use explicit commit pathspecs for unrelated commits.

