import Foundation

/// Static facts about this build.
enum AppInfo {
    static let name = "3D Earth"
    static let bundleID = Bundle.main.bundleIdentifier ?? "com.axeasy.3DEarth"
    static let version: String = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    static let feedRepo = "vagdesign/3D-Earth"
    static let copyright = "© 2026 Ax-Easy - Vangelis Makridakis"
    static let showSettingsNotification = Notification.Name("com.axeasy.3DEarth.showSettings")

    static func hasArg(_ a: String) -> Bool { CommandLine.arguments.contains(a) }

    static func argValue(_ a: String) -> String? {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: a), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
}

/// Where things live (the macOS equivalents of %APPDATA% / %LOCALAPPDATA%\3D Earth).
enum Paths {
    static let support: URL = ensure(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("3D Earth", isDirectory: true))
    static let data: URL = ensure(support.appendingPathComponent("data", isDirectory: true))
    static let logs: URL = ensure(FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/3D Earth", isDirectory: true))
    static var settingsFile: URL { support.appendingPathComponent("settings.json") }
    static var logFile: URL { logs.appendingPathComponent("3DEarth.log") }
    static var web: URL { Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true) }

    @discardableResult
    static func ensure(_ url: URL) -> URL {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

enum Log {
    private static let queue = DispatchQueue(label: "com.axeasy.3DEarth.log")
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()

    static func info(_ message: String) { write("INFO ", message) }

    static func error(_ context: String, _ error: Error?) {
        write("ERROR", "\(context): \(error.map { String(describing: $0) } ?? "unknown error")")
    }

    private static func write(_ level: String, _ message: String) {
        let line = "\(formatter.string(from: Date())) \(level) \(message)\n"
        let bytes = Data(line.utf8)
        FileHandle.standardError.write(bytes)
        queue.async {
            let url = Paths.logFile
            let fm = FileManager.default
            if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber, size.intValue > 1_000_000 {
                try? fm.removeItem(at: url)
            }
            if let h = try? FileHandle(forWritingTo: url) {
                h.seekToEndOfFile()
                h.write(bytes)
                try? h.close()
            } else {
                try? bytes.write(to: url)
            }
        }
    }
}

/// User settings. Property names match the Windows app's settings.json
/// (camelCase) and web/js/settings.js, so the whole object is sent to the page
/// as-is and settings exported on Windows import here unchanged.
struct AppSettings: Codable, Equatable {
    // --- scene (shared with the page) ---
    var view = "moon"               // moon | home | sunrise
    var homeLat = 38.0
    var homeLon = 23.7
    var earthFill = 0.96
    var earthPosition = 0.0
    var fov = 40.0
    var sunsideBias = 30.0
    var moonScale = 1.0
    var clouds = true
    var cloudOpacity = 1.0
    var cloudCover = 1.0
    var cloudDetail = 1.0
    var cloudLoop = true
    var storms = true
    var labels = true
    var credits = true
    var stars = 0.6
    var milkyWay = 0.5
    var exposure = 1.0
    var landBrightness = 1.0
    var oceanReflection = 1.0
    var oceanRoughness = 0.35
    var haze = 1.0
    var lightsBrightness = 1.0
    var lightsFlicker = 0.3
    var motion = "live"             // live | spin | timelapse | daylapse
    var spinSeconds = 60.0
    var timeSpeed = 60.0
    var customTime = ""             // ISO 8601 UTC, empty = now
    var quality = "medium"          // low | medium | high
    var antialias = 4               // 0 | 2 | 4 | 8 (8 = + supersampling)
    var surfaceTexture = "sss"      // sss | bluemarble | builtin
    var fps = 30
    var renderScale = 1.0

    // --- host only ---
    var monitors = "all"            // all | primary
    var pauseWhenCovered = true
    var pauseOnBattery = true
    var weatherRefreshMinutes = 30
    var customCloudUrl = ""
    var autoCheckUpdates = true
    var autoInstallUpdates = false  // Windows only (kept so exported files round-trip)
    var firstRunDone = false

    static let fpsChoices = [10, 15, 24, 30, 60, 120, 144]

    /// The settings as a JSON object (for the page and for export).
    var jsonObject: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    func encoded() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try enc.encode(self)
    }

    /// Lenient decoding: unknown keys are ignored, missing keys keep their
    /// defaults and numbers written as strings are accepted (like the Windows app).
    static func decode(_ data: Data) throws -> AppSettings {
        let base = AppSettings().jsonObject
        guard let patch = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "3DEarth", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not a settings file."])
        }
        let intKeys: Set<String> = ["antialias", "fps", "weatherRefreshMinutes"]
        var merged = base
        for (key, value) in patch {
            guard let current = base[key], !(value is NSNull) else { continue }
            if current is String {
                merged[key] = (value as? String) ?? "\(value)"
            } else if let n = current as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() {
                if let b = value as? Bool { merged[key] = b }
                else if let s = value as? String { merged[key] = (s == "true" || s == "1") }
            } else if let n = value as? NSNumber {
                merged[key] = intKeys.contains(key) ? NSNumber(value: Int(n.doubleValue.rounded())) : NSNumber(value: n.doubleValue)
            } else if let s = value as? String, let d = Double(s) {
                merged[key] = intKeys.contains(key) ? NSNumber(value: Int(d.rounded())) : NSNumber(value: d)
            }
        }
        let json = try JSONSerialization.data(withJSONObject: merged)
        return try JSONDecoder().decode(AppSettings.self, from: json)
    }

