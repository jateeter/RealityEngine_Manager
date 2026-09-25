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

HealthKit ingest follows the canonical contract in `localHealthkitBridge/docs/INGEST_CONTRACT.md`: auth accepts body `bridgeToken` OR `Authorization: Bearer`. The contract checks both against `HEALTHKIT_BRIDGE_TOKEN`; this PE also accepts a per-bridge `apiKey` on the matching `kind:"healthkit"` entry in `INTEGRATIONS_CONFIG`, which takes precedence over the token (`integrations/adapters/HealthKitBridge.ts`). That override is Manager-only and not in the canonical contract; unknown bridgeIds are not a 404; samples carry pre-normalized `values[]` (scalar `value` is the legacy server-normalized path); responses expose `resolved[]`/`unmapped[]` with 200/207/400/401 parity across engines. The vector defaults to 7680 (`VECTOR_SIZE` or native-parity `VECTOR_DIMENSION` env) and grows on demand up to `MAX_VECTOR_SIZE` (default 1048576) when a source region requires it, matching the Scala PE — regions beyond the cap are rejected, not silently skipped.

## Standing rules — authoritative in `../../../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`

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
