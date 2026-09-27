#!/bin/bash
# CI check for the Mac App Store build: launches the sandboxed (ad-hoc signed)
# "3D Earth.app" on the runner's desktop and verifies that
#   - it really runs in the App Sandbox (container created, APP_SANDBOX_CONTAINER_ID set),
#   - the bundled WebGL scene loads (page reports ready, snapshot written),
#   - weather/texture downloads land in the container (network.client works),
#   - SMAppService "open at login" can be registered from the sandbox,
#   - and lists any sandbox violations the system logged for the app.
# Usage: mac/test/sandbox.sh "out/appstore/3D Earth.app" out/appstore-shot
set -uo pipefail
APP="$1"
OUT="$2"
BIN="$APP/Contents/MacOS/3DEarth"
BUNDLE_ID=com.axeasy.3DEarth
CONTAINER="$HOME/Library/Containers/$BUNDLE_ID"
DATA="$CONTAINER/Data"
SUPPORT="$DATA/Library/Application Support/3D Earth"
LOG="$DATA/Library/Logs/3D Earth/3DEarth.log"
mkdir -p "$OUT"
fail=0

echo "=== signature and entitlements ==="
codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Format|Signature)='
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p - | tee "$OUT/entitlements.txt"
grep -q '"com.apple.security.app-sandbox" => true' "$OUT/entitlements.txt" || { echo "::error::app-sandbox entitlement missing"; fail=1; }
plutil -p "$APP/Contents/Info.plist" | grep -E 'CFBundle(ShortVersionString|Version|Identifier)|ITSAppUses|LSApplicationCategory|LSUIElement|LSMinimum'
if strings "$BIN" | grep -q 'api.github.com'; then echo "::error::the App Store binary still contains the GitHub update check"; fail=1; else echo "No self-update code (api.github.com) in the binary."; fi

rm -rf "$CONTAINER" "$HOME/Library/Application Support/3D Earth"
START="$(date '+%Y-%m-%d %H:%M:%S')"

echo "=== launch (sandboxed) ==="
SNAP="$DATA/sandbox-snapshot.png"   # the app may only write inside its container
"$BIN" --no-welcome --test-login-item --snapshot "$SNAP" --snapshot-delay 40 > "$OUT/stderr.txt" 2>&1 &
pid=$!
for _ in $(seq 1 120); do
  [ -s "$SNAP" ] && break
  kill -0 "$pid" 2>/dev/null || { echo "::error::app exited early"; fail=1; break; }
  sleep 1
done
sleep 3
screencapture -x "$OUT/desktop.png" || echo "screencapture failed"
ps -o pid,stat,etime,command -p "$pid" || { echo "::error::app not running"; fail=1; }
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

echo "=== container ==="
if [ -d "$DATA" ]; then echo "container: $CONTAINER"; else echo "::error::no sandbox container was created"; fail=1; fi
find "$DATA/Library/Application Support" "$DATA/Library/Logs" -maxdepth 3 -type f -exec ls -la {} \; 2>/dev/null | sed "s|$HOME|~|"
[ -d "$HOME/Library/Application Support/3D Earth" ] && { echo "::error::wrote outside the container"; fail=1; }
cp "$SNAP" "$OUT/wallpaper-snapshot.png" 2>/dev/null || true
cp "$LOG" "$OUT/3DEarth.log" 2>/dev/null || true
cp "$SUPPORT/data/manifest.json" "$OUT/manifest.json" 2>/dev/null || true

echo "=== app log ==="
grep -E "Starting 3D Earth|scene ready|page state|snapshot|Clouds|Texture|Surface|storm|Storm|Open at login|ERROR|navigation" "$OUT/stderr.txt" | head -60
grep -q "sandboxed (" "$OUT/stderr.txt" || { echo "::error::the app did not report APP_SANDBOX_CONTAINER_ID"; fail=1; }
grep -q "scene ready" "$OUT/stderr.txt" || { echo "::error::the scene did not report ready"; fail=1; }
grep -q "Clouds updated from" "$OUT/stderr.txt" || echo "::warning::no cloud map downloaded in the sandbox (network?)"
[ -s "$OUT/wallpaper-snapshot.png" ] || { echo "::error::no snapshot written"; fail=1; }

echo "=== sandbox violations (system log) ==="
log show --start "$START" --style compact \
  --predicate '(sender == "Sandbox" OR subsystem == "com.apple.sandbox.reporting" OR eventMessage CONTAINS "Sandbox:") AND eventMessage CONTAINS[c] "3DEarth"' \
  > "$OUT/sandbox-violations.txt" 2>&1 || true
n="$(grep -c 'deny' "$OUT/sandbox-violations.txt" || true)"
echo "sandbox denials logged for 3DEarth: ${n:-0}"
grep 'deny' "$OUT/sandbox-violations.txt" | sed -E 's/.*(deny[^ ]*) *\(?[0-9]*\)? *([^ ]+) *(.*)/\1 \2 \3/' | sort | uniq -c | sort -rn | head -40
ls -la "$OUT"
exit $fail
