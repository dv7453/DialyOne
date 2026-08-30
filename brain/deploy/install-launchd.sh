#!/usr/bin/env bash
# Install Dialy headless host as a macOS LaunchAgent (KeepAlive).
# Usage: bash brain/deploy/install-launchd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$BRAIN_DIR/deploy/launchd/com.dialy.brain.plist.template"
LABEL="com.dialy.brain"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# Prefer Dialy workdir for logs; fall back to legacy.
if [[ -d "$HOME/.dialy" ]]; then
  LOG_DIR="$HOME/.dialy/logs"
elif [[ -d "$HOME/.rowboat" ]]; then
  LOG_DIR="$HOME/.rowboat/logs"
else
  LOG_DIR="$HOME/.dialy/logs"
fi
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

NODE="$(command -v node)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

if [[ ! -f "$BRAIN_DIR/dist/host/main.js" ]]; then
  echo "Building @x/core (host entry)…"
  (cd "$ROOT/apps/x" && pnpm --filter @x/core build)
fi

# Free port 8787 if a manual npm run start is holding it.
if lsof -tiTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stopping process(es) on :8787 so launchd can bind…"
  lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
fi

# Unload prior agents (Dialy + legacy Rowboat label if present).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl unload "$DEST" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.rowboat.brain.plist" 2>/dev/null || true

PATH_VALUE="${PATH}"
sed \
  -e "s|__BRAIN_DIR__|${BRAIN_DIR}|g" \
  -e "s|__NODE__|${NODE}|g" \
  -e "s|__LOG_DIR__|${LOG_DIR}|g" \
  -e "s|__PATH__|${PATH_VALUE}|g" \
  "$TEMPLATE" > "$DEST"

# modern macOS
if launchctl bootstrap "gui/$(id -u)" "$DEST" 2>/dev/null; then
  launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
else
  launchctl load -w "$DEST"
fi

echo "Installed LaunchAgent: $DEST"
echo "Label: $LABEL (KeepAlive=true, RunAtLoad=true)"
echo "Logs: $LOG_DIR/brain.launchd.*.log"
ready=0
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  if curl -sf "http://127.0.0.1:8787/health" >/dev/null; then
    ready=1
    break
  fi
done
if [[ "$ready" -eq 1 ]]; then
  echo "Health OK → http://127.0.0.1:8787/health"
else
  echo "Health not ready yet — check: tail -f $LOG_DIR/brain.launchd.err.log"
fi

echo
echo "Unload later:"
echo "  launchctl bootout gui/\$(id -u)/${LABEL}"
echo "  # or: launchctl unload $DEST"
