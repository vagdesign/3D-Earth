# Mac App Store build

The Mac app is built in two variants from the same sources:

| | Developer ID (GitHub release) | Mac App Store |
|---|---|---|
| Build | `mac/build.sh 0.7.0` → `out/3D Earth.app` | `mac/build.sh --appstore 0.7.0 <build>` → `out/appstore/3D Earth.app` |
| Compile flag | – | `-D APPSTORE` |
| Sandbox | no | yes, `mac/entitlements/appstore.entitlements` |
| Updates | checks GitHub Releases, opens the release page | none in the app: the App Store updates it (Guideline 2.4.5 (vii)) |
| Signing (CI) | Developer ID Application, notarized | Apple Distribution + `embedded.provisionprofile`, then a `.pkg` signed with Mac Installer Distribution |
| `CFBundleVersion` | = version | = build number (the workflow run number, or the `appstore_build_number` input) |

## What the App Store variant changes

- **App Sandbox** with only `com.apple.security.network.client` (HTTPS downloads of
  cloud maps, storm lists and Earth/Moon textures) and
  `com.apple.security.files.user-selected.read-write` (Settings → Export…/Import…).
  CI adds `com.apple.application-identifier` / `com.apple.developer.team-identifier`
  from the provisioning profile when signing for distribution.
- Settings, cache, downloads and the log move into the container automatically
  (`~/Library/Containers/com.axeasy.3DEarth/Data/Library/{Application Support,Logs}/3D Earth`)
  because the app only uses `FileManager` standard directories.
- No update check: the `UpdateService`, the *Check for updates…* menu item and the
  *Updates* settings tab are compiled out.
- Public API only: the WebKit `drawsBackground` / `developerExtrasEnabled` key-value
  tweaks used by the Developer ID build are compiled out (the web view stays
  transparent until the page has loaded instead).
- No downloaded code: the WebGL scene (`web/`) is bundled; the `earth://local/data/`
  route only serves `.jpg/.jpeg/.png/.webp/.json` (both variants).
- *Open at login* uses `SMAppService.mainApp` (works sandboxed, only when the user
  turns it on). Desktop-level windows are plain `NSWindow` levels (public API).
- `Info.plist`: `ITSAppUsesNonExemptEncryption = NO` (only standard HTTPS),
  `LSApplicationCategoryType = public.app-category.weather` (the app's live content
  is the global cloud cover and active tropical storms; *Utilities* stays the
  category of the Developer ID build), copyright `© 2026 Ax-Easy`.
- Icon: `mac/AppIcon-1024.png` (1024 px) when present, else the 256 px `mac/AppIcon.png`.

## CI

`.github/workflows/build.yml`:

- **mac-appstore-sandbox** (every run, also pull requests, no secrets): builds the
  App Store variant ad-hoc signed with the sandbox entitlements and runs
  `mac/test/sandbox.sh`, which launches it on the runner and checks the container,
  the scene, the downloads, `SMAppService` and the sandbox violation log.
- **mac-appstore** (manual *Run workflow* and `v*` tags only, never pull requests):
  needs these repository secrets, otherwise it skips itself with a notice:

  | Secret | Content |
  |---|---|
  | `MAS_APP_CERT_P12_BASE64` / `MAS_APP_CERT_PASSWORD` | Apple Distribution certificate + key (.p12, base64) |
  | `MAS_INSTALLER_CERT_P12_BASE64` / `MAS_INSTALLER_CERT_PASSWORD` | Mac Installer Distribution certificate + key (.p12, base64) |
  | `MAS_PROVISIONING_PROFILE_BASE64` | Mac App Store provisioning profile for `com.axeasy.3DEarth` (base64) |
  | `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | the App Store Connect API key (already used for notarization) |

  It signs, builds `3D-Earth-mac-appstore-<version>-<build>.pkg`, validates it with
  `xcrun altool --validate-app` (needs the app record in App Store Connect) and
  uploads only when the run was started manually with **appstore_upload** ticked.

## Build numbers

App Store Connect rejects an upload whose `CFBundleVersion` is not higher than the
previous one. CI uses the workflow run number (always growing). To force a value,
run the workflow manually with `appstore_build_number`.
