#!/usr/bin/env bash
# Runs Agent Office in the background, reachable from the local network.
#   scripts/service.sh start|stop|restart|status|logs      (HOST and PORT can be overridden)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4317}"
DATA_DIR="${AGENT_OFFICE_DATA:-data}"
PID_FILE="$DATA_DIR/server.pid"
LOG_FILE="$DATA_DIR/server.log"
mkdir -p "$DATA_DIR"

running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if running; then echo "Already running (pid $(cat "$PID_FILE"))"; return; fi
  npm run build --silent
  HOST="${HOST:-0.0.0.0}" PORT="$PORT" nohup node_modules/.bin/tsx src/server/main.ts >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 2
  if running; then
    echo "Started (pid $(cat "$PID_FILE")) → http://localhost:$PORT"
    grep -h "On your network\|Yerel ağda" "$LOG_FILE" | tail -3 || true
  else
    echo "Failed to start; see $LOG_FILE" >&2; tail -20 "$LOG_FILE" >&2; exit 1
  fi
}

stop() {
  if running; then
    kill "$(cat "$PID_FILE")"
    # It stops its agents and saves first; a new start must not read the state before that
    for _ in $(seq 1 150); do running || break; sleep 0.1; done
    if running; then kill -9 "$(cat "$PID_FILE")"; fi
    echo "Stopped"
  else
    echo "Not running"
  fi
  rm -f "$PID_FILE"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if running; then echo "Running (pid $(cat "$PID_FILE"))"; else echo "Not running"; fi ;;
  logs) tail -f "$LOG_FILE" ;;
  *) echo "usage: $0 start|stop|restart|status|logs" >&2; exit 1 ;;
esac
