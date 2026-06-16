# OpenAPI Contracts — RealityEngine (Manager copy)

Six OpenAPI 3.1.0 documents describe the RE and PE HTTP surfaces for each
runtime. The Manager uses these specs to describe the runtime APIs it proxies
and to drive client code generation for the visualizer backend.

All six are **generated** — do not edit them by hand.

## Files

| File | Runtime | Service | Default port |
|---|---|---|---|
| [`cpp-re.yaml`](cpp-re.yaml) | CPP (C++ / Boost.Beast) | Reality Engine | `5301` |
| [`cpp-pe.yaml`](cpp-pe.yaml) | CPP (C++ / Boost.Beast) | Perception Engine | `5300` |
| [`lsp-re.yaml`](lsp-re.yaml) | LSP (SBCL / Hunchentoot) | Reality Engine | `5601` |
| [`lsp-pe.yaml`](lsp-pe.yaml) | LSP (SBCL / Hunchentoot) | Perception Engine | `5600` |
| [`scala-re.yaml`](scala-re.yaml) | Scala (Akka-HTTP) | Reality Engine | `5001` |
| [`scala-pe.yaml`](scala-pe.yaml) | Scala (Akka-HTTP) | Perception Engine | `5000` |

## Regenerate

```bash
# From RealityEngine_CI root:
bash scripts/generate-openapi.sh --propagate
```

`--propagate` copies the freshly generated YAML into this directory and into
each runtime repo's `docs/openapi/`. Requires Python 3 + `pyyaml`.

## Source

| Source | Role |
|---|---|
| `RealityEngine_CPP/SURFACE_SPEC.md` | Canonical route authority |
| `RealityEngine_CI/scripts/openapi/overlays/{cpp,lsp,scala}.yaml` | Runtime overlays |
| `RealityEngine_CI/scripts/openapi/generate.py` | Generator |

## Quick view

```bash
npx @redocly/cli preview-docs docs/openapi/cpp-re.yaml
```
