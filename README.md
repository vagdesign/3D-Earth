# 3D Earth — live wallpaper for Windows 10/11

A real-time 3D Earth that lives **on your desktop, behind the icons and the taskbar**:

- **Current clouds** from geostationary weather satellites, refreshed every hour and cross-faded in slowly
- **Active hurricanes, typhoons and cyclones** with name, category and wind speed (NHC + GDACS)
- **True day and night**: the Sun's real position, with city lights, a sunset-coloured terminator, ocean glint and atmospheric haze
- **The Moon and planets at their real positions and true sizes**, with the correct lunar phase, over 5,000 real stars and the Milky Way
- The Earth always **fills the screen height** on any monitor shape (16:9, ultrawide, portrait, multi-monitor)

| Moon beside the Earth (ultrawide) | Above my location | Sunrise behind the Earth |
|---|---|---|
| ![](docs/preview-moon-ultrawide.jpg) | ![](docs/preview-home.jpg) | ![](docs/preview-sunrise.jpg) |

*(Previews are software-rendered with the bundled offline textures. On a real PC the app downloads 8K textures and the live cloud map.)*

## Install

1. Download `3DEarth-Setup-x.y.z.exe` from the [latest release](https://github.com/vagdesign/3D-Earth/releases/latest).
2. Run it. Administrator rights are not needed; it installs per user. Leave **"Start 3D Earth automatically when I sign in"** ticked to have it start with Windows.
3. The Earth replaces your desktop background immediately. A globe icon appears in the notification area.

Requirements: Windows 10 1809+ or Windows 11, x64, and the Microsoft Edge **WebView2 Runtime**. The runtime is already present on almost every PC; the installer and the app offer the download link if it is missing.

A portable `.zip` is also built. Unzip it anywhere and run `3DEarth.exe`.

## Using it

Right-click the globe in the notification area:

| Menu | What it does |
|---|---|
| **View → Moon beside the Earth** | A real vantage point from which the Moon sits in the empty space beside the Earth. North is kept as close to up as possible. |
| **View → Above my location** | Hovers above your home location, like a geostationary satellite. Day and night sweep across it. |
| **View → Sunrise behind the Earth** | The Sun just behind the limb: glowing atmosphere, night side with city lights. |
| Moon / planet labels, Storm labels | Toggle the small text labels. |
| Update weather now | Downloads the newest cloud map and storm list. |
| Pause | Stops rendering, which uses 0% GPU. |
| Start with Windows | Adds or removes the per-user autostart entry. |
| **Settings…** | Location, Earth size and position, Moon size (true size up to 4×), clouds, stars, brightness, quality, frame rate, monitors, power saving, update interval, custom cloud-map URL. |

To change the static picture Windows shows when 3D Earth is not running, use the normal **Settings → Personalization → Background** page. 3D Earth draws on top of that background and below the icons, and restores it when you exit.

Power saving (on by default): rendering pauses when a maximised or full-screen app covers a monitor, while the PC is locked, and on battery.

## How it works

```
3DEarth.exe (C# / WinForms, .NET 10)
 ├─ DesktopLayer      finds the desktop layer between the wallpaper and the icons
 │                    (WorkerW on Windows 10/11, Progman child on Windows 11 24H2+)
 ├─ WallpaperWindow   one borderless window per monitor, parented into that layer,
 │                    hosting WebView2; serves ./web and the data folder from one origin
 ├─ DataService       downloads clouds, storms and HD textures to %LOCALAPPDATA%\3D Earth\data
 └─ TrayContext       tray menu, settings, watchdog (Explorer restarts, display changes), power saving

web/ (Three.js WebGL scene; runs in any browser too)
 ├─ astro.js      Sun/Moon/planet positions and Earth rotation (Astronomy Engine)
 ├─ framing.js    keeps the Earth filling the screen height; the three camera views
 ├─ shaders.js    analytic atmospheric scattering (Rayleigh + Mie), clouds, ocean glint
 ├─ earth.js      surface, cloud shell with cloud shadows, atmosphere halo
 ├─ moon.js       Moon (Lommel-Seeliger shading, tidally locked)
 └─ sky.js        stars (Yale BSC), Milky Way, planets, Sun and lens glare
```

Everything is in its real place. The scene uses the Earth's real rotation (sidereal time), the Sun direction for this moment, the Moon's real distance of about 60 Earth radii and its true size, and the planets' true directions. Only the camera position is chosen, and it is always a physically possible viewpoint.

### Data sources

| Data | Source | Refresh |
|---|---|---|
| Global cloud map | [Live cloud maps](https://github.com/matteason/live-cloud-maps) by Matt Eason, from EUMETSAT/NOAA/JMA geostationary imagery | every 60 min (configurable) |
| Tropical cyclones | [NOAA National Hurricane Center](https://www.nhc.noaa.gov/) `CurrentStorms.json` and [GDACS](https://www.gdacs.org/) | same |
| HD day and night textures, Moon | [Solar System Scope](https://www.solarsystemscope.com/textures/) (CC BY 4.0), based on NASA imagery | once |
| Offline textures (bundled) | NASA Blue Marble / Earth at Night (public domain), via three-globe examples | — |
| Stars, Milky Way | [d3-celestial](https://github.com/ofrohn/d3-celestial) data (Yale Bright Star Catalogue) | — |

You can set your own cloud source in **Settings → Cloud map URL**. It must be an equirectangular (2:1) image with white clouds on black.

## Development

Preview the scene in a browser (no Windows needed):

```bash
npm run serve        # then open http://localhost:8080/?debug
```

Query parameters override any setting and the clock, for example
`?view=home&homeLat=40.6&homeLon=22.9&t=2026-09-25T18:00:00Z&timeSpeed=600`.

Headless previews (as in CI): `npm install --no-save playwright && node tools/screenshot.mjs previews "view=moon"`.

Build the Windows app (on Windows, with the .NET 10 SDK):

```powershell
dotnet publish src/ThreeDEarth/ThreeDEarth.csproj -c Release -r win-x64 --self-contained -o publish
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" /DSourceDir=..\publish installer\3DEarth.iss
```

GitHub Actions builds the installer and the portable zip on every push. Pushing a tag `vX.Y.Z` creates a release.

Logs are written to `%LOCALAPPDATA%\3D Earth\3DEarth.log`. Start with `--devtools` to be able to inspect the page.

## Credits and licences

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
