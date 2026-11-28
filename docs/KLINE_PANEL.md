# The K-line panel

RealityEngine_Manager#372, for release-v0.0.3. The operator surface for K-line
dynamic analysis (RealityEngine_CI#603; SURFACE_SPEC "K-lines and runtime
snapshots"). It is the third top-level view, **K-lines**, beside Machines and
Perception.

## What it does

| section | what | through |
|---|---|---|
| Capture | both halves on or off, per instance or for the universe, read back from each engine; the universe's boot setting shown beside | RE `PUT /api/engine/config/klineCapture`, PE `PATCH /api/config {isreCapture}` |
| Knobs | `klineFeedbackHops` [0, 16], `klineStoreMaxBytes`, `isreStoreMaxBytes`, each settable and restorable to its declared default | the same control APIs (`DELETE` restores an RE default) |
| Analysis | histograms over the live store or the archive, for a commit range: outcomes, path lengths, near-misses (abandoned, by \|value − threshold\| at the failing element), K-lines closed per step, ISRE cells won by kind/provider/class | `GET /api/klines`, `GET /api/isre-composition`, or the archive |
| Archive | export each instance's new records into the archive, and its catalog | `POST /api/klines/export`, `POST /api/isre-composition/export` |
| Schedules | capture windows and re-runs | Manager's backend |

**K-lines are off at boot** unless the universe was started with
`startUniverse.sh --kline-capture` (or an install with `RE_KLINE_CAPTURE=on`).
Turning capture on starts afresh, so the K-lines each engine checkpointed close
`interrupted/shutdown`; the panel asks before it does that.

**Voters side by side, no reference.** The voters' analyses are shown as small
multiples on a shared scale, and the panel states which summaries agree across
all of them. A voter that did not answer is named, and nothing is called
agreement. Followers (Rust, Go, and any instance with `role: follower`) are
shown below, not compared. A half an engine does not serve is `unsupported`,
never `off`.

## Decisions (owner, 2026-11-27)

- **Schedules live in Manager's backend** and survive a restart:
  `$KLINE_PANEL_STATE`, default
  `$RE_INSTANCE_STATE_DIR/manager/kline-panel.json`
  (`~/.reality-engine/manager/kline-panel.json`).
- **A re-run recomputes over records, and never drives an engine.** That makes it
  safe on a deployment with live inputs. It covers a capture window's commit
  range or each target's latest N commits, from the live store or the archive.
- **Manager writes the archive itself,** to the contract of RealityEngine_CI
  `scripts/lib/kline_archive.py` (SURFACE_SPEC "The historical archive"): the
  same root, layout, file names and catalog lines. Either writer continues where
  the other stopped. The participant is read from its clock route, never from
  an export.

## Schedules

- **Capture window:** starts at a time, or once the first target's RE commit
  reaches `startCommit`. It stops after `durationMs` or after `steps` commits,
  whichever comes first. It can repeat every `repeatEveryMs`, and archive when
  it closes. Each window records every target's RE commit at its start and end.
- **Re-run:** `{captureId}` (that window's commit ranges) or `{lastCommits: n}`,
  from `store` or `archive`, once or every `everyMs`. The last 20 results are
  kept.
- **Deleting an open window** turns capture off first, so a schedule never
  leaves capture on.

## Routes (Visualizer backend)

```
GET    /api/kline-panel                      every instance's two halves, the boot setting, the knobs' ranges
POST   /api/kline-panel/capture              {on, instances?}
PUT    /api/kline-panel/knobs/:id/:knob      {value}        DELETE restores the declared default
GET    /api/kline-panel/analysis?source=store|archive&from=&to=&instance=
POST   /api/kline-panel/archive              {instances?}   GET: the catalog
GET    /api/kline-panel/schedules            POST adds; DELETE /:id; POST /:id/run
```

## Code

- `visualizer/backend/src/klines/`:
  - `panel.ts`: both halves, read and written through the engines' controls;
  - `analysis.ts`: pure histograms;
  - `archive.ts`: the archive contract;
  - `scheduler.ts`: windows and re-runs;
  - `http.ts`: the routes.

  Tests: `src/__tests__/klinePanel.test.ts`.
- `visualizer/frontend/src/klines/`: `KlinePanelView.tsx`, `Histogram.tsx`
  (single hue, blue 400, validated on `--re-bg-3`), and `klineApi.ts`. Tests:
  `src/klines/__tests__/`.
