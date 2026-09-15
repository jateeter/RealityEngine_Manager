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

## M4 — Gen2 intake: what the redesign actually admits ⏸ after M3

The Gen2 Control Center is not a reskin of the Visualizer. It takes integrated
sources as its input and shapes domains and machines from them, so two things
that the current UI never had to answer become load-bearing:

- **Units arriving from outside are not in the corpus's units.** An integrated
  source reports what its own instrument reports — °F from one thermostat, °C
  from another, a rate per hour where the machine reads per minute.
- **Domains and machines can arrive at runtime.** The universe is no longer
  fixed at boot, so admitting a new machine has to be a decision the system can
  make and justify, not a corpus edit followed by a restart.

Intake is therefore a transformation with a contract, not a passthrough. The
design assets in `docs/Gen2ManagerUI/` (`reality-engine-clean-spec-v4.md`,
`reality-engine-tab3-design-v2.md`) are the source for the UI side; this
milestone is the semantics beneath it.

---

## M5 — QUDT ⏸ after M4

QUDT is the vocabulary for both problems above. It is already present in the
corpus repo — `RealityEngine_Machines/semantics/ontology/qudt-subset.ttl`,
extracted and gated by `scripts/extract-qudt-subset.sh --check` from
`validate-corpus.sh`. The subset is deliberately small (`unit:DEG_C`, `unit:K`,
`unit:PER-MIN`, `unit:UNITLESS` and their quantity kinds); it grows as intake
needs it rather than by vendoring all of QUDT.

### M5.1 — Unit translation on the ingress transformation

Every integrated source declares the unit it reports in, as a QUDT unit IRI.
The transformation from source to perceptual-space cell converts to the unit the
target machine's lane declares, using QUDT's conversion multiplier and offset
rather than a table written by hand.

| Requirement | Why |
|---|---|
| A source without a declared unit is **rejected at registration**, not defaulted | A silent default is indistinguishable from a correct declaration once the value is in a cell, and the cell carries no unit |
| A conversion with no QUDT path between the two units is a **registration failure** | Refusing to admit the source is the only honest outcome; writing an unconverted number into a lane that means something else is worse than refusing |
| `UNITLESS` is declared explicitly, never inferred from absence | Distinguishes "this quantity has no unit" from "nobody said" |
| The declared unit travels into the audit record | Otherwise a wrong value cannot be attributed to a wrong conversion after the fact |

Exit criteria:

- A source declaring °F writes the °C value its target lane expects, and the
  audit record names both units.
- A source declaring an incompatible quantity kind is refused at registration
  with a message naming the two IRIs.
- The QUDT subset gate stays green with whatever units intake has added.

### M5.2 — Dynamic admission: shaping new domains and machines

When a domain or machine arrives at runtime, QUDT constrains what it may be
admitted as. The quantity kind a source reports decides which lanes it can drive
and which machines can legitimately consume it, so admission is checkable rather
than a matter of who wired it.

| Requirement | Why |
|---|---|
| A candidate machine declares each input lane's **quantity kind**, not just a width | A 4-cell region says nothing about whether a temperature belongs in it |
| Admission checks the candidate's lanes against the region allocation and refuses a **quantity-kind mismatch** on a shared lane | 68 output lanes are already shared; a mismatched writer corrupts every reader |
| A dynamically admitted machine produces the same ABox and manifest entry as an authored one | Otherwise runtime-admitted machines are invisible to every semantic gate — the exact gap M5 of the semantics roadmap closed for audit records |
| Admission is recorded with the reasoning, not only the outcome | "Why is this machine here" must be answerable later |

Exit criteria:

- A machine admitted at runtime appears in `semantics/abox-manifest.json` and
  resolves in `GET /api/audit/semantics` like an authored one.
- A candidate whose input quantity kind contradicts its target lane is refused,
  and the refusal names the conflicting IRIs.
- Region-allocation and arbitration gates pass over the corpus **including**
  runtime-admitted machines.

### Open question

Where the conversion runs — PE ingress, or the transformation layer between
source and PE — is not settled here. It affects whether the RE ever sees a
pre-conversion value, and therefore whether ISRE is expressed wholly in corpus
units. Decide it in M4 before building M5.1.

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