    static func load() -> AppSettings {
        if let data = try? Data(contentsOf: Paths.settingsFile) {
            do { return try decode(data) } catch { Log.error("Loading settings", error) }
        }
        return Presets.firstRun()
    }

    func save() {
        do { try encoded().write(to: Paths.settingsFile, options: .atomic) }
        catch { Log.error("Saving settings", error) }
    }

    /// A first guess of the user's location from the time zone (same rule as Windows).
    mutating func guessHomeFromTimeZone() {
        let tz = TimeZone.current
        let offset = Double(tz.secondsFromGMT() - Int(tz.daylightSavingTimeOffset())) / 3600.0
        homeLon = (min(max(offset * 15.0, -180), 180) * 10).rounded() / 10
        if offset >= 1 && offset <= 3 { homeLat = 42 }            // Europe / Middle East
        else if offset >= 4 && offset <= 6 { homeLat = 28 }       // South Asia
        else if offset >= 7 && offset <= 9.5 { homeLat = 35 }     // East Asia
        else if offset >= 10 { homeLat = -30 }                    // Australia / NZ
        else if offset <= -3 && offset >= -3.5 { homeLat = -20 }  // South America
        else { homeLat = 38 }
    }

    /// Clamps values the settings window cannot represent.
    mutating func normalize() {
        homeLat = min(max(homeLat, -90), 90)
        homeLon = min(max(homeLon, -180), 180)
        moonScale = min(max(moonScale.rounded(), 1), 4)
        antialias = antialias >= 8 ? 8 : antialias >= 4 ? 4 : antialias >= 2 ? 2 : 0
        if !AppSettings.fpsChoices.contains(fps) {
            fps = AppSettings.fpsChoices.min(by: { abs($0 - fps) < abs($1 - fps) }) ?? 30
        }
        spinSeconds = min(max(spinSeconds, 10), 3600)
        timeSpeed = min(max(timeSpeed, 1), 100000)
        weatherRefreshMinutes = min(max(weatherRefreshMinutes, 15), 720)
        if !["moon", "home", "sunrise"].contains(view) { view = "moon" }
        if !["live", "spin", "timelapse", "daylapse"].contains(motion) { motion = "live" }
        if !["low", "medium", "high"].contains(quality) { quality = "medium" }
        if !["sss", "bluemarble", "builtin"].contains(surfaceTexture) { surfaceTexture = "sss" }
        if monitors != "primary" { monitors = "all" }
    }
}

/// Ready-made combinations of settings (same as the Windows app). "Showcase"
/// is also what a fresh install starts with. Presets never touch the home
/// location, monitors or open-at-login.
enum Presets {
    struct Preset {
        let name: String
        let apply: (inout AppSettings) -> Void
    }

    static let all: [Preset] = [
        Preset(name: "Showcase: day & night time-lapse above my location") { s in
            s.view = "home"; s.motion = "daylapse"; s.timeSpeed = 1200; s.spinSeconds = 120; s.cloudLoop = true
            s.quality = "high"; s.antialias = 8; s.fps = 60; s.clouds = true; s.cloudDetail = 1; s.cloudCover = 1
            s.labels = true; s.storms = true; s.credits = true
        },
        Preset(name: "Real time: the Moon beside the Earth") { s in
            s.view = "moon"; s.motion = "live"; s.quality = "medium"; s.antialias = 4; s.fps = 30
            s.clouds = true; s.labels = true; s.storms = true
        },
        Preset(name: "Spin 360° around my location") { s in
            s.view = "home"; s.motion = "spin"; s.spinSeconds = 120; s.quality = "high"; s.antialias = 8; s.fps = 60
        },
        Preset(name: "Sunrise behind the Earth") { s in
            s.view = "sunrise"; s.motion = "live"; s.labels = false; s.quality = "high"; s.antialias = 8
        },
        Preset(name: "Power saver (laptops, integrated graphics)") { s in
            s.quality = "low"; s.antialias = 0; s.fps = 15; s.motion = "live"; s.pauseOnBattery = true; s.pauseWhenCovered = true
        },
    ]

    /// Settings for a brand-new install (a defaults.json in Resources can override them).
    static func firstRun() -> AppSettings {
        var s = AppSettings()
        all[0].apply(&s)
        if let url = Bundle.main.url(forResource: "defaults", withExtension: "json"), let data = try? Data(contentsOf: url) {
            do { s = try AppSettings.decode(data) } catch { Log.error("Reading defaults.json", error) }
        }
        s.guessHomeFromTimeZone()
        s.firstRunDone = false
        return s
    }
}
