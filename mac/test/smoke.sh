#!/bin/bash
# CI smoke test: launches "3D Earth.app" on the runner's desktop, lets it render,
# then saves the app's own snapshot of the wallpaper page (WKWebView) and a
# screenshot of the whole desktop (screencapture). Runs the Apple silicon slice
# natively and, when Rosetta is available, the Intel slice as well.
# Usage: mac/test/smoke.sh "out/3D Earth.app" out/mac-shot
set -uo pipefail
APP="$1"
OUT="$2"
BIN="$APP/Contents/MacOS/3DEarth"
SUPPORT="$HOME/Library/Application Support/3D Earth"
mkdir -p "$OUT"

sw_vers; uname -m
system_profiler SPDisplaysDataType 2>/dev/null | sed -n '1,25p'
lipo -archs "$BIN"

# A few desktop icons, to show the Earth is drawn behind them.
mkdir -p "$HOME/Desktop"
echo "3D Earth smoke test" > "$HOME/Desktop/Desktop icon.txt"
mkdir -p "$HOME/Desktop/Folder on the desktop"

run() {
  local tag="$1"; shift
  echo "=== run $tag ==="
  # shellcheck disable=SC2086
  "$@" "$BIN" --no-welcome --snapshot "$OUT/wallpaper-$tag.png" --snapshot-delay 30 ${EXTRA_ARGS:-} > "$OUT/log-$tag.txt" 2>&1 &
  local pid=$!
  for _ in $(seq 1 90); do
    [ -s "$OUT/wallpaper-$tag.png" ] && break
    kill -0 "$pid" 2>/dev/null || { echo "app exited early"; break; }
    sleep 1
  done
  sleep 3
  screencapture -x "$OUT/desktop-$tag.png" || echo "screencapture failed"
  # The wallpaper window on its own (window capture instead of the display).
  local wid
  wid="$(sed -n 's/.*INFO  wallpaper window \([0-9]*\):.*/\1/p' "$OUT/log-$tag.txt" | head -1)"
  if [ -n "$wid" ]; then screencapture -x -o -l "$wid" "$OUT/window-$tag.png" || echo "window capture failed"; fi
  # Is the app still alive, and which architecture did it run as?
  ps -o pid,stat,etime,command -p "$pid" || true
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  grep -E "Starting 3D Earth|scene ready|WebGL|window stack|wallpaper window|snapshot|paused|resumed|ERROR|Clouds|Texture|Surface" "$OUT/log-$tag.txt" | head -80
  ls -la "$OUT"
}

# 1) Apple silicon (native), fresh install: the first-run "Showcase" settings.
rm -rf "$SUPPORT"
run arm64

# 1b) The same scene in an ordinary window above the wallpaper ("Open in a window"),
#     to tell a screen-capture limitation of the runner from a rendering problem.
EXTRA_ARGS=--preview run arm64-preview

# 2) Intel slice under Rosetta, with saved settings (real time, Moon beside the Earth).
if [ "$(uname -m)" = arm64 ]; then
  /usr/sbin/softwareupdate --install-rosetta --agree-to-license >/dev/null 2>&1 || true
  if arch -x86_64 /usr/bin/true 2>/dev/null; then
    mkdir -p "$SUPPORT"
    printf '{"view":"moon","motion":"live","quality":"medium","antialias":4,"fps":30,"firstRunDone":true}' > "$SUPPORT/settings.json"
    run x86_64 arch -x86_64
  else
    echo "Rosetta not available; skipping the Intel run"
  fi
fi
cp "$HOME/Library/Logs/3D Earth/3DEarth.log" "$OUT/3DEarth.log" 2>/dev/null || true
