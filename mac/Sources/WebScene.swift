import AppKit
import WebKit

/// Serves the bundled scene (Resources/web) and the downloaded data folder
/// (as /data/...) from one origin, earth://local, so WebGL may use every image
/// without cross-origin restrictions (the same layout as the Windows host).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "earth"
    static let origin = "earth://local"
    static let shared = SchemeHandler()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var rel = url.path
        while rel.hasPrefix("/") { rel.removeFirst() }
        var root = Paths.web
        if rel.hasPrefix("data/") {
            root = Paths.data
            rel = String(rel.dropFirst(5))
            // Downloaded data is only ever images and JSON; never serve anything
            // else (no downloaded code can reach the page).
            let dataExt = (rel as NSString).pathExtension.lowercased()
            guard ["jpg", "jpeg", "png", "webp", "json"].contains(dataExt) else {
                respond(urlSchemeTask, url: url, status: 404, type: "text/plain", body: Data("Not Found".utf8))
                return
            }
        }
        if rel.isEmpty { rel = "index.html" }

        let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
        let full = root.appendingPathComponent(rel).standardizedFileURL.resolvingSymlinksInPath()
        var isDir: ObjCBool = false
        guard full.path.hasPrefix(rootPath + "/"),
              FileManager.default.fileExists(atPath: full.path, isDirectory: &isDir), !isDir.boolValue,
              var body = try? Data(contentsOf: full, options: .mappedIfSafe) else {
            respond(urlSchemeTask, url: url, status: 404, type: "text/plain", body: Data("Not Found".utf8))
            return
        }
        let ext = full.pathExtension.lowercased()
        if (ext == "js" || ext == "mjs") && full.path.contains("/js/"), var text = String(data: body, encoding: .utf8) {
            // Import maps need Safari 16.4; resolve the bare 'three' specifier here so
            // every macOS 12+ WebKit can load the modules.
            text = text.replacingOccurrences(of: "from 'three'", with: "from '/lib/three.module.js'")
                .replacingOccurrences(of: "from \"three\"", with: "from \"/lib/three.module.js\"")
            body = Data(text.utf8)
        } else if rel == "lib/three.core.js", let text = String(data: body, encoding: .utf8) {
            // Class static blocks need Safari 16.4 (macOS 12 can ship older WebKit);
            // three only uses them for `X.prototype.isX = true`, so serve getters instead.
            body = Data(SchemeHandler.staticBlocks.stringByReplacingMatches(
                in: text, range: NSRange(text.startIndex..., in: text),
                withTemplate: "get $1() { return true; }").utf8)
        }
        respond(urlSchemeTask, url: url, status: 200, type: SchemeHandler.mimeType(ext), body: body)
    }

    private static let staticBlocks = try! NSRegularExpression(
        pattern: #"static\s*\{\s*(?:/\*[\s\S]*?\*/\s*)?\w+\.prototype\.(\w+)\s*=\s*true;\s*\}"#)

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
        let headers = [
            "Content-Type": type,
            "Content-Length": "\(body.count)",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        ]
        guard let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(resp)
        task.didReceive(body)
        task.didFinish()
    }

    static func mimeType(_ ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "css": return "text/css"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}

/// Breaks the retain cycle WKUserContentController would otherwise create.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

