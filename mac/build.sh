#!/bin/bash
# Builds "3D Earth.app" (universal: Apple silicon + Intel, macOS 13+). Needs
# Xcode or the Command Line Tools. Usage: mac/build.sh [version] → out/3D Earth.app
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-0.7.0}"
MIN_MACOS=13.0
APP="out/3D Earth.app"
TMP=out/mac-build
rm -rf "$APP" "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
for arch in arm64 x86_64; do
  xcrun swiftc -O -wmo -swift-version 5 -parse-as-library \
    -sdk "$SDK" -target "$arch-apple-macos$MIN_MACOS" \
    mac/Sources/*.swift -o "$TMP/3DEarth-$arch"
done
lipo -create "$TMP/3DEarth-arm64" "$TMP/3DEarth-x86_64" -output "$APP/Contents/MacOS/3DEarth"

sed "s/__VERSION__/$VERSION/g" mac/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# The shared WebGL scene (identical to the Windows app's ./web folder).
cp -R web "$APP/Contents/Resources/web"
rm -rf "$APP/Contents/Resources/web/data"
cp THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/"

# App icon from the Windows icon's 256 px image.
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s mac/AppIcon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d mac/AppIcon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature (required on Apple silicon). CI re-signs with Developer ID
# and notarizes when the signing secrets are available (.github/workflows/build.yml).
codesign --force --sign - "$APP"
echo "Built $APP ($VERSION)"
