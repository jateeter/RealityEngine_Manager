#!/usr/bin/env bash
# ============================================================
# Reality Engine Manager — start
#
# Starts the visualizer backend (Node/Express) and frontend
# (Vite dev server). Connects to an external RE and PE runtime.
#
# Usage:
#   ./start.sh [options]
#
# Options:
#   --re <url>     RE runtime URL  (default: https://localhost:5001)
#   --pe <url>     PE runtime URL  (default: https://localhost:3004)
#   --scala        Preset for Scala runtime  (RE :5001, PE :5000)
#   --cpp          Preset for CPP runtime    (RE :5301, PE :5300)
#   --lsp          Preset for LSP runtime    (RE :5601, PE :5600)
#   --port <n>     Visualizer backend port   (default: 3001)
#   --no-frontend  Skip starting the Vite dev server
#
# Runtime defaults per SURFACE_SPEC.md:
#   Docker Scala RE :5001  PE :3004  (nginx proxied from reality-engine:3000)
#   Native Scala   RE :5001  PE :5000
#   Native CPP     RE :5301  PE :5300
#   Native LSP     RE :5601  PE :5600
#   Grafana (Docker): https://localhost:3000
# ============================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/visualizer/backend"
FRONTEND_DIR="$ROOT_DIR/visualizer/frontend"
PID_FILE="$ROOT_DIR/.manager-pids"
LOG_DIR="$ROOT_DIR/.manager-logs"

# ── Defaults ────────────────────────────────────────────────
RE_RUNTIME_URL="https://localhost:5001"
PE_RUNTIME_URL="https://localhost:3004"
VIZ_PORT=3001
START_FRONTEND=1
SEED_MACHINES=1

# ── Parse flags ─────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --re)           RE_RUNTIME_URL="$2"; shift 2 ;;
    --pe)           PE_RUNTIME_URL="$2"; shift 2 ;;
    --scala)        RE_RUNTIME_URL="http://localhost:5001"; PE_RUNTIME_URL="http://localhost:5000"; shift ;;
    --cpp)          RE_RUNTIME_URL="http://localhost:5301"; PE_RUNTIME_URL="http://localhost:5300"; shift ;;
    --lsp)          RE_RUNTIME_URL="http://localhost:5601"; PE_RUNTIME_URL="http://localhost:5600"; shift ;;
    --port)         VIZ_PORT="$2"; shift 2 ;;
    --no-frontend)  START_FRONTEND=0; shift ;;
    --no-seed)      SEED_MACHINES=0; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,2\}//' | head -30
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Pin Node 25.5.0 via nvm ──────────────────────────────────
# nvm is a shell function; it modifies PATH only in the current
# shell. We capture absolute paths to node/npm after activation
# and export them so every subshell and background process uses
# exactly the same binary — regardless of how their env is set up.

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
fi

if ! nvm use 25.5.0 > /dev/null 2>&1; then
  echo "Error: Node 25.5.0 not found in nvm. Run: nvm install 25.5.0" >&2
  exit 1
fi

# Resolve absolute paths once — used explicitly in every subshell below
NODE="$(command -v node)"
NPM="$(command -v npm)"

# Prepend the resolved bin dir so child processes also resolve correctly
export PATH="$(dirname "$NODE"):$PATH"

NODE_VERSION=$("$NODE" --version)
echo "────────────────────────────────────────────────────────"
echo "  Reality Engine Manager"
echo "────────────────────────────────────────────────────────"
echo "  Node:     $NODE_VERSION"
echo "  RE:       $RE_RUNTIME_URL"
echo "  PE:       $PE_RUNTIME_URL"
echo "  Backend:  http://localhost:$VIZ_PORT"
[[ $START_FRONTEND -eq 1 ]] && echo "  Frontend: http://localhost:5173"
echo "────────────────────────────────────────────────────────"

# ── Guard — abort if already running ────────────────────────
if [[ -f "$PID_FILE" ]]; then
  echo ""
  echo "Warning: .manager-pids exists. Manager may already be running."
  echo "Run ./stop.sh first, or remove .manager-pids manually."
  exit 1
fi

mkdir -p "$LOG_DIR"
: > "$PID_FILE"

# ── Install / refresh dependencies ───────────────────────────
# node_modules may have been built with a different Node version.
# Re-running npm install ensures all native wrappers (ts-node, etc.)
# are compiled/linked against the active Node binary.

