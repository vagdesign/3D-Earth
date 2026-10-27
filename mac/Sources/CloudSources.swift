import Foundation
import CoreGraphics
import ImageIO

/// One cloud map source from sources.json, tried in order.
struct CloudSource {
    let id, name, type, url: String
    let sizes: [String]
    let status: String?
    let maxAgeHours, timeoutSeconds: Double
    let raw: [String: Any]
}

/// The data-source list every installation reads (sources/sources.json in the repo,
/// published on the data site). Editing it switches sources for all installations
/// without an app release. Order: the locations named by the last copy we got
/// (manifestUrls, so the file can move), the built-in locations, the cached copy,
/// the copy shipped with the app. Same logic as the Windows SourceList.
enum SourceList {
    private static let builtInURLs = [
        "https://vagdesign.github.io/3D-Earth/sources.json",
        "https://raw.githubusercontent.com/vagdesign/3D-Earth/main/sources/sources.json",
    ]
    private(set) static var origin = ""

    private static var cacheURL: URL { Paths.data.appendingPathComponent("sources.json") }
    private static var bundledURL: URL? { Bundle.main.url(forResource: "sources", withExtension: "json") }

    static func load(_ session: URLSession) async -> [String: Any] {
        let cached = parse(try? Data(contentsOf: cacheURL))
        var urls = ((cached?["manifestUrls"] as? [String]) ?? []).filter { $0.hasPrefix("https://") }
        urls += builtInURLs
        var seen = Set<String>()
        for u in urls where seen.insert(u).inserted {
            guard let url = URL(string: u) else { continue }
            var req = URLRequest(url: url)
            req.timeoutInterval = 8
            do {
                let (data, resp) = try await session.data(for: req)
                guard (resp as? HTTPURLResponse)?.statusCode == 200, let obj = parse(data) else {
                    Log.info("Sources \(u): not a valid source list")
                    continue
                }
                try? data.write(to: cacheURL, options: .atomic)
                origin = u
                return obj
            } catch {
                Log.info("Sources \(u): \(error.localizedDescription)")
            }
        }
        if let cached { origin = "cached copy"; return cached }
        origin = "built-in copy"
        return parse(bundledURL.flatMap { try? Data(contentsOf: $0) }) ?? [:]
    }

    private static func parse(_ data: Data?) -> [String: Any]? {
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["schema"] as? Int) == 1, obj["clouds"] is [Any] else { return nil }
        return obj
    }

    static func clouds(_ list: [String: Any]) -> [CloudSource] {
        ((list["clouds"] as? [[String: Any]]) ?? []).compactMap { o in
            guard let id = o["id"] as? String, !id.isEmpty, let url = o["url"] as? String, url.hasPrefix("https://") else { return nil }
            let type = o["type"] as? String ?? "image"
            guard type == "image" || type == "wms-ir" else { return nil }      // unknown to this version: skip
            return CloudSource(id: id, name: o["name"] as? String ?? id, type: type, url: url,
                               sizes: o["sizes"] as? [String] ?? [], status: o["status"] as? String,
                               maxAgeHours: num(o, "maxAgeHours", 9),
                               timeoutSeconds: min(120, max(2, num(o, "timeoutSeconds", 8))), raw: o)
        }
    }

    static func num(_ o: [String: Any], _ key: String, _ fallback: Double) -> Double {
        (o[key] as? NSNumber)?.doubleValue ?? fallback
    }

    /// The wanted size if offered, else the largest smaller one, else the smallest.
    static func pickSize(_ sizes: [String], _ wanted: String) -> String {
        if sizes.isEmpty || sizes.contains(wanted) { return wanted }
        func width(_ s: String) -> Int { Int(s.split(separator: "x").first ?? "") ?? 0 }
        let want = width(wanted)
        return sizes.filter { width($0) <= want }.max { width($0) < width($1) }
            ?? sizes.min { width($0) < width($1) }!
    }

    /// Last-resort source: EUMETSAT's infrared world cloud map, fetched as two
    /// hemispheres, joined and turned into a greyscale cloud map here.
    @MainActor static func buildWmsIr(_ src: CloudSource, size: String,
                           download: (String, TimeInterval) async throws -> Data?) async throws -> Data? {
        guard let h = Int(size.split(separator: "x").last ?? ""), h > 0 else { return nil }
        var gray = [UInt8](repeating: 0, count: 2 * h * h)
        for (k, bbox) in ["-90,-180,90,0", "-90,0,90,180"].enumerated() {
            let u = src.url.replacingOccurrences(of: "{bbox}", with: bbox).replacingOccurrences(of: "{half}", with: "\(h)")
            guard let png = try await download(u, src.timeoutSeconds), let half = decodeGray(png, size: h) else { return nil }
            for y in 0..<h {
                gray.replaceSubrange((y * 2 * h + k * h)..<(y * 2 * h + k * h + h), with: half[(y * h)..<(y * h + h)])
            }
        }

        // Same curve as the full cloud service, without the dust/visible layers.
        let levels = (src.raw["levels"] as? [NSNumber])?.map(\.doubleValue)
        let lo = levels?.count == 2 ? levels![0] : 72, hi = levels?.count == 2 ? levels![1] : 178
        let g1 = num(src.raw, "gamma", 1.46), gain = num(src.raw, "gain", 0.77), g2 = num(src.raw, "gamma2", 2.0)
        var lut = [UInt8](repeating: 0, count: 256)
        for v in 0..<250 {                                    // >= 250: no data (antimeridian, poles)
            let t = min(1, max(0, (Double(v) - lo) / (hi - lo)))
            let o = pow(pow(t, 1 / g1) * gain, 1 / g2)
            lut[v] = UInt8((min(1, max(0, o)) * 255).rounded())
        }
        var lit = 0
        for i in gray.indices { gray[i] = lut[Int(gray[i])]; if gray[i] > 40 { lit += 1 } }
        if lit < gray.count / 200 { throw NSError(domain: "3DEarth", code: 1, userInfo: [NSLocalizedDescriptionKey: "EUMETSAT infrared map is blank"]) }

        guard let provider = CGDataProvider(data: Data(gray) as CFData),
              let image = CGImage(width: 2 * h, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: 2 * h,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    private static func decodeGray(_ data: Data, size: Int) -> [UInt8]? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        var buf = [UInt8](repeating: 0, count: size * size)
        let ok = buf.withUnsafeMutableBytes { ptr -> Bool in
            guard let ctx = CGContext(data: ptr.baseAddress, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: size, height: size))
            return true
        }
        return ok ? buf : nil
    }
}
