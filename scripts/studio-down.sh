#!/bin/zsh
# Stops what scripts/studio-up.sh started (by the pids it recorded in .studio/), and nothing else.
set -u
cd "${0:A:h}/.."
for name in app bridge comfy-forward; do
  pidfile=".studio/$name.pid"
  [[ -f "$pidfile" ]] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; echo "$name: stopped"; fi
  rm -f "$pidfile"
done
