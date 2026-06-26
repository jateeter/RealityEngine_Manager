#!/usr/bin/env bash
# ============================================================
# Reality Engine Manager — stop
#
# Sends SIGTERM to all processes recorded by start.sh, waits
# for clean shutdown, then force-kills any stragglers.
#
# Usage:
#   ./stop.sh [--force]
#
# Options:
#   --force   Send SIGKILL immediately instead of waiting
# ============================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/.manager-pids"
FORCE=0
WAIT_SECS=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,2\}//' | head -15
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "────────────────────────────────────────────────────────"
echo "  Reality Engine Manager — stopping"
echo "────────────────────────────────────────────────────────"

# Kill a process holding one of the Manager ports — but NEVER Docker's proxy.
# When the RealityEngine_CI Docker stack is running, ports 3001/5173 are
# published by the reality-engine-tls-proxy container and bound on the host by
# `com.docker.backend` (a.k.a. docker-proxy). Killing that PID takes the whole
# Docker daemon down. Only kill genuine native Manager processes (node/vite).
kill_native_port_holder() {
  local port="$1" sig="${2:-TERM}" pid comm
  for pid in $(lsof -ti tcp:"$port" 2>/dev/null || true); do
    [[ -z "$pid" ]] && continue
    comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$comm" in
      *com.docker.backend*|*docker-proxy*|*Docker.app*|*vpnkit*)
        echo "  Port :$port is held by Docker ($comm, PID $pid) — NOT killing (would crash the daemon)."
        continue ;;
    esac
    echo "  Native process on :$port (PID $pid, ${comm:-unknown}) — sending SIG$sig."
    kill -"$sig" "$pid" 2>/dev/null || true
  done
}

if [[ ! -f "$PID_FILE" ]]; then
  echo "  .manager-pids not found — nothing to stop."
  echo ""
  # Best-effort: kill native processes still holding the known ports
  # (skips Docker's proxy so we never crash the daemon).
  for port in 3001 5173; do
    kill_native_port_holder "$port" TERM
  done
  exit 0
fi

PIDS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -n "$line" ]] && PIDS+=("$line")
done < "$PID_FILE"

if [[ ${#PIDS[@]} -eq 0 ]]; then
  echo "  PID file is empty."
  rm -f "$PID_FILE"
  exit 0
fi

# ── Send initial signal ──────────────────────────────────────
SIG="TERM"
[[ $FORCE -eq 1 ]] && SIG="KILL"

for pid in "${PIDS[@]}"; do
  [[ -z "$pid" ]] && continue
  if kill -0 "$pid" 2>/dev/null; then
    echo "  Sending SIG$SIG to PID $pid..."
    kill -"$SIG" "$pid" 2>/dev/null || true
  else
    echo "  PID $pid already gone."
  fi
done

# ── Wait for graceful shutdown ───────────────────────────────
if [[ $FORCE -eq 0 ]]; then
  echo ""
  echo "  Waiting up to ${WAIT_SECS}s for clean shutdown..."
  for i in $(seq 1 $((WAIT_SECS * 2))); do
    all_gone=1
    for pid in "${PIDS[@]}"; do
      [[ -z "$pid" ]] && continue
      if kill -0 "$pid" 2>/dev/null; then all_gone=0; fi
    done
    [[ $all_gone -eq 1 ]] && break
    sleep 0.5
  done

  # Force-kill survivors
  for pid in "${PIDS[@]}"; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      echo "  PID $pid still alive — sending SIGKILL."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

# ── Kill any native process still on the known ports (skips Docker's proxy) ──
for port in 3001 5173; do
  kill_native_port_holder "$port" KILL
done

rm -f "$PID_FILE"

echo ""
echo "  Stopped. Logs preserved in .manager-logs/"
echo ""
