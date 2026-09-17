# Manager TypeScript PE Backend Guidance

This package is the TypeScript Perception Engine implementation.

- `src/server.ts`: HTTP entrypoint.
- `src/PerceptionEngine.ts`: PE assembly behavior.
- `src/SourceStore.ts`: source persistence/state.
- `src/integrations/`: adapter registry, source mapping, ACP/OpenClaw, OpenAI, Ollama, HealthKit, and CareKit adapters.
- `src/dispatch/`: ledger-backed dispatch records.
- `src/triggers/`: trigger dispatch and envelope construction.
- `src/MqttBridge.ts`, `src/MqttMapping.ts`: MQTT integration.
- `src/mcp.ts`, `src/mcpPolicy.ts`: MCP support.

Keep `INTEGRATIONS_CONFIG` and ACP environment defaults aligned with the root application map. Run `npm run build` and relevant `npm test` coverage for backend behavior changes.

HealthKit ingest follows the canonical contract in `localHealthkitBridge/docs/INGEST_CONTRACT.md`: auth accepts body `bridgeToken` OR `Authorization: Bearer` against the registry per-bridge `apiKey` (falls back to `HEALTHKIT_BRIDGE_TOKEN`); unknown bridgeIds are not a 404; samples carry pre-normalized `values[]` (scalar `value` is the legacy server-normalized path); responses expose `resolved[]`/`unmapped[]` with 200/207/400/401 parity across engines. The vector defaults to 7680 (`VECTOR_SIZE` or native-parity `VECTOR_DIMENSION` env) and grows on demand up to `MAX_VECTOR_SIZE` (default 1048576) when a source region requires it, matching the Scala PE — regions beyond the cap are rejected, not silently skipped.

