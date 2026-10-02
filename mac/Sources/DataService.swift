import Foundation
import CryptoKit
import ImageIO
import CoreGraphics

/// Downloads live weather (global cloud map, active tropical cyclones) and, once,
/// higher-resolution Earth/Moon textures into ~/Library/Application Support/3D Earth/data.
/// The page reads data/manifest.json to know what changed. A port of the
/// Windows DataService (same sources, file names and manifest format).
@MainActor
final class DataService: NSObject {
    private final class Manifest { var d: [String: Any] = [:] }
    private struct Storm { let name, kind, category: String; let lat, lon, windKt: Double; let source: String }

    var settings: () -> AppSettings = { AppSettings() }
    var onChanged: (() -> Void)?
    private(set) var lastCloudUpdate: Date?
    private(set) var lastStormCount = 0
    private(set) var lastError = ""
    private(set) var historyCount = 0
    private(set) var historyHours = 0.0
    private(set) var busy = false

    private let session: URLSession
    private var timer: Timer?

    override init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 90
        cfg.timeoutIntervalForResource = 6 * 60
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        // Browser-like user agent: some map hosts refuse unknown clients.
        cfg.httpAdditionalHeaders = ["User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) 3DEarth/\(AppInfo.version) (+https://github.com/vagdesign/3D-Earth)"]
        session = URLSession(configuration: cfg)
        super.init()
    }

    func start() { reschedule() }

    func reschedule() {
        let minutes = min(max(settings().weatherRefreshMinutes, 15), 24 * 60)
        timer?.invalidate()
        timer = Timer.scheduledTimer(timeInterval: TimeInterval(minutes * 60), target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(tick), object: nil)
        perform(#selector(tick), with: nil, afterDelay: 3)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        NSObject.cancelPreviousPerformRequests(withTarget: self)
    }

    @objc private func tick() { refresh() }

    func refresh(forceTextures: Bool = false) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            await self.run(force: forceTextures)
            self.busy = false
        }
    }

    private func run(force: Bool) async {
        let m = Manifest()
        m.d = readManifest()
        lastError = ""
        var changed = false
        if await ensureTextures(m, force: force) { changed = true }
        if await updateClouds(m) { changed = true }
        if await updateStorms(m) { changed = true }
        writeHistory(m, readHistory(m))
        m.d["updated"] = DataService.iso(Date())
        writeManifest(m.d)
        if changed { onChanged?() }
    }

    // MARK: textures

    private static let blueMarbleIDs = ["73580", "73605", "73630", "73655", "73701", "73726", "73751", "73776", "73801", "73826", "73884", "73909"]

    /// Candidate URLs for the Earth surface map chosen in Settings (empty = built-in 4K).
    static func surfaceSource(_ choice: String, month: Int) -> (id: String, urls: [String]) {
        switch choice {
        case "bluemarble":
            let mm = String(format: "%02d", month)
            let dir = "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/\(blueMarbleIDs[month - 1])"
            return ("bluemarble-\(mm)", [
                "\(dir)/world.topo.bathy.2004\(mm).3x21600x10800.jpg",
                "\(dir)/world.topo.bathy.2004\(mm).3x5400x2700.jpg",
            ])
        case "builtin":
            return ("builtin", [])
        default:
            // Falls back to this month's NASA Blue Marble when Solar System Scope refuses.
            return ("sss", ["https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg"]
                    + surfaceSource("bluemarble", month: month).urls)
        }
    }

    private func ensureTextures(_ m: Manifest, force: Bool) async -> Bool {
        let s = settings()
        let earthWidth = s.quality == "high" ? 8192 : 4096
        var changed = false
        let data = Paths.data

        // Night lights and the Moon (once per quality level).
        let wanted = "v1-\(earthWidth)"
        if force || (m.d["texturesSet"] as? String) != wanted {
            var any = false
            // Solar System Scope textures (CC BY 4.0), based on NASA imagery.
            if await downloadFirst(["https://www.solarsystemscope.com/textures/download/8k_earth_nightmap.jpg",
                                    // NASA Black Marble 2016 (public domain) when Solar System Scope refuses.
                                    "https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg"],
                                   to: data.appendingPathComponent("earth_lights.jpg"), maxWidth: earthWidth, grayscale: true) { any = true }
            if await downloadFirst(["https://www.solarsystemscope.com/textures/download/2k_moon.jpg",
                                    "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg"],
                                   to: data.appendingPathComponent("moon.jpg"), maxWidth: 2048, grayscale: false) { any = true }
            if any {
                m.d["texturesSet"] = wanted
                changed = true
            }
        }

        // The Earth surface map chosen in Settings; each one is kept, so switching back is instant.
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let (id, urls) = DataService.surfaceSource(s.surfaceTexture, month: cal.component(.month, from: Date()))
        let key = "\(id)-\(earthWidth)"
        if force || (m.d["surfaceSet"] as? String) != key {
            var rel = ""
            if !urls.isEmpty {
                rel = "textures/\(key).jpg"
                let full = Paths.ensure(data.appendingPathComponent("textures", isDirectory: true)).appendingPathComponent("\(key).jpg")
                if !FileManager.default.fileExists(atPath: full.path) {
                    if !(await downloadFirst(urls, to: full, maxWidth: earthWidth, grayscale: false)) {
                        lastError = "Could not download the \"\(s.surfaceTexture)\" surface map; keeping the current one."
                        if changed { m.d["textures"] = DataService.iso(Date()) }
                        return changed
                    }
                }
            }
            m.d["surfaceSet"] = key
            m.d["dayTexture"] = rel
            changed = true
            Log.info("Surface map: \(rel.isEmpty ? "built-in" : rel)")
        }
        if changed { m.d["textures"] = DataService.iso(Date()) }
        return changed
    }

    private func downloadFirst(_ urls: [String], to path: URL, maxWidth: Int, grayscale: Bool) async -> Bool {
        for u in urls {
            do {
                guard let bytes = try await downloadImage(u, minBytes: 50_000) else { continue }
                try await DataService.saveImage(bytes, to: path, maxWidth: maxWidth, grayscale: grayscale)
                Log.info("Texture \(path.lastPathComponent) <- \(u) (\(bytes.count / 1024) KB)")
                return true
            } catch {
                Log.error("Texture \(path.lastPathComponent) from \(u)", error)
            }
        }
        return false
    }

    // MARK: clouds

    private func cloudURLs() -> [String] {
        let s = settings()
        var list: [String] = []
        let custom = s.customCloudUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !custom.isEmpty { list.append(custom) }
        let size = s.quality == "high" ? "8192x4096" : s.quality == "low" ? "2048x1024" : "4096x2048"
        // Matt Eason's live cloud maps: global composite of geostationary satellite
        // imagery (EUMETSAT / NOAA / JMA), refreshed several times a day.
        list.append("https://clouds.matteason.co.uk/images/\(size)/clouds.jpg")
        if size != "4096x2048" { list.append("https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg") }
        return list
    }

    private func updateClouds(_ m: Manifest) async -> Bool {
        let file = Paths.data.appendingPathComponent("clouds.jpg")
        for u in cloudURLs() {
            do {
                guard let bytes = try await downloadImage(u, minBytes: 30_000) else { continue }
                let hash = String(SHA256.hash(data: bytes).map { String(format: "%02X", $0) }.joined().prefix(16))
                if (m.d["cloudsHash"] as? String) == hash && FileManager.default.fileExists(atPath: file.path) {
                    if lastCloudUpdate == nil { lastCloudUpdate = Date() }
                    return false
                }
                // Re-encode as a grayscale JPEG capped at 8K.
                try await DataService.saveImage(bytes, to: file, maxWidth: 8192, grayscale: true)
                m.d["cloudsHash"] = hash
                m.d["clouds"] = DataService.iso(Date())
                m.d["cloudsFile"] = "clouds.jpg"
                m.d["cloudsSource"] = u
                await addToHistory(bytes, m)
                lastCloudUpdate = Date()
                Log.info("Clouds updated from \(u)")
                return true
            } catch {
                lastError = "Clouds: \(error.localizedDescription)"
                Log.error("Clouds from \(u)", error)
            }
        }
        return false
    }

    // MARK: 24 h history

    private static let historyWindow: TimeInterval = 26 * 3600

    /// Keeps every new cloud map for ~24 h (data/history) so time-lapse modes can
    /// replay the real last day of weather in a loop.
    private func addToHistory(_ bytes: Data, _ m: Manifest) async {
        do {
            let dir = Paths.ensure(Paths.data.appendingPathComponent("history", isDirectory: true))
            let now = Date()
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = "yyyyMMdd-HHmm"
            let name = "clouds-\(f.string(from: now)).jpg"
            try await DataService.saveImage(bytes, to: dir.appendingPathComponent(name), maxWidth: 4096, grayscale: true)
            var entries = readHistory(m)
            entries.removeAll { $0.file == "history/" + name }
            entries.append((file: "history/" + name, t: now))
            writeHistory(m, entries)
        } catch {
            Log.error("Cloud history", error)
        }
    }

    private func readHistory(_ m: Manifest) -> [(file: String, t: Date)] {
        guard let arr = m.d["history"] as? [[String: Any]] else { return [] }
        return arr.compactMap { e in
            guard let file = e["file"] as? String, let ts = e["t"] as? String, let t = DataService.parseISO(ts) else { return nil }
            return (file: file, t: t)
        }
    }

    private func writeHistory(_ m: Manifest, _ entries: [(file: String, t: Date)]) {
        let dir = Paths.ensure(Paths.data.appendingPathComponent("history", isDirectory: true))
        let cutoff = Date().addingTimeInterval(-DataService.historyWindow)
        let keep = entries
            .filter { $0.t >= cutoff && FileManager.default.fileExists(atPath: Paths.data.appendingPathComponent($0.file).path) }
            .sorted { $0.t < $1.t }
        // Delete anything no longer referenced.
        let keepNames = Set(keep.map { ($0.file as NSString).lastPathComponent })
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix("clouds-") && f.hasSuffix(".jpg") && !keepNames.contains(f) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f))
        }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        m.d["history"] = keep.map { ["t": f.string(from: $0.t), "file": $0.file] }
        historyCount = keep.count
        historyHours = keep.count >= 2 ? keep[keep.count - 1].t.timeIntervalSince(keep[0].t) / 3600 : 0
    }

    // MARK: storms

    private func updateStorms(_ m: Manifest) async -> Bool {
        var storms: [Storm] = []
        await addNHC(&storms)
        await addGDACS(&storms)
        let list: [[String: Any]] = storms.map {
            ["name": $0.name, "kind": $0.kind, "category": $0.category, "lat": $0.lat, "lon": $0.lon, "windKt": $0.windKt, "source": $0.source]
        }
        lastStormCount = storms.count
        let file = Paths.data.appendingPathComponent("storms.json")
        // Ignore the timestamp when comparing.
        let newKey = (try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys])) ?? Data()
        if let old = try? Data(contentsOf: file),
           let obj = try? JSONSerialization.jsonObject(with: old) as? [String: Any],
           let oldList = obj["storms"],
           let oldKey = try? JSONSerialization.data(withJSONObject: oldList, options: [.sortedKeys]),
           oldKey == newKey {
            return false
        }
        let doc: [String: Any] = ["updated": DataService.iso(Date()), "storms": list]
        guard let json = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]) else { return false }
        try? json.write(to: file, options: .atomic)
        m.d["storms"] = DataService.iso(Date())
        return true
    }

    private func getJSON(_ url: String) async throws -> Any? {
        guard let u = URL(string: url) else { return nil }
        let (data, resp) = try await session.data(from: u)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return try JSONSerialization.jsonObject(with: data)
    }

    // US National Hurricane Center: Atlantic, East and Central Pacific.
    private func addNHC(_ storms: inout [Storm]) async {
        do {
            guard let root = try await getJSON("https://www.nhc.noaa.gov/CurrentStorms.json") as? [String: Any],
                  let arr = root["activeStorms"] as? [[String: Any]] else { return }
            for n in arr {
                let name = (n["name"] as? String) ?? ""
                guard let lat = DataService.num(n["latitudeNumeric"]), let lon = DataService.num(n["longitudeNumeric"]) else { continue }
                let wind = DataService.num(n["intensity"]) ?? 0
                let cls = (n["classification"] as? String) ?? ""
                storms.append(DataService.classify(name, lat, lon, wind, "NHC", cls))
            }
        } catch {
            Log.error("NHC storms", error)
        }
    }

    // GDACS (EU JRC / UN OCHA): tropical cyclones worldwide.
    private func addGDACS(_ storms: inout [Storm]) async {
        do {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = "yyyy-MM-dd"
            let from = f.string(from: Date().addingTimeInterval(-4 * 86400))
            let to = f.string(from: Date().addingTimeInterval(86400))
            let url = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate=\(from)&todate=\(to)&alertlevel=green;orange;red"
            guard let root = try await getJSON(url) as? [String: Any], let arr = root["features"] as? [[String: Any]] else { return }
            for feature in arr {
                guard let p = feature["properties"] as? [String: Any] else { continue }
                if let cur = p["iscurrent"] {
                    let isCurrent = (cur as? Bool) ?? ((cur as? String)?.lowercased() == "true")
                    if !isCurrent { continue }
                }
                var name = (p["eventname"] as? String) ?? (p["name"] as? String) ?? ""
                if let dash = name.lastIndex(of: "-"), dash > name.startIndex, Int(name[name.index(after: dash)...]) != nil {
                    name = String(name[..<dash])   // "MILTON-24" -> "MILTON"
                }
                name = name.replacingOccurrences(of: "Tropical Cyclone ", with: "", options: .caseInsensitive).trimmingCharacters(in: .whitespaces)
                if storms.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) { continue }
                guard let geometry = feature["geometry"] as? [String: Any], let coords = geometry["coordinates"] as? [Any], coords.count >= 2,
                      let lon = DataService.num(coords[0]), let lat = DataService.num(coords[1]) else { continue }
                var wind = 0.0
                if let sev = p["severitydata"] as? [String: Any], let v = DataService.num(sev["severity"]) {
                    let unit = (sev["severityunit"] as? String) ?? "km/h"
                    wind = unit.lowercased().contains("km") ? v / 1.852 : v
                }
                storms.append(DataService.classify(DataService.title(name), lat, lon, wind, "GDACS", ""))
            }
        } catch {
            Log.error("GDACS storms", error)
        }
    }

    private static func classify(_ name: String, _ lat: Double, _ lon: Double, _ windKt: Double, _ source: String, _ nhcClass: String) -> Storm {
        let kind: String
        switch nhcClass {
        case "TD": kind = "Tropical Depression"
        case "STD", "STS": kind = "Subtropical Storm"
        case "PTC": kind = "Potential Tropical Cyclone"
        case "PC": kind = "Post-tropical Cyclone"
        default:
            if windKt >= 64 {
                let nwPacific = lat > 0 && lon >= 100 && lon <= 180
                let hurricaneBasin = lat > 0 && lon < -20 && lon > -180
                kind = nwPacific ? "Typhoon" : hurricaneBasin ? "Hurricane" : "Cyclone"
            } else if windKt >= 34 {
                kind = "Tropical Storm"
            } else {
                kind = windKt > 0 ? "Tropical Depression" : "Storm"
            }
        }
        let category = windKt >= 137 ? "Cat 5" : windKt >= 113 ? "Cat 4" : windKt >= 96 ? "Cat 3" : windKt >= 83 ? "Cat 2" : windKt >= 64 ? "Cat 1" : ""
        return Storm(name: title(name), kind: kind, category: category, lat: lat, lon: lon, windKt: windKt.rounded(), source: source)
    }

    private static func title(_ s: String) -> String { s.lowercased().capitalized(with: Locale(identifier: "en_US_POSIX")) }

    private static func num(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue.isFinite ? n.doubleValue : nil }
        if let s = v as? String, let d = Double(s.trimmingCharacters(in: .whitespaces)) { return d }
        return nil
    }

    // MARK: helpers

    private func downloadImage(_ s: String, minBytes: Int) async throws -> Data? {
        guard let url = URL(string: s) else { return nil }
        var req = URLRequest(url: url)
        // Solar System Scope answers direct downloads with a small HTML page unless
        // the request looks like it came from its texture page.
        if url.host?.hasSuffix("solarsystemscope.com") == true {
            req.setValue("https://www.solarsystemscope.com/textures/", forHTTPHeaderField: "Referer")
            req.setValue("image/avif,image/webp,image/jpeg,image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
        }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { return nil }
        if data.count < minBytes, let body = String(data: data.prefix(300), encoding: .utf8) {
            Log.info("\(s) -> \(http.statusCode), body: \(body.replacingOccurrences(of: "\n", with: " "))")
        }
        if !(200..<300).contains(http.statusCode) {
            Log.info("\(s) -> HTTP \(http.statusCode)")
            return nil
        }
        let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "")
            .split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        if data.count < minBytes || (!type.isEmpty && !type.hasPrefix("image/") && type != "application/octet-stream") {
            Log.info("\(s) -> unexpected content (\(type), \(data.count) bytes)")
            return nil
        }
        return data
    }

    /// Decodes, optionally downsizes / converts to grayscale, and saves as JPEG (off the main thread).
    nonisolated static func saveImage(_ bytes: Data, to path: URL, maxWidth: Int, grayscale: Bool) async throws {
        try await Task.detached(priority: .utility) {
            try ImageTools.save(bytes, to: path, maxWidth: maxWidth, grayscale: grayscale)
        }.value
    }

    private var manifestURL: URL { Paths.data.appendingPathComponent("manifest.json") }

    private func readManifest() -> [String: Any] {
        guard let data = try? Data(contentsOf: manifestURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    private func writeManifest(_ m: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: m, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: manifestURL, options: .atomic)
    }

    static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

/// ImageIO helpers: JPEGs are scaled while decoding, so a 21600 px NASA map
/// never needs a full-size bitmap in memory.
enum ImageTools {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func save(_ bytes: Data, to path: URL, maxWidth: Int, grayscale: Bool) throws {
        guard let src = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw Failure(description: "cannot decode image")
        }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let w = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        let h = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        var image: CGImage?
        if w > maxWidth && w > 0 {
            let maxDim = Int((Double(max(w, h)) * Double(maxWidth) / Double(w)).rounded())
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxDim,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
        } else {
            image = CGImageSourceCreateImageAtIndex(src, 0, nil)
        }
        guard var img = image else { throw Failure(description: "cannot decode image (\(w)x\(h))") }
        if grayscale { img = try toGray(img) }

        let tmp = URL(fileURLWithPath: path.path + ".part")
        guard let dest = CGImageDestinationCreateWithURL(tmp as CFURL, "public.jpeg" as CFString, 1, nil) else {
            throw Failure(description: "cannot create \(tmp.lastPathComponent)")
        }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw Failure(description: "cannot encode JPEG") }
        if rename(tmp.path, path.path) != 0 { throw Failure(description: "cannot replace \(path.lastPathComponent) (errno \(errno))") }
    }

    private static func toGray(_ img: CGImage) throws -> CGImage {
        guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
            throw Failure(description: "cannot create grayscale context")
        }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        guard let out = ctx.makeImage() else { throw Failure(description: "cannot convert to grayscale") }
        return out
    }
}
