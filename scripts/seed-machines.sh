#!/usr/bin/env bash
# ============================================================
# seed-machines.sh — Seeds example machines into the RE runtime
#
# Replicates RealityEngine_AI's initializeDefaultSequences():
# scans examples/machines/*.json and POSTs each via
# POST /api/machines/json/import {"json": "<file-content>"}
#
# Skips if >= SKIP_THRESHOLD machines already exist in the runtime.
#
# Usage:
#   scripts/seed-machines.sh [re-url] [examples-dir]
#
# Arguments:
#   re-url        RE runtime URL  (default: https://localhost:5001)
#   examples-dir  Path to examples/machines directory (auto-discovered if omitted)
# ============================================================

set -uo pipefail

RE_URL="${1:-https://localhost:5001}"
EXAMPLES_DIR="${2:-}"
CONCURRENCY=8
SKIP_THRESHOLD=50

# ── Auto-discover examples/machines directory ────────────────
if [[ -z "$EXAMPLES_DIR" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for candidate in \
      "$SCRIPT_DIR/../../RealityEngine_Machines/machines" \
      "$SCRIPT_DIR/../../../RealityEngine_Machines/machines"; do
    if [[ -d "$candidate" ]]; then
      EXAMPLES_DIR="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi

if [[ -z "$EXAMPLES_DIR" || ! -d "$EXAMPLES_DIR" ]]; then
  echo "  [seed] Examples directory not found — skipping machine seeding."
  echo "  [seed] Tip: pass the directory as the second argument."
  exit 0
fi

echo "  [seed] Examples: $EXAMPLES_DIR"

# ── Skip if machines are already loaded ──────────────────────
MACHINE_COUNT=0
TMPCOUNT=$(mktemp)
if curl -skf "$RE_URL/api/machines" -o "$TMPCOUNT" 2>/dev/null; then
  MACHINE_COUNT=$(TMPFILE="$TMPCOUNT" python3 -c "
import json, os
try:
    with open(os.environ['TMPFILE']) as f:
        d = json.load(f)
    print(len(d) if isinstance(d, list) else int(d.get('total', 0)))
except Exception:
    print(0)
" 2>/dev/null || echo "0")
fi
rm -f "$TMPCOUNT"

if [[ "$MACHINE_COUNT" -ge "$SKIP_THRESHOLD" ]]; then
  echo "  [seed] RE already has $MACHINE_COUNT machines — skipping seeding."
  exit 0
fi

echo "  [seed] RE has $MACHINE_COUNT machines — seeding examples now."

# ── Collect and sort JSON files ───────────────────────────────
FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && FILES+=("$f")
done < <(find "$EXAMPLES_DIR" -maxdepth 1 -name '*.json' | sort)

TOTAL=${#FILES[@]}

if [[ $TOTAL -eq 0 ]]; then
  echo "  [seed] No JSON files found in $EXAMPLES_DIR — skipping."
  exit 0
fi

echo "  [seed] Importing $TOTAL machines (concurrency=$CONCURRENCY)..."

# ── Per-file import helper ────────────────────────────────────
import_one() {
  local file="$1"
  local re_url="$2"
  local payload

  payload=$(python3 -c "
import json, sys
content = open(sys.argv[1]).read()
print(json.dumps({'json': content}))
" "$file" 2>/dev/null) || return 1

  curl -skf -X POST "$re_url/api/machines/json/import" \
    -H "Content-Type: application/json" \
    -d "$payload" -o /dev/null 2>&1
}

# ── Parallel import with throttled concurrency ────────────────
RESULTS_DIR=$(mktemp -d)
ACTIVE_PIDS=()
PROGRESS=0

for file in "${FILES[@]}"; do
  result_file="$RESULTS_DIR/$(basename "$file").result"
  (
    if import_one "$file" "$RE_URL"; then
      echo "ok" > "$result_file"
    else
      echo "fail" > "$result_file"
    fi
  ) &

  ACTIVE_PIDS+=($!)

  if [[ ${#ACTIVE_PIDS[@]} -ge $CONCURRENCY ]]; then
    wait "${ACTIVE_PIDS[0]}"
    ACTIVE_PIDS=("${ACTIVE_PIDS[@]:1}")
    PROGRESS=$((PROGRESS + 1))
    if (( PROGRESS % 100 == 0 )); then
      echo "  [seed] Progress: $PROGRESS / $TOTAL"
    fi
  fi
done

wait

# ── Tally results ─────────────────────────────────────────────
LOADED=0
FAILED=0
while IFS= read -r result; do
  [[ -f "$result" ]] || continue
  content=$(cat "$result")
  if [[ "$content" == "ok" ]]; then
    LOADED=$((LOADED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done < <(find "$RESULTS_DIR" -name '*.result')

rm -rf "$RESULTS_DIR"

echo "  [seed] Done: $LOADED loaded, $FAILED failed (of $TOTAL)"

if [[ $LOADED -eq 0 && $TOTAL -gt 0 ]]; then
  echo "  [seed] Warning: no machines imported. Is the RE runtime running at $RE_URL?"
  exit 1
fi
exit 0
