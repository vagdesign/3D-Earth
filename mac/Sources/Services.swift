import AppKit
import IOKit.ps
import ServiceManagement

#if !APPSTORE
/// Checks this repository's GitHub Releases for a newer macOS build. The Mac app
/// does not replace itself: it tells you and opens the release page.
/// Not part of the Mac App Store build: the App Store delivers its updates.
@MainActor
final class UpdateService: NSObject {
    struct Release {
        let version: String
        let tag: String
        let name: String
        let pageURL: URL
        let assetURL: URL?
    }

    private(set) var available: Release?
    private(set) var lastCheck: Date?
    private(set) var lastError = ""
    var onAvailable: ((Release) -> Void)?
    private var timer: Timer?

    /// Automatic checks: shortly after start, then every 12 hours.
    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(timeInterval: 12 * 3600, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        perform(#selector(tick), with: nil, afterDelay: 120)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(tick), object: nil)
    }

    @objc private func tick() { Task { @MainActor in _ = await self.check() } }

    static func compare(_ a: String, _ b: String) -> Int {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }, pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        return 0
    }

    func check() async -> Release? {
        do {
            var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(AppInfo.feedRepo)/releases/latest")!)
            req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            req.setValue("3DEarth-mac/\(AppInfo.version)", forHTTPHeaderField: "User-Agent")
            req.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, resp) = try await URLSession.shared.data(for: req)
            lastCheck = Date()
            guard let http = resp as? HTTPURLResponse else { return nil }
            if http.statusCode == 404 { lastError = "No public release feed found."; return nil }
            guard (200..<300).contains(http.statusCode),
                  let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                lastError = "Update check failed (HTTP \(http.statusCode))."
                return nil
            }
            let tag = (root["tag_name"] as? String) ?? ""
            let version = tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            let assets = (root["assets"] as? [[String: Any]]) ?? []
            let mac = assets.first { a in
                let n = (a["name"] as? String) ?? ""
                return n.hasPrefix("3D-Earth-mac-") && (n.hasSuffix(".zip") || n.hasSuffix(".dmg"))
            }
            lastError = ""
            guard !version.isEmpty, UpdateService.compare(version, AppInfo.version) > 0, let asset = mac else {
                available = nil
                return nil
            }
            let page = URL(string: (root["html_url"] as? String) ?? "") ?? URL(string: "https://github.com/\(AppInfo.feedRepo)/releases/latest")!
            let r = Release(version: version, tag: tag, name: (root["name"] as? String) ?? tag, pageURL: page,
                            assetURL: URL(string: (asset["browser_download_url"] as? String) ?? ""))
            let isNew = available?.version != r.version
            available = r
            Log.info("Update available: \(r.version) (current \(AppInfo.version))")
            if isNew { onAvailable?(r) }
            return r
        } catch {
            lastError = "Update check failed: \(error.localizedDescription)"
            Log.error("Update check", error)
            return nil
        }
    }
}

#endif

/// Power state used for power saving.
enum Power {
    /// True when running on battery.
    static var onBattery: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return (type as String) == "Battery Power"
    }
}

/// "Open at login" through SMAppService (macOS 13+): no helper app, no launch agent file.
enum LoginItem {
    static var status: SMAppService.Status { SMAppService.mainApp.status }
    static var isEnabled: Bool { status == .enabled }

    static func set(_ on: Bool) {
        do {
            if on {
                if status != .enabled { try SMAppService.mainApp.register() }
                if status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            } else if status == .enabled || status == .requiresApproval {
                try SMAppService.mainApp.unregister()
            }
            Log.info("Open at login: \(on) (status \(status.rawValue))")
        } catch {
            Log.error("Open at login", error)
        }
    }
}
