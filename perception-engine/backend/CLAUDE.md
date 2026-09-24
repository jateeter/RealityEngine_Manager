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

## Standing rules — authoritative in `../../../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`

These apply here and are **not** restated in this file. They were previously
copied into eighteen `CLAUDE.md` files across six repositories, which is the
duplication problem the rules themselves warn about: copies drift, a rule added
to one applies only where someone looked, and with no authority a reader cannot
tell which copy is current.

| Rule | In short |
| --- | --- |
| Qualify every "registry" | Never the bare word — instance / machine / cesgen / arbitration / domain / semantic-bus / tag. |
| Verify a merge beyond the hosted checks | A green PR is not a verified PR; the hosted path cannot reach the integration points. Name what you could not exercise, and record what you noticed but did not chase. |
| Never commit to main | Branch from `origin/main`, PR, verify, squash-merge, clean up. |
| _CI is the authority | Peripheral repos keep minimal CI that forces local validation; RealityEngine_CI verifies fixes against a live universe. Check its `docs/` before adding CI anywhere else. |
| Use bash, not zsh | Shell work runs in `/opt/homebrew/bin/bash` (5.x), not zsh or macOS `/bin/bash` 3.2: any loop, unquoted variable, glob or `set --` goes through it with `set -euo pipefail`, and you check the command's exit status, not the pipeline tail. |

Read the contract for the full text, the qualifier table, and the cleanup steps.
