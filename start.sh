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
#   --re <url>              RE runtime URL  (default: https://localhost:5001)
#   --pe <url>              PE runtime URL  (default: https://localhost:3004)
#   --scala                 Preset for Scala runtime  (RE :5001, PE :5000)
#   --cpp                   Preset for CPP runtime    (RE :5301, PE :5300)
#   --lsp                   Preset for LSP runtime    (RE :5601, PE :5600)
#   --port <n>              Visualizer backend port   (default: 3001)
#   --no-frontend           Skip starting the Vite dev server
#   --mqtt-broker-url <url> Enable MQTT bridge on PE after startup
#                             (e.g. mqtt://yuma.lateraledge.cloud:1883)
#   --mqtt-mappings <path>  Path to mappings JSON file for MQTT bridge
#                             (if omitted, loads PE's bundled Yuma example)
#   --mqtt-username <user>  MQTT broker username (optional)
#   --mqtt-password <pass>  MQTT broker password (optional)
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
MQTT_BROKER_URL=""
MQTT_MAPPINGS_PATH=""
MQTT_USERNAME=""
MQTT_PASSWORD=""

# ── Parse flags ─────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --re)                 RE_RUNTIME_URL="$2"; shift 2 ;;
    --pe)                 PE_RUNTIME_URL="$2"; shift 2 ;;
    --scala)              RE_RUNTIME_URL="http://localhost:5001"; PE_RUNTIME_URL="http://localhost:5000"; shift ;;
    --cpp)                RE_RUNTIME_URL="http://localhost:5301"; PE_RUNTIME_URL="http://localhost:5300"; shift ;;
    --lsp)                RE_RUNTIME_URL="http://localhost:5601"; PE_RUNTIME_URL="http://localhost:5600"; shift ;;
    --port)               VIZ_PORT="$2"; shift 2 ;;
    --no-frontend)        START_FRONTEND=0; shift ;;
    --no-seed)            SEED_MACHINES=0; shift ;;
    --mqtt-broker-url)    MQTT_BROKER_URL="$2"; shift 2 ;;
    --mqtt-mappings)      MQTT_MAPPINGS_PATH="$2"; shift 2 ;;
    --mqtt-username)      MQTT_USERNAME="$2"; shift 2 ;;
    --mqtt-password)      MQTT_PASSWORD="$2"; shift 2 ;;
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
[[ -n "$MQTT_BROKER_URL" ]] && echo "  MQTT:     $MQTT_BROKER_URL"
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

  # ── Enable MQTT bridge on PE if --mqtt-broker-url was given ────────────────
  if [[ -n "$MQTT_BROKER_URL" ]]; then
    echo ""
    echo "Enabling MQTT bridge on PE ($PE_RUNTIME_URL)..."

    # Resolve mappings JSON: file → PE example endpoint
    _MQTT_MAPPINGS_JSON=""
    if [[ -n "$MQTT_MAPPINGS_PATH" ]]; then
      if [[ -f "$MQTT_MAPPINGS_PATH" ]]; then
        _MQTT_MAPPINGS_JSON=$(cat "$MQTT_MAPPINGS_PATH")
        echo "  Mappings: $MQTT_MAPPINGS_PATH"
      else
        echo "  Warning: --mqtt-mappings path not found: $MQTT_MAPPINGS_PATH"
      fi
    fi
    if [[ -z "$_MQTT_MAPPINGS_JSON" ]]; then
      echo "  Fetching example mappings from PE GET /api/mqtt/example..."
      _MQTT_MAPPINGS_JSON=$(curl -sk --max-time 5 "$PE_RUNTIME_URL/api/mqtt/example" 2>/dev/null || true)
    fi

    if [[ -z "$_MQTT_MAPPINGS_JSON" ]]; then
      echo "  Warning: could not load MQTT mappings — skipping enable"
    else
      _MQTT_MAP_TMP=$(mktemp /tmp/mqtt-mappings.XXXXXX.json)
      printf '%s' "$_MQTT_MAPPINGS_JSON" > "$_MQTT_MAP_TMP"
      _MQTT_ENABLE_BODY=$(python3 - "$_MQTT_MAP_TMP" "$MQTT_BROKER_URL" "$MQTT_USERNAME" "$MQTT_PASSWORD" <<'PYEOF'
import json, sys
body = {"brokerUrl": sys.argv[2], "mappings": json.loads(open(sys.argv[1]).read())}
if sys.argv[3]: body["username"] = sys.argv[3]
if sys.argv[4]: body["password"] = sys.argv[4]
print(json.dumps(body))
PYEOF
)
      rm -f "$_MQTT_MAP_TMP"
      _MQTT_RESP=$(curl -sk --max-time 10 -X POST "$PE_RUNTIME_URL/api/mqtt/enable" \
        -H "Content-Type: application/json" -d "$_MQTT_ENABLE_BODY" 2>/dev/null || true)
      if echo "$_MQTT_RESP" | python3 -c \
          "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('success') or d.get('enabled') else 1)" \
          2>/dev/null; then
        _MQTT_COUNT=$(echo "$_MQTT_RESP" | python3 -c \
          "import json,sys; print(json.load(sys.stdin).get('mappings','?'))" 2>/dev/null || echo "?")
        echo "  MQTT bridge enabled  broker=$MQTT_BROKER_URL  mappings=$_MQTT_COUNT ✓"
      else
        _MQTT_ERR=$(echo "$_MQTT_RESP" | python3 -c \
          "import json,sys; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null || echo "$_MQTT_RESP")
        echo "  Warning: MQTT enable failed: $_MQTT_ERR"
      fi
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
