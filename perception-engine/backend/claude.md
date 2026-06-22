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

