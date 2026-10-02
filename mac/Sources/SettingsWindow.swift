import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Settings being edited (a copy; nothing changes until Apply or OK).
@MainActor
final class SettingsModel: ObservableObject {
    @Published var s: AppSettings
    @Published var openAtLogin: Bool
    @Published var useCustomTime: Bool
    @Published var customDate: Date
    @Published var presetIndex = 0
    @Published var status = ""

    let apply: (AppSettings) -> Void
    let statusText: () -> String
    let refreshWeather: () -> Void
    let checkUpdates: () -> Void

    init(current: AppSettings, apply: @escaping (AppSettings) -> Void, statusText: @escaping () -> String,
         refreshWeather: @escaping () -> Void, checkUpdates: @escaping () -> Void) {
        var c = current
        c.normalize()
        s = c
        openAtLogin = LoginItem.isEnabled
        let t = DataService.parseISO(c.customTime)
        useCustomTime = t != nil
        customDate = t ?? Date()
        self.apply = apply
        self.statusText = statusText
        self.refreshWeather = refreshWeather
        self.checkUpdates = checkUpdates
        status = statusText()
    }

    func load(_ settings: AppSettings) {
        var c = settings
        c.normalize()
        s = c
        let t = DataService.parseISO(c.customTime)
        useCustomTime = t != nil
        customDate = t ?? Date()
    }

    /// The edited settings as they would be saved.
    func edited() -> AppSettings {
        var out = s
        if useCustomTime {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime]
            out.customTime = f.string(from: customDate)
        } else {
            out.customTime = ""
        }
        out.customCloudUrl = out.customCloudUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        out.normalize()
        return out
    }

    func commit() {
        let out = edited()
        s = out
        if openAtLogin != LoginItem.isEnabled { LoginItem.set(openAtLogin) }
        openAtLogin = LoginItem.isEnabled
        apply(out)
        status = statusText()
    }

    func usePreset() {
        var out = edited()
        Presets.all[presetIndex].apply(&out)
        load(out)
        commit()
    }

    func guessLocation() {
        var t = AppSettings()
        t.guessHomeFromTimeZone()
        s.homeLat = t.homeLat
        s.homeLon = t.homeLon
    }

    func export() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "3D Earth settings.json"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try edited().encoded().write(to: url, options: .atomic) }
        catch { alert("Could not save that file:\n\(error.localizedDescription)") }
    }

    func importSettings() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            var loaded = try AppSettings.decode(Data(contentsOf: url))
            loaded.firstRunDone = true
            load(loaded)
            commit()
        } catch {
            alert("Could not read that file:\n\(error.localizedDescription)")
        }
    }

    private func alert(_ text: String) {
        let a = NSAlert()
        a.messageText = "3D Earth settings"
        a.informativeText = text
        a.alertStyle = .warning
        a.runModal()
    }
}

/// A labelled settings row: LabeledContent on macOS 13+, a plain HStack on macOS 12.
private struct Row<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        if #available(macOS 13, *) {
            LabeledContent(title) { content }
        } else {
            HStack {
                if !title.isEmpty { Text(title) }
                content
            }
        }
    }
}

private extension View {
    /// Grouped form style on macOS 13+; the default form style on macOS 12.
    @ViewBuilder func groupedForm() -> some View {
        if #available(macOS 13, *) { formStyle(.grouped) } else { self }
    }
}

