# Workflow instantiation

Manager's workflow instantiation component (RealityEngine_Manager#323;
localAssetStorageStack ROADMAP phase 9). It runs every step of a document
workflow as a clone of a template machine, for the frames held by the
localAssetStorageStack lifecycle service.

The continuation rules are in RealityEngine_CI `docs/CONTINUATIONS_APPROVAL_CHAIN.md`
(authoritative). The clone routes are in `SURFACE_SPEC.md`, "Cloneable machines".

## What it does

It reads the lifecycle's open frames (`GET /frames?status=open`) every
`INSTANTIATION_POLL_MS`. For each frame waiting on the engine side, it runs one
step.

**Prologue.**
1. Probe-clone `next` on its engine instance (this finds a full pool before the
   one-shot resume).
2. Resume the frame's current continuation. The lifecycle checks the
   generation, the pin, and that the engine still carries the template; a
   failure takes the escape path.
3. Hand the clone to the lifecycle (`POST /frames/:id/clones`), which allocates
   the frame's lanes in the clone's reserved cells.
4. Dispatch the step's agent.

**Epilogue.**
1. Name the successor from the template machine's own `document-workflow-handoff`
   interconnections, choosing the one for the frame's asset type (owner,
   2026-11-09). The signal (the frame's lanes) and the continuation pass on to
   that next clone.
2. Recycle the clone with its generation, and free its lanes.
3. Then do one of three things:
   - capture the successor;
   - park it for a reviewer, if the agent asked for review;
   - if there is no successor, close the frame. Termination closes the workflow
     head.

A step a person resumed (a reviewer's approve) runs the same way. Its agent
capability comes from `POST /frames/:id/continuations/:k/capability`, which
issues it once.

- **A full pool** (`clone.maxActive`, or no free block) queues the step, first in
  first out. The pool is found before any one-shot resume or capability is spent.
- **A restart** picks up from the frames where they stand. The envelope is
  deterministic per frame and generation, so a retried clone is the same clone.

## The agent dispatch pattern (phase 8 follows it)

Agents run behind `AgentDriver` (`visualizer/backend/src/instantiation/agents.ts`).
The simulated agent sets the pattern that per-clone OpenClaw agents follow
(localOpenClawStack#91):

1. It is handed the assetID (the frame), the step's capability and scopes, and
   the clone it runs beside. Nothing else.
2. It reads its frame with the capability (`GET /frames/:id`).
3. It reads documents only through the lifecycle's `/pod` proxy. It writes one
   only with `pod:write`, under the pinned ETag.
4. It writes its result to the frame (`PUT /frames/:id/return`).
5. It answers whether the step needs an independent review. It never resumes,
   captures, approves or closes anything; those belong to the dispatcher and
   to people.

## Configuration

| Variable | |
|---|---|
| `INSTANTIATION_ENABLED` | `true` runs the component. The routes below are served either way. |
| `LIFECYCLE_URL` | The lifecycle service, for example `https://lifecycle:8443/`. |
| `LIFECYCLE_ENGINE_TOKEN`, `LIFECYCLE_ENGINE_TOKEN_FILE` | The lifecycle's `engine` service token. |
| `INSTANTIATION_POLL_MS` | Default 2000. |
| `INSTANTIATION_AGENT` | `simulated` (default). Phase 8 adds OpenClaw. |
| `RE_REGISTRY_URL` | The instance registry the engine instances come from. |

Every call is lane TLS: the backend's axios carries the lane's mTLS agent.

## Routes

| Route | |
|---|---|
| `GET /api/instantiation/status` | The queue, running and live clones, and step outcomes. |
| `GET /api/instantiation/metrics` | Prometheus lines (RealityEngine_CI#723). From each running engine instance's own `GET /api/engine/clones`, read at scrape time: `re_instantiation_live_clones{engine,template}`, `re_instantiation_pool_use{engine}` (of the 1024 blocks), `re_instantiation_band_read{engine}`. A clone made through the clone route outside a workflow step counts too. From the component, when enabled: `re_instantiation_queue_depth`, `re_instantiation_step_clones{engine,template}`, `re_instantiation_steps_total{outcome}`. |
| `GET /api/engine/:id/clones` | Passed through to the named engine instance, resolved from the instance registry. |
| `POST /api/engine/:id/clone/machine/:machineId?asset=&envelope=` | As above. |
| `POST /api/engine/:id/recycle/machine/:cloneId?generation=` | As above. |
