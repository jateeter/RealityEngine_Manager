# Manager Visualizer Backend Guidance

This package is the Express backend for the Visualizer.

- It owns instance registry reads, active engine selection, RE/PE proxy routes, WebSocket bridge behavior, MQTT proxy endpoints, and audit logging.
- Keep route changes aligned with frontend API helpers in `visualizer/frontend/src/api.ts`.
- Prefer `RE_REGISTRY_URL` for multi-engine operation.
- Use TypeScript language server and run `npm run build` after backend changes.

## Standing rules

The standing rules are in
`../../../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`, which is
authoritative. They are not listed or summarised here, so this file never
falls behind the contract. Read it before changing anything here.