private struct SliderRow: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var format: (Double) -> String = { "\(Int(($0 * 100).rounded())) %" }

    var body: some View {
        Row(title) {
            HStack(spacing: 8) {
                Slider(value: $value, in: range)
                    .frame(minWidth: 220)
                Text(format(value))
                    .monospacedDigit()
                    .foregroundColor(.secondary)
                    .frame(width: 58, alignment: .trailing)
            }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var m: SettingsModel
    let close: () -> Void
    private let ticker = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    private static let number: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        f.usesGroupingSeparator = false
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Preset")
                Picker("Preset", selection: $m.presetIndex) {
                    ForEach(Presets.all.indices, id: \.self) { i in Text(Presets.all[i].name).tag(i) }
                }
                .labelsHidden()
                .frame(width: 360)
                Button("Use preset") { m.usePreset() }
                Spacer()
                Button("Export…") { m.export() }
                Button("Import…") { m.importSettings() }
            }

            TabView {
                viewTab.tabItem { Text("View") }
                surfaceTab.tabItem { Text("Surface") }
                motionTab.tabItem { Text("Motion & time") }
                weatherTab.tabItem { Text("Weather") }
                skyTab.tabItem { Text("Sky") }
                performanceTab.tabItem { Text("Performance") }
                #if !APPSTORE
                updatesTab.tabItem { Text("Updates") }
                #endif
            }
            .frame(minHeight: 380)

            HStack(spacing: 12) {
                Button("Update weather now") { m.refreshWeather(); m.status = "Downloading…" }
                Button("Open data folder") { NSWorkspace.shared.open(Paths.data) }
                Button("Open log") { NSWorkspace.shared.open(Paths.logFile) }
            }
            Text(m.status)
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 0) {
                Text("3D Earth \(AppInfo.version) · created by ")
                Link("Vangelis Makridakis", destination: URL(string: "https://www.ax-easy.com")!)
                Text(" & ")
                Link("Claude", destination: URL(string: "https://claude.ai")!)
                Text(" · by ")
                Link("Ax-Easy", destination: URL(string: "https://www.ax-easy.com")!)
                    .foregroundColor(Color(red: 1, green: 0.55, blue: 0.1))
                #if APPSTORE
                Text(" · ")
                Link("Privacy policy", destination: AppInfo.privacyURL)
                #endif
            }
            .font(.callout)

            HStack {
                Spacer()
                Button("Cancel") { close() }.keyboardShortcut(.cancelAction)
                Button("Apply") { m.commit() }
                Button("OK") { m.commit(); close() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 700)
        .onReceive(ticker) { _ in m.status = m.statusText() }
    }

    // MARK: tabs

    private var viewTab: some View {
        Form {
            Picker("Camera", selection: $m.s.view) {
                Text("Moon beside the Earth").tag("moon")
                Text("Above my location").tag("home")
                Text("Sunrise behind the Earth").tag("sunrise")
            }
            Row("My location") {
                HStack {
                    Text("Lat")
                    TextField("Lat", value: $m.s.homeLat, formatter: SettingsView.number).frame(width: 70).labelsHidden()
                    Text("Lon")
                    TextField("Lon", value: $m.s.homeLon, formatter: SettingsView.number).frame(width: 70).labelsHidden()
                    Button("Guess from time zone") { m.guessLocation() }
                }
            }
            SliderRow(title: "Earth size (% of height)", value: $m.s.earthFill, range: 0.5...1.1)
            SliderRow(title: "Earth position (left ↔ right)", value: $m.s.earthPosition, range: -1...1)
            SliderRow(title: "Moon view: sunlit ↔ terminator", value: $m.s.sunsideBias, range: 0...90, format: { "\(Int($0.rounded()))°" })
            Picker("Moon size", selection: $m.s.moonScale) {
                Text("True size").tag(1.0)
                Text("2×").tag(2.0)
                Text("3×").tag(3.0)
                Text("4×").tag(4.0)
            }
        }
        .groupedForm()
    }

    private var surfaceTab: some View {
        Form {
            Picker("Earth surface map", selection: $m.s.surfaceTexture) {
                Text("Solar System Scope 8K (NASA Blue Marble)").tag("sss")
                Text("NASA Blue Marble – this month (seasons, 8K from 21600 px)").tag("bluemarble")
                Text("Built-in 4K (offline)").tag("builtin")
            }
            SliderRow(title: "Land brightness (diffuse)", value: $m.s.landBrightness, range: 0.5...1.5)
            SliderRow(title: "Ocean reflection", value: $m.s.oceanReflection, range: 0...2)
            SliderRow(title: "Ocean: calm mirror ↔ rough", value: $m.s.oceanRoughness, range: 0...1)
            SliderRow(title: "Atmosphere haze", value: $m.s.haze, range: 0...2)
            SliderRow(title: "City lights at night", value: $m.s.lightsBrightness, range: 0...2.5)
            SliderRow(title: "City lights flicker", value: $m.s.lightsFlicker, range: 0...1)
        }
        .groupedForm()
    }

    private var motionTab: some View {
        Form {
            Picker("Motion", selection: $m.s.motion) {
                Text("Real time").tag("live")
                Text("Spin around the Earth from my location").tag("spin")
                Text("Time-lapse").tag("timelapse")
                Text("Day & night time-lapse above my location").tag("daylapse")
            }
            Row("Spin: seconds per 360°") {
                TextField("Seconds", value: $m.s.spinSeconds, formatter: SettingsView.number).frame(width: 90).labelsHidden()
            }
            Row("Time-lapse speed (×)") {
                TextField("Speed", value: $m.s.timeSpeed, formatter: SettingsView.number).frame(width: 90).labelsHidden()
            }
            Toggle("During time-lapse, replay the clouds of the last 24 hours", isOn: $m.s.cloudLoop)
            Toggle("Show a specific date and time", isOn: $m.useCustomTime)
            DatePicker("Date and time (local)", selection: $m.customDate)
                .disabled(!m.useCustomTime)
        }
        .groupedForm()
    }

    private var weatherTab: some View {
        Form {
            Toggle("Live clouds", isOn: $m.s.clouds)
            SliderRow(title: "Cloud opacity", value: $m.s.cloudOpacity, range: 0.2...1)
            SliderRow(title: "Cloud thickness", value: $m.s.cloudCover, range: 0.4...2)
            SliderRow(title: "Cloud detail (billows)", value: $m.s.cloudDetail, range: 0...1)
            Toggle("Label active storms (hurricanes, typhoons, cyclones)", isOn: $m.s.storms)
            Row("Update every (minutes)") {
                Stepper(value: $m.s.weatherRefreshMinutes, in: 15...720, step: 15) {
                    Text("\(m.s.weatherRefreshMinutes)").monospacedDigit()
                }
            }
            TextField("Cloud map URL", text: $m.s.customCloudUrl, prompt: Text("optional: https URL of an equirectangular cloud map (JPG/PNG)"))
                .frame(maxWidth: 520)
        }
        .groupedForm()
        .groupedForm()
    }

    private var skyTab: some View {
        Form {
            Toggle("Label the Moon and planets", isOn: $m.s.labels)
            Toggle("Show credits (bottom right)", isOn: $m.s.credits)
            SliderRow(title: "Stars", value: $m.s.stars, range: 0...1)
            SliderRow(title: "Milky Way", value: $m.s.milkyWay, range: 0...1)
            SliderRow(title: "Brightness", value: $m.s.exposure, range: 0.5...2)
        }
        .groupedForm()
    }

    private var performanceTab: some View {
        Form {
            Picker("Quality", selection: $m.s.quality) {
                Text("Low (integrated graphics)").tag("low")
                Text("Medium").tag("medium")
                Text("High (8K textures)").tag("high")
            }
            Picker("Anti-aliasing", selection: $m.s.antialias) {
                Text("Off").tag(0)
                Text("2×").tag(2)
                Text("4×").tag(4)
                Text("8× + supersampling (sharpest)").tag(8)
            }
            Picker("Frame rate (fps)", selection: $m.s.fps) {
                ForEach(AppSettings.fpsChoices, id: \.self) { f in Text("\(f)").tag(f) }
            }
            Picker("Show on", selection: $m.s.monitors) {
                Text("All displays").tag("all")
                Text("Main display only").tag("primary")
            }
            Toggle("Pause when other windows or a full-screen app cover the desktop", isOn: $m.s.pauseWhenCovered)
            Toggle("Pause on battery power", isOn: $m.s.pauseOnBattery)
            Toggle("Open at login", isOn: $m.openAtLogin)
        }
        .groupedForm()
    }

    #if !APPSTORE
    private var updatesTab: some View {
        Form {
            Row("Installed version") { Text(AppInfo.version) }
            Toggle("Check for updates automatically", isOn: $m.s.autoCheckUpdates)
            Row("") {
                HStack {
                    Button("Check for updates now") { m.checkUpdates() }
                    Link("All releases", destination: URL(string: "https://github.com/\(AppInfo.feedRepo)/releases")!)
                }
            }
            Text("On macOS a new version is downloaded from the release page and dragged to Applications, replacing the old one. Your settings are kept.")
                .font(.callout)
                .foregroundColor(.secondary)
        }
        .groupedForm()
    }
    #endif
}

@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    let model: SettingsModel
    var onClose: (() -> Void)?

    init(model: SettingsModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 640),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "3D Earth settings"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        let host = NSHostingController(rootView: SettingsView(m: model, close: { [weak window] in window?.close() }))
        if #available(macOS 13, *) { host.sizingOptions = [.preferredContentSize] }
        window.contentViewController = host
        window.delegate = self
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func windowWillClose(_ notification: Notification) { onClose?() }
}
