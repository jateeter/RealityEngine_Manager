# Manager TypeScript PE Backend Guidance

This package is the TypeScript Perception Engine implementation.

It is a **non-voting conformance follower** (owner, 2026-11-06;
`RealityEngine_CI/docs/QUORUM_CONTRACT.md`), like RealityEngine_Rust: it implements the PE surface
and is measured against what C++, LSP and Scala agree on, and it never votes. This repo has no
TypeScript RE.

- `src/server.ts`: HTTP entrypoint.
- `src/PerceptionEngine.ts`: PE assembly behavior.
- `src/SourceStore.ts`: source persistence/state.
- `src/integrations/`: adapter registry, source mapping, ACP/OpenClaw, OpenAI, Ollama, HealthKit, and CareKit adapters.
- `src/dispatch/`: ledger-backed dispatch records.
- `src/triggers/`: trigger dispatch and envelope construction.
- `src/MqttBridge.ts`, `src/MqttMapping.ts`: MQTT integration.
- `src/mcp.ts`, `src/mcpPolicy.ts`: MCP support.

Keep `INTEGRATIONS_CONFIG` and ACP environment defaults aligned with the root application map. Run `npm run build` and relevant `npm test` coverage for backend behavior changes.

Toolchain: Node 26, TypeScript 7 (native `tsc`, no JS compiler API). Tests run on vitest (`npm test`), and `npm run dev` runs on tsx; neither depends on the `typescript` package, which is why ts-jest and ts-node were removed. Vitest strips types without checking them, so `npm run typecheck` checks both `tsconfig.json` and `tsconfig.test.json` — run it alongside `npm test`.

HealthKit ingest follows the canonical contract in `localHealthkitBridge/docs/INGEST_CONTRACT.md`: auth accepts body `bridgeToken` OR `Authorization: Bearer`. The contract checks both against `HEALTHKIT_BRIDGE_TOKEN`; this PE also accepts a per-bridge `apiKey` on the matching `kind:"healthkit"` entry in `INTEGRATIONS_CONFIG`, which takes precedence over the token (`integrations/adapters/HealthKitBridge.ts`). That override is Manager-only and not in the canonical contract; unknown bridgeIds are not a 404; samples carry pre-normalized `values[]` (scalar `value` is the legacy server-normalized path); responses expose `resolved[]`/`unmapped[]` with 200/207/400/401 parity across engines. The vector defaults to 7680 (`VECTOR_SIZE` or native-parity `VECTOR_DIMENSION` env) and grows on demand up to `MAX_VECTOR_SIZE` (default 1048576) when a source region requires it, matching the Scala PE — regions beyond the cap are rejected, not silently skipped.

## Ollama `format` (structured output) — three-engine parity

Whether a native Ollama dispatch sends `format` depends on the model: Ollama
refuses it for some (`nemotron-3-nano` → `structured output is unavailable`).
The C++, LSP and Scala PEs and the Manager TypeScript PE must send or omit it
**identically** for every model — a divergence reads as an engine defect in the
parity sweep. The rule and the model list are canonical in
`RealityEngine_CI/docs/OLLAMA_INTEGRATION.md` § "Structured output"; here it is
`ollamaSupportsStructuredOutput` (`OllamaAdapter.ts`) with the `formatJson` config switch. When `format` is omitted the adapter instead
puts the mapping's required keys and an example shape in the system prompt
(`completionContractPrompt`, byte-identical text in all four) and, for these
models, sends `think: false`. A change to the list or the rule lands in all four
repos together.

## Standing rules

The standing rules are in
`../../../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`, which is
authoritative. They are not listed or summarised here, so this file never
falls behind the contract. Read it before changing anything here.
