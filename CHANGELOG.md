# Changelog

The section for each version is shown on its GitHub release page.

## 0.8.0

- **Clouds never get stuck on an old map again.** The apps now try several cloud sources in order and move to the next one within seconds when a source does not answer, sends something that is not an image, or has not published a new map for 9 hours:
  1. the new **3D Earth cloud service**, rebuilt every 3 hours from EUMETSAT satellite imagery;
  2. Matt Eason's live cloud maps;
  3. EUMETSAT's infrared world cloud map, fetched directly and turned into a cloud map by the app.
- **Sources can change without an app update.** The list of sources is read online at every weather refresh (`sources/sources.json`), so switching or adding a source reaches every installation, the Mac App Store version included, without a new release.
- Settings show which source the current clouds came from; the log says why the others were skipped.
- The 24-hour cloud loop keeps the last real day when every source stalls, instead of emptying.

## 0.7.5

- Kept the cloud history when the cloud source stalls; the status says since when no new map was published.

## 0.7.1 – 0.7.4

- macOS 12 Monterey support (the GitHub version); Mac Pro 2013 / AMD FirePro fixes: fallback when float render targets are missing, and a lighter safe mode after a GPU reset.
- Mac: texture download fallbacks (NASA Black Marble / Blue Marble), Monterey Settings layout fix.
