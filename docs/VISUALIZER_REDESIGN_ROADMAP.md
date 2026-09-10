# Visualizer Redesign — Test Alignment Roadmap

Last reviewed: 2026-09-10 · Status: **M1 delivered, M2–M3 waiting on the redesign**

Owner-supplied design assets go in [Design Assets](#design-assets); that section
is deliberately empty and is not a placeholder for generated content.

## What this roadmap is for

A full Visualizer redesign is coming. This file exists so the e2e suite arrives
on the other side of it intact, rather than being rewritten twice — once against
markup that is about to be replaced, and again against what replaces it.

The organising principle, and the reason M1 ran before the redesign rather than
after:

> **A test bound to markup dies with the markup. A test bound to a contract
> outlives it.**

Three anchors, in descending order of survival:

| Anchor | Survives a redesign? | Example |
|---|---|---|
| An engine/API contract | yes, entirely | tree domains derived from `GET /api/machines` |
| `data-testid` | yes if preserved — and it fails *loudly* if not | `getByTestId('graph-filter-chip')` |
| A CSS class | **no**, and it fails *ambiguously* | `locator('.vis-filter-chip')` |

The failure mode being avoided is not "a test breaks". It is a test breaking
into *"is the new UI wrong, or is the old test stale?"* — the expensive question
to be answering in the middle of a rewrite.

---

## M1 — Testid anchors ✅ 2026-09-10

Delivered in RealityEngine_Manager#116, **before** the redesign, because a
testid added now is one the redesign is asked to preserve.

- 12 `data-testid` attributes across 6 components, alongside existing
  `className`s so nothing visual changed.
- 6 specs migrated onto them — 28 locators.
- `tsc --noEmit` clean, `npm run build` green.

```
re-title · tree-search-clear · toolbar-stats · tree-row-domain
graph-filter-chip · graph-filters-reset
load-machines-row · load-machines-count
settings-dialog · graph-legend-tab · ces-legend-tab · machine-graph
```

**Unverified at runtime.** The Manager e2e suite currently fails before reaching
any assertion — see [Blockers](#blockers) — so the migrated locators are
compile-verified only. A wrong locator surfaces when the suite first runs green,
not before. Stated rather than glossed: a green build is not a passing test.

### Also delivered (#91)

`output-stream.spec.ts` re-anchored on contracts rather than deployment shape:

- Engine-switcher tests no longer require the active runtime to be `scala`. They
  assert it is one the registry actually holds, and that selecting the first
  listed instance navigates. The switcher's contract is identical in every
  universe; requiring `scala` tested which universe was deployed.
- Tree tests derive their expectation from the active engine
  (`GET /api/machines`) rather than asserting "at least one domain", which
  passed against a universe missing most of its corpus.

Those already sit in the top row of the anchor table and need nothing from M2
or M3.

---

## M2 — Rewrite the DOM-coupled specs ⏸ waits on the redesign

Two specs hold **41 of the ~59 original class couplings**:

| Spec | tests | class selectors |
|---|---:|---:|
| `graph-filters.spec.ts` | 11 | 22 |
| `load-machines-modal.spec.ts` | 4 | 19 |

Deferred on purpose: rewriting them against today's DOM buys tests the redesign
discards.

### Entry criteria

- The redesign's component structure is settled enough that testids are stable.
- [Blockers](#blockers) cleared, so a rewritten spec can be *seen* to pass.

### Work

1. **Coverage audit first, as its own artifact.** Record what
   `RealityEngine_CI/VISUALIZER_USER_GUIDE.md` claims and which of it is
   untested. Its sections: Overview, Views, Sequences Panel, Perception Engine
   UI, Keyboard Shortcuts, WebSocket Updates. The audit survives the redesign
   even if every test is rewritten, and it is what says whether the new suite
   covers *more* than the old one or merely differently.
2. Rewrite both specs against testids and against what the guide says the UI
   does — not against what the DOM currently happens to be.
3. Disambiguate the two selectors M1 could not:
   - **`.vis-legend-tab`** — rendered by both `MachineGraphView` and
     `CriticalEventGraphView`. Four tests use it; the selector cannot say which
     is meant. Testids `graph-legend-tab` and `ces-legend-tab` already exist,
     unused, waiting for the specs to declare intent.
   - **`.rep-row`** — a shared row class, three tests, same problem.
4. Retire remaining class selectors, or record why each survivor is legitimate.

### Exit criteria

- Zero `locator('.class')` in the rewritten specs.
- Every guide section either covered or listed as knowingly uncovered.

---

## M3 — Contract-anchored coverage ⏸ after M2

Move what can be moved from the middle row of the anchor table to the top:
assertions derived from the engine and from `SURFACE_SPEC.md`, not from the DOM.

`pe-api-equivalence.spec.ts` (0 selectors) and the reworked tree tests are the
model. `theme-settings.spec.ts` (12 tests, semantic locators only) needs
nothing.

Candidates:

- Machine/CES counts, domain membership, engine identity — derivable from
  `GET /api/machines` and the instance registry rather than read off the page.
- PE surfaces — assert against the PE contract, with the UI as transport.
- WebSocket update behaviour — documented in the guide, tested nowhere.

### Exit criteria

- Every assertion that *can* be contract-derived is.
- Markup dependence limited to genuinely visual behaviour — layout, theming,
  interaction affordances — the only place a DOM assertion is the right tool.

---

## Blockers

| Blocker | Effect | Status |
|---|---|---|
| Manager e2e fails on the `:5173` → HTTPS redirect | Suite never reaches an assertion, so M1's migration is unproven and M2 cannot be validated | **open, unfiled** |

The frontend e2e navigates to `http://localhost:5173` per its `baseURL`; both
`:5173` and `:3001` answer `302` to `https://`. Nothing downstream of page load
is tested today — including tests reporting failures for reasons unrelated to
their subject.

---

## Design Assets

*Owner-supplied. Mockups, component inventories, interaction specs, and whatever
else the redesign produces.*

Two things worth recording here as they arrive, because M2 and M3 depend on them
and on nothing else:

- **Which components survive**, and under what names — the testid stability
  question, which decides when M2 can start.
- **What the redesign changes about documented behaviour**, so
  `VISUALIZER_USER_GUIDE.md` and this suite move together rather than the guide
  becoming a description of the previous UI.

---

## Maintenance

State what is delivered and what is waiting, with dates. If a milestone is
finished, mark it and say what verified it; if superseded, say so rather than
deleting it. A roadmap that describes a closed state as open sends a reader to
build something that already exists — the failure this workspace has hit
repeatedly, most recently `MULTI-ENGINE-ROADMAP.md`, which listed eight
delivered phases as pending for three months.
