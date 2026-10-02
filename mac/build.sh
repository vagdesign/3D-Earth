#!/bin/bash
# Builds "3D Earth.app" (universal: Apple silicon + Intel; macOS 12+, App Store build 13+). Needs
# Xcode or the Command Line Tools.
#
#   mac/build.sh [version]                        → out/3D Earth.app (Developer ID / GitHub build)
#   mac/build.sh --appstore [version] [build]     → out/appstore/3D Earth.app (Mac App Store build)
#
# The App Store build is compiled with -D APPSTORE (no self update check), is
# sandboxed (mac/entitlements/appstore.entitlements) and gets CFBundleVersion =
# [build], which must grow with every upload to App Store Connect. Both builds
# are ad-hoc signed here; CI re-signs them for distribution.
set -euo pipefail
cd "$(dirname "$0")/.."
VARIANT=developer-id
if [ "${1:-}" = "--appstore" ]; then VARIANT=appstore; shift; fi
VERSION="${1:-0.7.2}"
BUILD="${2:-$VERSION}"
MIN_MACOS=12.0   # Developer ID build: Monterey and later (Mac Pro 2013 etc. run 12 natively)
SWIFT_DEFINES=()
if [ "$VARIANT" = appstore ]; then
  APP="out/appstore/3D Earth.app"
  TMP=out/appstore-build
  SWIFT_DEFINES=(-D APPSTORE)
  MIN_MACOS=13.0   # App Store build stays on SMAppService (sandboxed)
else
  APP="out/3D Earth.app"
  TMP=out/mac-build
fi
rm -rf "$APP" "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
for arch in arm64 x86_64; do
  xcrun swiftc -O -wmo -swift-version 5 -parse-as-library ${SWIFT_DEFINES[@]+"${SWIFT_DEFINES[@]}"} \
    -sdk "$SDK" -target "$arch-apple-macos$MIN_MACOS" \
    mac/Sources/*.swift -o "$TMP/3DEarth-$arch"
done
lipo -create "$TMP/3DEarth-arm64" "$TMP/3DEarth-x86_64" -output "$APP/Contents/MacOS/3DEarth"

sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" -e "s/__MIN_MACOS__/$MIN_MACOS/g" mac/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [ "$VARIANT" = appstore ]; then
  PLIST="$APP/Contents/Info.plist"
  # Live clouds and tropical storms on a 3D globe (see mac/APPSTORE.md for the choice).
  plutil -replace LSApplicationCategoryType -string public.app-category.weather "$PLIST"
  # Only standard HTTPS (URLSession / WebKit) is used: exempt, no export compliance documents.
  plutil -insert ITSAppUsesNonExemptEncryption -bool NO "$PLIST"
  plutil -replace NSHumanReadableCopyright -string "© 2026 Ax-Easy" "$PLIST"
fi

# The shared WebGL scene (identical to the Windows app's ./web folder).
cp -R web "$APP/Contents/Resources/web"
rm -rf "$APP/Contents/Resources/web/data"
cp THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/"
if [ "$VARIANT" = appstore ]; then cp mac/PrivacyInfo.xcprivacy "$APP/Contents/Resources/"; fi

# App icon. The App Store needs a 1024 px image (icon_512x512@2x); mac/AppIcon-1024.png
# is the high-resolution source, mac/AppIcon.png the Windows icon's 256 px image.
ICON_SRC=mac/AppIcon.png
if [ "$VARIANT" = appstore ] && [ -f mac/AppIcon-1024.png ]; then ICON_SRC=mac/AppIcon-1024.png; fi
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature (required on Apple silicon). CI re-signs with Developer ID
# and notarizes, or with Apple Distribution for the App Store
# (.github/workflows/build.yml). The App Store build is sandboxed already here.
if [ "$VARIANT" = appstore ]; then
  codesign --force --sign - --entitlements mac/entitlements/appstore.entitlements "$APP"
else
  codesign --force --sign - "$APP"
fi
echo "Built $APP ($VERSION, build $BUILD, $VARIANT)"