/// One WKWebView running the shared web scene, plus the message bridge the page
/// expects. The page talks to `window.chrome.webview` (WebView2); a small shim
/// injected at document start maps that onto WebKit's message handlers, so
/// web/ is identical on Windows and macOS.
final class WebScene: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private static let bridgeJS = #"""
    (function () {
      if (window.chrome && window.chrome.webview) return;
      var listeners = [];
      window.chrome = window.chrome || {};
      window.chrome.webview = {
        postMessage: function (m) {
          try { window.webkit.messageHandlers.host.postMessage(JSON.parse(JSON.stringify(m))); } catch (e) {}
        },
        addEventListener: function (type, fn) { if (type === 'message') listeners.push(fn); },
        removeEventListener: function (type, fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
      };
      window.__hostDeliver = function (msg) {
        listeners.slice().forEach(function (fn) { try { fn({ data: msg }); } catch (e) { console.error(e); } });
      };
    })();
    """#

    let webView: WKWebView
    let name: String
    let interactive: Bool
    private(set) var ready = false
    private(set) var paused = false
    var settingsProvider: () -> AppSettings = { AppSettings() }
    /// Screen insets (device pixels) that keep the credits clear of the Dock.
    var insetsProvider: (() -> [String: Double])?
    var onClose: (() -> Void)?
    var onReady: (() -> Void)?

    init(name: String, interactive: Bool) {
        self.name = name
        self.interactive = interactive
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler.shared, forURLScheme: SchemeHandler.scheme)
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: WebScene.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        #if !APPSTORE
        if AppInfo.hasArg("--devtools") {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        #endif
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        super.init()
        ucc.add(WeakScriptHandler(self), name: "host")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if APPSTORE
        // Public API only: no white flash before the first frame, because the web view
        // stays transparent (alpha 0) over the black window until the page has loaded.
        webView.underPageBackgroundColor = .black
        webView.alphaValue = 0
        #else
        webView.setValue(false, forKey: "drawsBackground")
        #endif
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.autoresizingMask = [.width, .height]
        if #available(macOS 13.3, *) { webView.isInspectable = AppInfo.hasArg("--devtools") }
    }

    func load() {
        ready = false
        let url = URL(string: "\(SchemeHandler.origin)/index.html\(interactive ? "?interactive" : "")")!
        Log.info("[\(name)] navigating to \(url.absoluteString)")
        webView.load(URLRequest(url: url))
    }

    func teardown() {
        ready = false
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "host")
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
    }

    // MARK: host -> page

    func post(_ message: [String: Any]) {
        guard ready, JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message),
              var json = String(data: data, encoding: .utf8) else { return }
        json = json.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        webView.evaluateJavaScript("window.__hostDeliver && window.__hostDeliver(\(json)); void 0;", completionHandler: nil)
    }

    func sendSettings(_ s: AppSettings) { post(["type": "settings", "settings": s.jsonObject]) }

    func notifyDataChanged() { post(["type": "data"]) }

    func sendInsets() {
        guard let insets = insetsProvider?() else { return }
        var msg: [String: Any] = ["type": "insets"]
        for (k, v) in insets { msg[k] = v }
        post(msg)
    }

    func setPaused(_ p: Bool) {
        guard p != paused else { return }
        paused = p
        Log.info("[\(name)] \(p ? "paused" : "resumed")")
        post(["type": "pause", "paused": p])
    }

    // MARK: page -> host

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "log":
            Log.info("[\(name) page] \(body["message"] ?? "")")
        case "close":
            onClose?()
        case "ready":
            Log.info("[\(name)] scene ready")
            ready = true
            sendInsets()
            sendSettings(settingsProvider())
            post(["type": "pause", "paused": paused])
            onReady?()
        default:
            break
        }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == SchemeHandler.scheme || url.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        WebScene.openExternal(url)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { WebScene.openExternal(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Log.info("[\(name)] navigation ok")
        webView.alphaValue = 1
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Log.error("[\(name)] navigation failed", error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Log.error("[\(name)] navigation failed", error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.info("[\(name)] web content process ended; reloading")
        ready = false
        webView.perform(#selector(WKWebView.reload(_:)), with: nil, afterDelay: 1.0)
    }

    /// Links (credits) open in the default browser, never inside the wallpaper.
    static func openExternal(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        NSWorkspace.shared.open(url)
    }
}

/// A borderless window at desktop level on one screen: above the desktop
/// picture, below the Finder's desktop icons and every normal window, on all
/// Spaces, and transparent to the mouse so the icons stay clickable.
final class WallpaperWindow: NSWindow {
    let displayID: CGDirectDisplayID
    let scene: WebScene

    init(screen: NSScreen, displayID: CGDirectDisplayID) {
        self.displayID = displayID
        self.scene = WebScene(name: "display \(displayID)", interactive: false)
        super.init(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        title = "3D Earth wallpaper"
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        ignoresMouseEvents = true
        isOpaque = true
        hasShadow = false
        backgroundColor = .black
        isReleasedWhenClosed = false
        animationBehavior = .none
        canHide = false
        isExcludedFromWindowsMenu = true
        contentView = scene.webView
        setFrame(screen.frame, display: false)
        scene.insetsProvider = { [weak self] in self?.insets() ?? [:] }
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    var screenForDisplay: NSScreen? { NSScreen.screens.first { $0.displayID == displayID } }

    /// Menu bar / Dock insets in device pixels (the page divides by devicePixelRatio).
    func insets() -> [String: Double] {
        guard let s = screenForDisplay else { return [:] }
        let f = s.frame, v = s.visibleFrame, k = Double(s.backingScaleFactor)
        return [
            "top": Double(f.maxY - v.maxY) * k,
            "left": Double(v.minX - f.minX) * k,
            "right": Double(f.maxX - v.maxX) * k,
            "bottom": Double(v.minY - f.minY) * k,
        ]
    }

    func place(on screen: NSScreen) {
        if frame != screen.frame {
            setFrame(screen.frame, display: true)
            scene.sendInsets()
        }
        orderFront(nil)
    }

    /// Fully hidden behind other windows (or on a full-screen Space).
    var isCovered: Bool { !occlusionState.contains(.visible) }

    func teardown() {
        scene.teardown()
        orderOut(nil)
        close()
    }
}

/// Explore (full screen, interactive) or the scene in an ordinary window.
final class PreviewWindow: NSWindow {
    let scene: WebScene
    let fullscreen: Bool

    init(screen: NSScreen, fullscreen: Bool) {
        self.fullscreen = fullscreen
        self.scene = WebScene(name: fullscreen ? "explore" : "preview", interactive: true)
        if fullscreen {
            super.init(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
            collectionBehavior = [.moveToActiveSpace, .fullScreenNone]
            setFrame(screen.frame, display: false)
        } else {
            let vf = screen.visibleFrame
            let size = NSSize(width: min(1280, vf.width - 80), height: min(760, vf.height - 80))
            super.init(contentRect: NSRect(origin: .zero, size: size),
                       styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            title = "3D Earth preview"
            minSize = NSSize(width: 480, height: 300)
            setFrameOrigin(NSPoint(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2))
        }
        backgroundColor = .black
        isReleasedWhenClosed = false
        contentView = scene.webView
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// Esc also closes when the page has not taken the key.
    override func cancelOperation(_ sender: Any?) { close() }
}

extension NSScreen {
    var displayID: CGDirectDisplayID? {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}
