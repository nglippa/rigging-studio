#!/bin/zsh
# Starts Rigging Studio in the background on this machine: the app at http://localhost:5177, the browser bridge that
# reaches ComfyUI (127.0.0.1:47831) and, when COMFYUI_FORWARD_TARGET is set in .env.local (the Mac Studio, where ComfyUI
# listens on its private address), a loopback forward to it on 127.0.0.1:8188. Safe to run again: anything already
# listening is left alone. Logs and pids go to .studio/. Stop with: npm run studio:down
set -u
cd "${0:A:h}/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p .studio

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
start() { # name port command...
  local name=$1 port=$2; shift 2
  if listening "$port"; then echo "$name: already running on port $port"; return; fi
  # stdin from /dev/null: the bridge reads stdin (MCP), and a background job reading the terminal is stopped (SIGTTIN).
  nohup "$@" < /dev/null > ".studio/$name.log" 2>&1 &
  echo $! > ".studio/$name.pid"
  for _ in {1..60}; do listening "$port" && { echo "$name: started on port $port"; return; }; sleep 1; done
  echo "$name: did not start within a minute; see .studio/$name.log"
}

target=$(grep -E '^COMFYUI_FORWARD_TARGET=' .env.local 2>/dev/null | cut -d= -f2-)
if [[ -n "$target" ]]; then
  start comfy-forward 8188 env COMFYUI_FORWARD_TARGET="$target" node scripts/comfy-forward.mjs
fi
start bridge 47831 npm run mcp
start app 5177 npm run dev
echo "Rigging Studio: http://localhost:5177/"
