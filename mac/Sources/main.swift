//
//  Hearth.app - a native macOS shell around the Hearth session daemon.
//
//  The app owns the whole lifecycle: on launch it starts the Node daemon (and a
//  local relay if none is configured), waits for the daemon to print its
//  loopback UI address, and shows that in a WKWebView inside a real window. On
//  quit it takes the daemon down with it.
//
//  The interface is the same one the browser shows, but this is an application:
//  a Dock icon, a titled window, a menu bar, Cmd+C/Cmd+V, Cmd+Q. No URL bar, no
//  tab, nothing to keep open in a browser.
//

import AppKit
import WebKit

// ---------------------------------------------------------------------------
// locating node
// ---------------------------------------------------------------------------

// A GUI app does not inherit the shell's PATH, so a bare "node" will not resolve.
// Look where Node actually installs, then fall back to asking a login shell.
func findNode() -> String? {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        NSHomeDirectory() + "/.volta/bin/node",
        NSHomeDirectory() + "/.nvm/current/bin/node",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
        return path
    }
    let probe = Process()
    probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
    probe.arguments = ["-lc", "command -v node"]
    let pipe = Pipe()
    probe.standardOutput = pipe
    probe.standardError = FileHandle.nullDevice
    do {
        try probe.run()
        probe.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let found = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !found.isEmpty, FileManager.default.isExecutableFile(atPath: found) { return found }
    } catch { }
    return nil
}

func configuredRelay() -> String? {
    let path = NSHomeDirectory() + "/.hearth/config.json"
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let relay = json["relay"] as? String, !relay.isEmpty
    else { return nil }
    return relay
}

func freePort() -> Int {
    // Ask the kernel for an unused port, then hand the number to the daemon.
    let sock = socket(AF_INET, SOCK_STREAM, 0)
    guard sock >= 0 else { return 7777 }
    defer { close(sock) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { return 7777 }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let got = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) }
    }
    guard got == 0 else { return 7777 }
    return Int(UInt16(bigEndian: addr.sin_port))
}

// ---------------------------------------------------------------------------
// the daemon
// ---------------------------------------------------------------------------

final class Daemon {
    private var relay: Process?
    private var host: Process?
    private var buffer = ""
    private let lock = NSLock()

    var onReady: ((URL) -> Void)?
    var onFailure: ((String) -> Void)?
    private var settled = false

    private let resources: String
    private let node: String

    init(resources: String, node: String) {
        self.resources = resources
        self.node = node
    }

    func start() {
        let relayUrl: String
        if let configured = configuredRelay() {
            relayUrl = configured
        } else {
            // Nothing configured: run a relay locally so the app works on its own.
            // Friends elsewhere need a relay on a real host - see the README.
            let port = freePort()
            relayUrl = "ws://127.0.0.1:\(port)/ws"
            relay = launch(script: "relay.js", args: [], env: ["PORT": String(port)])
        }

        let uiPort = freePort()
        host = launch(script: "hearth.js",
                      args: ["host", "--ui", "--no-open", "--ui-port", String(uiPort),
                             "--relay", relayUrl],
                      env: [:])

        guard let host else {
            fail("Could not start the Hearth daemon.")
            return
        }

        if let pipe = host.standardOutput as? Pipe {
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                self?.absorb(text)
            }
        }

        host.terminationHandler = { [weak self] proc in
            guard let self, !self.settled else { return }
            self.fail("The Hearth daemon exited (status \(proc.terminationStatus)).\n\n"
                      + self.buffer.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        // If nothing useful arrives, say so rather than showing a blank window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, !self.settled else { return }
            self.fail("The daemon did not report a window address in time.\n\n"
                      + self.buffer.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func launch(script: String, args: [String], env: [String: String]) -> Process? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [resources + "/app/" + script] + args
        proc.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        var environment = ProcessInfo.processInfo.environment
        environment["HEARTH_APP"] = "1"
        for (k, v) in env { environment[k] = v }
        proc.environment = environment
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = out
        do { try proc.run() } catch { return nil }
        return proc
    }

    private func absorb(_ text: String) {
        lock.lock()
        buffer += text
        let haystack = buffer
        lock.unlock()

        // The daemon prints its loopback address with a single-use token.
        guard !settled,
              let range = haystack.range(
                of: #"http://127\.0\.0\.1:\d+/\?token=[0-9a-f]+"#,
                options: .regularExpression),
              let url = URL(string: String(haystack[range]))
        else { return }

        settled = true
        DispatchQueue.main.async { self.onReady?(url) }
    }

    private func fail(_ message: String) {
        guard !settled else { return }
        settled = true
        DispatchQueue.main.async { self.onFailure?(message) }
    }

    func stop() {
        host?.terminate()
        relay?.terminate()
    }
}

// ---------------------------------------------------------------------------
// application
// ---------------------------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var status: NSTextField!
    private var spinner: NSProgressIndicator!
    private var daemon: Daemon?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()

        guard let node = findNode() else {
            showFailure("""
            Hearth needs Node.js 18 or newer, and could not find it.

            Install it from nodejs.org or with Homebrew:
                brew install node

            Then reopen Hearth.
            """)
            return
        }

        let resources = Bundle.main.resourcePath ?? "."
        let daemon = Daemon(resources: resources, node: node)
        daemon.onReady = { [weak self] url in self?.show(url) }
        daemon.onFailure = { [weak self] message in self?.showFailure(message) }
        daemon.start()
        self.daemon = daemon
    }

    func applicationWillTerminate(_ note: Notification) { daemon?.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // --- window

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Hearth"
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.071, green: 0.063, blue: 0.055, alpha: 1) // --bg
        window.minSize = NSSize(width: 720, height: 480)
        window.setFrameAutosaveName("HearthMainWindow")
        window.center()

        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.isHidden = true
        web.translatesAutoresizingMaskIntoConstraints = false

        // Shown while the daemon boots, so the window is never blank.
        status = NSTextField(labelWithString: "Starting your session…")
        status.font = .systemFont(ofSize: 13)
        status.textColor = NSColor(white: 0.62, alpha: 1)
        status.alignment = .center
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 0
        status.translatesAutoresizingMaskIntoConstraints = false

        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        spinner.translatesAutoresizingMaskIntoConstraints = false

        let content = window.contentView!
        content.addSubview(web)
        content.addSubview(spinner)
        content.addSubview(status)

        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),

            spinner.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -26),

            status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            status.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
        ])

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func show(_ url: URL) {
        web.load(URLRequest(url: url))
    }

    private func showFailure(_ message: String) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        status.stringValue = message
        status.textColor = NSColor(red: 0.97, green: 0.44, blue: 0.44, alpha: 1)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        status.isHidden = true
        web.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure("Could not load the session window.\n\n\(error.localizedDescription)")
    }

    // --- menu bar
    //
    // Without this there is no Cmd+Q and no Cmd+C, which a window like this
    // needs far more than most.

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Hearth", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Hearth", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Hearth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reload() { web.reload() }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)   // a real Dock icon, not a background agent
let delegate = AppDelegate()
app.delegate = delegate
app.run()
