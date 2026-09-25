# RealityEngine_Manager Guidance

Last reviewed: 2026-09-25

See `/Users/johnt/workspace/GitHub/CLAUDE.md` for the integrated application map. Update both this file and the root map when Manager ownership of runtime surfaces, PE behavior, or integration paths changes.

## Role

This repo contains the user-facing Manager application and the TypeScript Perception Engine implementation.

## Codebase Map

- `visualizer/backend/src/`: Express backend, instance registry client, runtime proxying, audit logging, WebSocket bridge, and MQTT proxy endpoints.
- `visualizer/backend/src/corpus.ts`: machine-corpus catalog (`GET /api/corpus/tree`) and domain-scoped load orchestration (`POST /api/corpus/load`) for the Load Machines modal; `MACHINES_DIR` env selects the corpus root. Backend unit tests run with `npm test` (vitest).
- `visualizer/frontend/src/`: React/Vite Visualizer, engine switcher, graph views, MQTT controls, machine views, and PE Manager UI.
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

## Standing rules — authoritative in `../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`

These apply here and are **not** restated in this file. The table is an index
to the contract, not a copy of it: it names every rule so you know what to look
up, and the contract's wording governs wherever the two differ.

| Rule | In short |
| --- | --- |
| Qualify every "registry" | Never the bare word — instance / machine / cesgen / arbitration / domain / semantic-bus / tag. |
| Regenerate a stale `<name>` registry, don't fail it | Each `<name>` registry is a view of the running system. A gate regenerates it and fails only on a disagreement that survives regeneration. |
| Verify a merge beyond the hosted checks | A green PR is not a verified PR; the hosted path cannot reach the integration points. Name what you could not exercise, and record what you noticed but did not chase. |
| _CI is the authority | Peripheral repos keep minimal CI that forces local validation; RealityEngine_CI verifies fixes against a live universe. Check its `docs/` before adding CI anywhere else. |
| Name it `CLAUDE.md` | Uppercase, always. On a case-insensitive filesystem `claude.md` is the same inode; dedupe on `st_ino`, never on a resolved path. |
| Never commit to main | Branch from `origin/main`, PR, verify, squash-merge, clean up. |
| Use bash, not zsh | Shell work runs in `/opt/homebrew/bin/bash` (5.x), not zsh or macOS `/bin/bash` 3.2: any loop, unquoted variable, glob or `set --` goes through it with `set -euo pipefail`, and you check the command's exit status, not the pipeline tail. |

Read the contract for the full text, the qualifier table, and the cleanup steps.
