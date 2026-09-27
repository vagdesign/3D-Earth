import AppKit
import WebKit

/// Application core: menu bar item, one wallpaper window per display, a watchdog
/// that follows display changes, sleep/wake and power saving, and the
/// weather/texture downloader. The macOS counterpart of TrayContext.cs.
@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private static var retained: AppDelegate?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        retained = delegate
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // menu bar only (LSUIElement), no Dock icon
        app.run()
    }

    private var settings = AppSettings()
    private var statusItem: NSStatusItem?
    private var windows: [CGDirectDisplayID: WallpaperWindow] = [:]
    private var preview: PreviewWindow?
    private var settingsController: SettingsWindowController?
    private var welcome: NSPanel?
    private let data = DataService()
    private let updates = UpdateService()
    private var watchdog: Timer?

    private var userPaused = false
    private var sessionLocked = false
    private var screensAsleep = false
    private var systemAsleep = false
    private var screenSaverRunning = false
    private var sessionInactive = false

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: AppInfo.bundleID)
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty && !AppInfo.hasArg("--allow-multiple") {
            // Already running: ask the running copy to open its settings window.
            DistributedNotificationCenter.default().postNotificationName(AppInfo.showSettingsNotification, object: nil, userInfo: nil, deliverImmediately: true)
            NSApp.terminate(nil)
            return
        }

        settings = AppSettings.load()
        Log.info("Starting 3D Earth \(AppInfo.version) (\(archName())) on macOS \(ProcessInfo.processInfo.operatingSystemVersionString); " +
                 "screens: \(NSScreen.screens.map { "\($0.frame) @\($0.backingScaleFactor)x" }.joined(separator: ", "))")

        buildStatusItem()
        observeSystem()

        data.settings = { [weak self] in self?.settings ?? AppSettings() }
        data.onChanged = { [weak self] in self?.dataChanged() }
        updates.onAvailable = { [weak self] r in self?.updateAvailable(r) }

        syncWindows()
        watchdog = Timer.scheduledTimer(timeInterval: 3, target: self, selector: #selector(watchdogTick), userInfo: nil, repeats: true)
        data.start()
        if settings.autoCheckUpdates { updates.start() }

        if !settings.firstRunDone {
            settings.firstRunDone = true
            settings.save()
            if !AppInfo.hasArg("--no-welcome") { showWelcome() }
        }
        if AppInfo.hasArg("--settings") { showSettings() }
        if AppInfo.hasArg("--preview") { showPreview(fullscreen: false) }
        if let path = AppInfo.argValue("--snapshot") {
            let delay = Double(AppInfo.argValue("--snapshot-delay") ?? "") ?? 20
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                self?.snapshot(to: path)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Opening the app again (Finder, Spotlight) shows the settings.
        showSettings()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        closeWallpapers()
    }

    private func archName() -> String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    // MARK: system events

    private func observeSystem() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)

        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(self, selector: #selector(willSleep), name: NSWorkspace.willSleepNotification, object: nil)
        ws.addObserver(self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)
        ws.addObserver(self, selector: #selector(screensDidSleep), name: NSWorkspace.screensDidSleepNotification, object: nil)
        ws.addObserver(self, selector: #selector(screensDidWake), name: NSWorkspace.screensDidWakeNotification, object: nil)
        ws.addObserver(self, selector: #selector(sessionResigned), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        ws.addObserver(self, selector: #selector(sessionActivated), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)

        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(self, selector: #selector(screenLocked), name: Notification.Name("com.apple.screenIsLocked"), object: nil)
        dnc.addObserver(self, selector: #selector(screenUnlocked), name: Notification.Name("com.apple.screenIsUnlocked"), object: nil)
        dnc.addObserver(self, selector: #selector(screenSaverStarted), name: Notification.Name("com.apple.screensaver.didstart"), object: nil)
        dnc.addObserver(self, selector: #selector(screenSaverStopped), name: Notification.Name("com.apple.screensaver.didstop"), object: nil)
        dnc.addObserver(self, selector: #selector(showSettingsRequested), name: AppInfo.showSettingsNotification, object: nil)
    }

    @objc private func screensChanged() {
        Log.info("Display configuration changed: \(NSScreen.screens.map { "\($0.frame)" }.joined(separator: ", "))")
        scheduleSync()
    }

    @objc private func willSleep() { systemAsleep = true; updatePause() }

    @objc private func didWake() {
        Log.info("System woke up")
        systemAsleep = false
        scheduleSync()
        data.refresh()
        updatePause()
    }

    @objc private func screensDidSleep() { screensAsleep = true; updatePause() }
    @objc private func screensDidWake() { screensAsleep = false; scheduleSync(); updatePause() }
    @objc private func sessionResigned() { sessionInactive = true; updatePause() }
    @objc private func sessionActivated() { sessionInactive = false; scheduleSync(); updatePause() }
    @objc private func screenLocked() { sessionLocked = true; updatePause() }
    @objc private func screenUnlocked() { sessionLocked = false; updatePause() }
    @objc private func screenSaverStarted() { screenSaverRunning = true; updatePause() }
    @objc private func screenSaverStopped() { screenSaverRunning = false; updatePause() }
    @objc private func showSettingsRequested() { showSettings() }
    @objc private func occlusionChanged(_ n: Notification) { updatePause() }

    // MARK: wallpaper windows

    private func scheduleSync() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(syncWindows), object: nil)
        perform(#selector(syncWindows), with: nil, afterDelay: 1.5)
    }

    private func wantedScreens() -> [CGDirectDisplayID: NSScreen] {
        let screens = settings.monitors == "primary" ? Array(NSScreen.screens.prefix(1)) : NSScreen.screens
        var out: [CGDirectDisplayID: NSScreen] = [:]
        for s in screens { if let id = s.displayID { out[id] = s } }
        return out
    }

    /// Keeps exactly one wallpaper window per wanted display, each covering it.
    @objc private func syncWindows() {
        let wanted = wantedScreens()
        for (id, w) in windows where wanted[id] == nil {
            Log.info("Removing wallpaper from display \(id)")
            NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: w)
            w.teardown()
            windows[id] = nil
        }
        for (id, screen) in wanted {
            if let w = windows[id] {
                w.place(on: screen)
                continue
            }
            let w = WallpaperWindow(screen: screen, displayID: id)
            w.scene.settingsProvider = { [weak self] in self?.settings ?? AppSettings() }
            windows[id] = w
            NotificationCenter.default.addObserver(self, selector: #selector(occlusionChanged(_:)),
                                                   name: NSWindow.didChangeOcclusionStateNotification, object: w)
            w.orderFront(nil)
            w.scene.load()
            Log.info("Wallpaper window \(w.windowNumber) on display \(id): frame \(w.frame), level \(w.level.rawValue)")
        }
        updatePause()
    }

    private func closeWallpapers() {
        for w in windows.values {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: w)
            w.teardown()
        }
        windows.removeAll()
    }

    @objc private func watchdogTick() {
        // A display appeared/disappeared or changed size without a notification.
        let wanted = wantedScreens()
        let mismatch = Set(wanted.keys) != Set(windows.keys) ||
            windows.contains { id, w in wanted[id].map { $0.frame != w.frame } ?? true } ||
            windows.values.contains { !$0.isVisible }
        if mismatch { syncWindows() } else { updatePause() }
    }

    private func updatePause() {
        let global = userPaused || sessionLocked || screensAsleep || systemAsleep || screenSaverRunning || sessionInactive ||
            (settings.pauseOnBattery && Power.onBattery)
        for w in windows.values {
            let covered = settings.pauseWhenCovered && w.isCovered
            w.scene.setPaused(global || covered)
        }
    }

    private func dataChanged() {
        windows.values.forEach { $0.scene.notifyDataChanged() }
        preview?.scene.notifyDataChanged()
    }

    // MARK: settings

    private func applySettings(_ s: AppSettings) {
        let old = settings
        settings = s
        settings.save()
        if s.autoCheckUpdates { updates.start() } else { updates.stop() }
        if s.monitors != old.monitors { syncWindows() }
        windows.values.forEach { $0.scene.sendSettings(s) }
        preview?.scene.sendSettings(s)
        if s.quality != old.quality { data.refresh(forceTextures: true) }
        else if s.surfaceTexture != old.surfaceTexture { data.refresh() }
        else if s.weatherRefreshMinutes != old.weatherRefreshMinutes || s.customCloudUrl != old.customCloudUrl { data.reschedule() }
        updatePause()
    }

    private func change(_ edit: (inout AppSettings) -> Void) {
        var s = settings
        edit(&s)
        applySettings(s)
    }

    @objc func showSettings() {
        if let c = settingsController {
            NSApp.activate(ignoringOtherApps: true)
            c.window?.makeKeyAndOrderFront(nil)
            return
        }
        let model = SettingsModel(
            current: settings,
            apply: { [weak self] s in self?.applySettings(s) },
            statusText: { [weak self] in self?.statusText() ?? "" },
            refreshWeather: { [weak self] in self?.data.refresh() },
            checkUpdates: { [weak self] in self?.checkForUpdatesInteractive() })
        let c = SettingsWindowController(model: model)
        c.onClose = { [weak self] in self?.settingsController = nil }
        settingsController = c
        NSApp.activate(ignoringOtherApps: true)
        c.showWindow(nil)
        c.window?.makeKeyAndOrderFront(nil)
    }

    private func statusText() -> String {
        var parts = ["Showing on \(windows.count) display(s)."]
        let tf = DateFormatter()
        tf.timeStyle = .short
        parts.append(data.lastCloudUpdate.map { "Clouds updated \(tf.string(from: $0))." } ?? "Clouds: waiting for the first download.")
        parts.append("Active tropical storms: \(data.lastStormCount).")
        parts.append(String(format: "Cloud history: %d map(s) over %.1f h (the 24 h loop needs about an hour or more).", data.historyCount, data.historyHours))
        if let up = updates.available {
            parts.append("Update \(up.version) available.")
        } else if let lc = updates.lastCheck {
            parts.append("Version \(AppInfo.version) is up to date (checked \(tf.string(from: lc))).")
        } else {
            parts.append("Version \(AppInfo.version).")
        }
        if windows.values.contains(where: { $0.scene.paused }) { parts.append("Paused (power saving) on \(windows.values.filter { $0.scene.paused }.count) display(s).") }
        if !data.lastError.isEmpty { parts.append("Last error: \(data.lastError)") }
        if !updates.lastError.isEmpty { parts.append(updates.lastError) }
        return parts.joined(separator: " ")
    }

    // MARK: preview / explore

    private func showPreview(fullscreen: Bool) {
        preview?.close()
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        let w = PreviewWindow(screen: screen, fullscreen: fullscreen)
        w.delegate = self
        w.scene.settingsProvider = { [weak self] in self?.settings ?? AppSettings() }
        w.scene.onClose = { [weak w] in w?.close() }
        preview = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        w.makeFirstResponder(w.scene.webView)
        w.scene.load()
    }

    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? PreviewWindow, w === preview else { return }
        w.scene.teardown()
        preview = nil
    }

    // MARK: updates

    private func updateAvailable(_ r: UpdateService.Release) {
        updateItem?.title = "Download update \(r.version)…"
    }

    private func checkForUpdatesInteractive() {
        Task { @MainActor in
            let r = await self.updates.check()
            let a = NSAlert()
            a.messageText = "3D Earth"
            if let r = r {
                a.informativeText = "Version \(r.version) is available (you have \(AppInfo.version)).\n\nOpen the download page? Download the Mac .zip, unzip it and drag 3D Earth to Applications, replacing this version. Your settings are kept."
                a.addButton(withTitle: "Open download page")
                a.addButton(withTitle: "Later")
                NSApp.activate(ignoringOtherApps: true)
                if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(r.pageURL) }
            } else {
                a.informativeText = self.updates.lastError.isEmpty ? "You have the latest version (\(AppInfo.version))." : self.updates.lastError
                NSApp.activate(ignoringOtherApps: true)
                a.runModal()
            }
        }
    }

    // MARK: menu bar

    private var viewItems: [String: NSMenuItem] = [:]
    private var motionItems: [String: NSMenuItem] = [:]
    private var labelsItem: NSMenuItem?
    private var stormsItem: NSMenuItem?
    private var pauseItem: NSMenuItem?
    private var loginItem: NSMenuItem?
    private var updateItem: NSMenuItem?

    private func item(_ title: String, _ action: Selector?, key: String = "", tag: String? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        if let tag = tag { i.representedObject = tag }
        return i
    }

    private func buildStatusItem() {
        let si = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = si.button {
            let img = NSImage(systemSymbolName: "globe.europe.africa.fill", accessibilityDescription: "3D Earth")
            img?.isTemplate = true
            button.image = img
            button.toolTip = "3D Earth"
        }
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false

        let title = NSMenuItem(title: "3D Earth", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        let view = NSMenu()
        for (tag, name) in [("moon", "Moon beside the Earth"), ("home", "Above my location"), ("sunrise", "Sunrise behind the Earth")] {
            let i = item(name, #selector(setViewFromMenu(_:)), tag: tag)
            viewItems[tag] = i
            view.addItem(i)
        }
        let viewRoot = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewRoot.submenu = view
        menu.addItem(viewRoot)

        let motion = NSMenu()
        for (tag, name) in [("live", "Real time"), ("spin", "Spin 360° from my location"), ("timelapse", "Time-lapse"),
                            ("daylapse", "Day & night time-lapse above my location")] {
            let i = item(name, #selector(setMotionFromMenu(_:)), tag: tag)
            motionItems[tag] = i
            motion.addItem(i)
        }
        let motionRoot = NSMenuItem(title: "Motion", action: nil, keyEquivalent: "")
        motionRoot.submenu = motion
        menu.addItem(motionRoot)

        menu.addItem(item("Explore (full screen, Esc to exit)", #selector(explore)))
        menu.addItem(item("Open in a window", #selector(openWindow)))
        menu.addItem(.separator())
        labelsItem = item("Moon and planet labels", #selector(toggleLabels))
        stormsItem = item("Storm labels", #selector(toggleStorms))
        menu.addItem(labelsItem!)
        menu.addItem(stormsItem!)
        menu.addItem(item("Update weather now", #selector(updateWeather)))
        menu.addItem(.separator())
        pauseItem = item("Pause", #selector(togglePause))
        menu.addItem(pauseItem!)
        loginItem = item("Open at login", #selector(toggleLogin))
        menu.addItem(loginItem!)
        menu.addItem(item("Settings…", #selector(showSettings), key: ","))

        let trouble = NSMenu()
        trouble.addItem(item("Preview in a window", #selector(openWindow)))
        trouble.addItem(item("Re-attach to the desktop", #selector(reattach)))
        trouble.addItem(item("Open log file", #selector(openLog)))
        trouble.addItem(item("Open data folder", #selector(openData)))
        let troubleRoot = NSMenuItem(title: "Troubleshooting", action: nil, keyEquivalent: "")
        troubleRoot.submenu = trouble
        menu.addItem(troubleRoot)
        updateItem = item("Check for updates…", #selector(updateMenuClicked))
        menu.addItem(updateItem!)
        menu.addItem(item("About 3D Earth", #selector(showAbout)))
        menu.addItem(.separator())
        menu.addItem(item("Stop wallpaper & quit", #selector(quit), key: "q"))
        si.menu = menu
        statusItem = si
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        for (tag, i) in viewItems { i.state = settings.view == tag ? .on : .off }
        for (tag, i) in motionItems { i.state = settings.motion == tag ? .on : .off }
        labelsItem?.state = settings.labels ? .on : .off
        stormsItem?.state = settings.storms ? .on : .off
        pauseItem?.state = userPaused ? .on : .off
        loginItem?.state = LoginItem.isEnabled ? .on : (LoginItem.status == .requiresApproval ? .mixed : .off)
    }

    @objc private func setViewFromMenu(_ sender: NSMenuItem) {
        guard let v = sender.representedObject as? String else { return }
        change { $0.view = v }
    }

    @objc private func setMotionFromMenu(_ sender: NSMenuItem) {
        guard let v = sender.representedObject as? String else { return }
        change { $0.motion = v }
    }

    @objc private func explore() { showPreview(fullscreen: true) }
    @objc private func openWindow() { showPreview(fullscreen: false) }
    @objc private func toggleLabels() { change { $0.labels.toggle() } }
    @objc private func toggleStorms() { change { $0.storms.toggle() } }
    @objc private func updateWeather() { data.refresh() }
    @objc private func togglePause() { userPaused.toggle(); updatePause() }
    @objc private func toggleLogin() { LoginItem.set(!LoginItem.isEnabled) }
    @objc private func openLog() { NSWorkspace.shared.open(Paths.logFile) }
    @objc private func openData() { NSWorkspace.shared.open(Paths.data) }

    @objc private func reattach() {
        closeWallpapers()
        syncWindows()
    }

    @objc private func updateMenuClicked() {
        if let r = updates.available { NSWorkspace.shared.open(r.pageURL); return }
        checkForUpdatesInteractive()
    }

    @objc private func quit() {
        closeWallpapers()
        NSApp.terminate(nil)
    }

    @objc private func showAbout() {
        let html = """
        <div style="font-family: -apple-system, 'Helvetica Neue'; font-size: 11px; text-align: center; color: #888">
        Live 3D Earth wallpaper: current clouds, storms, true day and night, the Moon and planets.<br><br>
        Created by <a href="https://www.ax-easy.com">Vangelis Makridakis</a> &amp; <a href="https://claude.ai">Claude</a>
        · by <a href="https://www.ax-easy.com">Ax-Easy</a><br><br>
        <b>Data &amp; imagery</b><br>
        Live cloud maps by Matt Eason (EUMETSAT / NOAA / JMA imagery)<br>
        Storms: NOAA National Hurricane Center and GDACS (EC JRC / UN OCHA)<br>
        Earth, night lights and Moon: Solar System Scope (CC BY 4.0)<br>
        NASA Blue Marble Next Generation and Earth at Night (public domain)<br>
        Milky Way: ESO/S. Brunier (CC BY 4.0)<br>
        Stars: d3-celestial / Yale Bright Star Catalogue (BSD 3-Clause)<br>
        three.js (MIT) · Astronomy Engine by Don Cross (MIT)<br><br>
        <a href="https://github.com/\(AppInfo.feedRepo)">github.com/\(AppInfo.feedRepo)</a>
        </div>
        """
        var options: [NSApplication.AboutPanelOptionKey: Any] = [
            .applicationName: "3D Earth",
            .applicationVersion: AppInfo.version,
            .version: "",
            NSApplication.AboutPanelOptionKey(rawValue: "Copyright"): AppInfo.copyright,
        ]
        if let credits = try? NSAttributedString(data: Data(html.utf8),
                                                 options: [.documentType: NSAttributedString.DocumentType.html,
                                                           .characterEncoding: String.Encoding.utf8.rawValue],
                                                 documentAttributes: nil) {
            options[.credits] = credits
        }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: options)
    }

    // MARK: first run

    private func showWelcome() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 150), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "3D Earth"
        panel.isReleasedWhenClosed = false
        let text = NSTextField(wrappingLabelWithString: "Your live Earth wallpaper is running.\n\nClick the globe in the menu bar for views, settings and Open at login.")
        let ok = NSButton(title: "OK", target: panel, action: #selector(NSWindow.performClose(_:)))
        ok.keyEquivalent = "\r"
        let open = NSButton(title: "Open Settings", target: self, action: #selector(welcomeOpenSettings))
        let buttons = NSStackView(views: [open, ok])
        buttons.spacing = 8
        let stack = NSStackView(views: [text, buttons])
        stack.orientation = .vertical
        stack.alignment = .trailing
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 16, right: 20)
        text.preferredMaxLayoutWidth = 380
        panel.contentView = stack
        panel.center()
        welcome = panel
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    @objc private func welcomeOpenSettings() {
        welcome?.close()
        showSettings()
    }

    // MARK: CI smoke test (--snapshot <png>)

    private func snapshot(to path: String) {
        logWindowStack()
        guard let w = windows.values.sorted(by: { $0.displayID < $1.displayID }).first else {
            Log.info("snapshot: no wallpaper window")
            return
        }
        let js = "JSON.stringify({ready: document.documentElement.dataset.ready || null, webgl2: !!document.createElement('canvas').getContext('webgl2'), size: [innerWidth, innerHeight, devicePixelRatio], ua: navigator.userAgent})"
        w.scene.webView.evaluateJavaScript(js) { result, error in
            Log.info("snapshot: page state \(result ?? "nil") \(error.map { "\($0)" } ?? "")")
        }
        w.scene.webView.takeSnapshot(with: nil) { image, error in
            guard let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                Log.info("snapshot: failed \(error.map { "\($0)" } ?? "")")
                return
            }
            do {
                try png.write(to: URL(fileURLWithPath: path))
                Log.info("snapshot: wrote \(path) (\(rep.pixelsWide)x\(rep.pixelsHigh))")
            } catch {
                Log.error("snapshot", error)
            }
        }
    }

    /// Logs the on-screen window stack (front to back) so CI can confirm the
    /// wallpaper sits below the Finder's desktop icons.
    private func logWindowStack() {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return }
        let desktopIcons = Int(CGWindowLevelForKey(.desktopIconWindow))
        for (i, info) in list.enumerated() {
            let layer = (info[kCGWindowLayer as String] as? Int) ?? 0
            let owner = (info[kCGWindowOwnerName as String] as? String) ?? "?"
            guard layer <= desktopIcons || owner == "3D Earth" || owner == "3DEarth" else { continue }
            let number = (info[kCGWindowNumber as String] as? Int) ?? 0
            let b = (info[kCGWindowBounds as String] as? [String: Any]) ?? [:]
            Log.info("window stack #\(i): \(owner) window \(number) layer \(layer) bounds \(b["Width"] ?? 0)x\(b["Height"] ?? 0)")
        }
        for w in windows.values {
            Log.info("wallpaper window \(w.windowNumber): level \(w.level.rawValue) (desktop icons \(desktopIcons)), visible \(w.isVisible), occlusion visible \(!w.isCovered), ignoresMouse \(w.ignoresMouseEvents), paused \(w.scene.paused)")
        }
    }
}