echo ""
echo "Installing backend dependencies..."
(cd "$BACKEND_DIR" && "$NPM" install --prefer-offline 2>&1 | tail -3)

if [[ $START_FRONTEND -eq 1 ]]; then
  echo "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && "$NPM" install --prefer-offline 2>&1 | tail -3)

  # npm 10 on macOS generates flat wrapper scripts for ESM bin entries instead
  # of symlinks. Vite 5.x uses a relative import('../dist/node/cli.js') in its
  # bin script — that path only resolves correctly when the file lives at
  # node_modules/vite/bin/vite.js, not at the flat copy in node_modules/.bin/.
  # Recreate it as a proper symlink so the relative import resolves.
  VITE_SHIM="$FRONTEND_DIR/node_modules/.bin/vite"
  VITE_BIN="$FRONTEND_DIR/node_modules/vite/bin/vite.js"
  if [[ -f "$VITE_SHIM" && ! -L "$VITE_SHIM" && -f "$VITE_BIN" ]]; then
    echo "  Fixing Vite bin shim (npm flat-wrapper -> symlink)..."
    rm -f "$VITE_SHIM"
    ln -sf "../vite/bin/vite.js" "$VITE_SHIM"
  fi
fi

# ── Start backend ────────────────────────────────────────────
echo ""
echo "Starting backend..."

(
  cd "$BACKEND_DIR"
  RE_RUNTIME_URL="$RE_RUNTIME_URL" \
  PE_RUNTIME_URL="$PE_RUNTIME_URL" \
  REALITY_ENGINE_URL="$RE_RUNTIME_URL" \
  PERCEPTION_ENGINE_URL="$PE_RUNTIME_URL" \
  VIZ_PORT="$VIZ_PORT" \
    "$NPM" run dev >> "$LOG_DIR/backend.log" 2>&1 &
  echo $!
) >> "$PID_FILE"

echo "  npm PID: $(tail -1 "$PID_FILE")  log: $LOG_DIR/backend.log"

# ── Wait for backend to be ready (max 15 s) ─────────────────
BACKEND_READY=0
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$VIZ_PORT/health" > /dev/null 2>&1; then
    BACKEND_READY=1
    break
  fi
  sleep 0.5
done

if [[ $BACKEND_READY -eq 0 ]]; then
  echo ""
  echo "  Backend did not become healthy within 15 s."
  echo "  Check $LOG_DIR/backend.log for details."
else
  # Replace npm wrapper PID with the actual listening process PID
  ACTUAL_BACKEND_PID=$(lsof -ti tcp:"$VIZ_PORT" 2>/dev/null | head -1 || true)
  if [[ -n "$ACTUAL_BACKEND_PID" ]]; then
    # Rewrite PID file with the real PID
    echo "$ACTUAL_BACKEND_PID" > "$PID_FILE"
  fi
  echo "  Backend healthy (PID ${ACTUAL_BACKEND_PID:-unknown}) ✓"

  # ── Seed example machines ──────────────────────────────────
  if [[ $SEED_MACHINES -eq 1 ]]; then
    echo ""
    echo "Seeding example machines..."
    if bash "$ROOT_DIR/scripts/seed-machines.sh" "$RE_RUNTIME_URL"; then
      echo "  Seeding complete."
    else
      echo "  Seeding finished with warnings — Manager will continue."
    fi
  fi
fi

# ── Start frontend ───────────────────────────────────────────
if [[ $START_FRONTEND -eq 1 ]]; then
  echo ""
  echo "Starting frontend..."
  (
    cd "$FRONTEND_DIR"
    "$NPM" run dev >> "$LOG_DIR/frontend.log" 2>&1 &
    echo $!
  ) >> "$PID_FILE"

  # Give Vite a moment to bind, then record the actual listener PID
  sleep 2
  ACTUAL_FRONTEND_PID=$(lsof -ti tcp:5173 2>/dev/null | head -1 || true)
  if [[ -n "$ACTUAL_FRONTEND_PID" ]]; then
    # Replace last line with the real PID
    head -1 "$PID_FILE" > "$PID_FILE.tmp" && mv "$PID_FILE.tmp" "$PID_FILE"
    echo "$ACTUAL_FRONTEND_PID" >> "$PID_FILE"
  fi
  echo "  Frontend running (PID ${ACTUAL_FRONTEND_PID:-unknown})  log: $LOG_DIR/frontend.log"
fi

echo ""
echo "Manager running. To stop: ./stop.sh"
echo ""
