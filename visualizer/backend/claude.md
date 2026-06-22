# Manager Visualizer Backend Guidance

This package is the Express backend for the Visualizer.

- It owns registry reads, active engine selection, RE/PE proxy routes, WebSocket bridge behavior, MQTT proxy endpoints, and audit logging.
- Keep route changes aligned with frontend API helpers in `visualizer/frontend/src/api.ts`.
- Prefer `RE_REGISTRY_URL` for multi-engine operation.
- Use TypeScript language server and run `npm run build` after backend changes.

