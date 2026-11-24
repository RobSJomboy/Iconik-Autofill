// Push to Iconik — Jomboy Media desktop app.
// Double-click → newest export uploads into the show's Iconik folder → app waits for the video on YouTube →
// Iconik Autofill fills and pushes the metadata (and monday ad reads). First launch runs a setup wizard.
//
// The UI is ui/index.html in a WKWebView; this file is the native half: team key, files, uploads, windows.
// The app never holds Iconik / monday / YouTube credentials: everything goes through the jomboy-yt worker,
// which only answers with the team push key (kept in ~/Library/Application Support/Push to Iconik, mode 600).

import Cocoa
import WebKit
import UserNotifications

let WORKER = "https://jomboy-yt.jomboymedia.workers.dev"
let SITE = "https://robsjomboy.github.io/Iconik-Autofill/"
let AUTOFILL = SITE
let UA = "PushToIconik/1.0 (Macintosh)"
let SUPPORT = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Push to Iconik", isDirectory: true)
let VIDEO_EXT: Set<String> = ["mp4", "mov", "mxf", "m4v"]      // audio files can still be dropped on the app

func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    let url = SUPPORT.appendingPathComponent("log.txt")
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
    else { try? line.data(using: .utf8)!.write(to: url) }
}

// MARK: Team key
// Kept in a file only this Mac user can read (0600). The login Keychain would show an "allow access" prompt after
// every app update, because team builds aren't signed with a developer certificate.

enum TeamKey {
    static let url = SUPPORT.appendingPathComponent("team-key")
    static func get() -> String? {
        guard let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let k = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return k.isEmpty ? nil : k
    }
    static func set(_ k: String) throws {
        try? FileManager.default.removeItem(at: url)
        FileManager.default.createFile(atPath: url.path, contents: k.data(using: .utf8), attributes: [.posixPermissions: 0o600])
    }
    static func delete() { try? FileManager.default.removeItem(at: url) }
}

var pushKey: String? { TeamKey.get() }

// MARK: Worker calls

struct WorkerError: LocalizedError { let message: String; var errorDescription: String? { message } }

func workerCall(_ method: String, _ path: String, _ body: Any? = nil, key: String? = nil) async throws -> (Int, Any) {
    var req = URLRequest(url: URL(string: WORKER + path)!)
    req.httpMethod = method
    req.timeoutInterval = 90
    req.setValue(UA, forHTTPHeaderField: "User-Agent")          // Cloudflare refuses blank / script user agents
    if let k = key ?? pushKey { req.setValue(k, forHTTPHeaderField: "X-Push-Key") }
    if let body = body {
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, resp) = try await URLSession.shared.data(for: req)
    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
    let json = (try? JSONSerialization.jsonObject(with: data)) ?? ["error": String(data: data, encoding: .utf8)?.prefix(300) ?? ""]
    return (status, json)
}

/// Worker call that throws on anything but 2xx.
func worker(_ method: String, _ path: String, _ body: Any? = nil) async throws -> [String: Any] {
    let (st, j) = try await workerCall(method, path, body)
    let d = j as? [String: Any] ?? [:]
    if !(200..<300).contains(st) {
        throw WorkerError(message: (d["error"] as? String) ?? "worker HTTP \(st)")
    }
    return d
}

// MARK: Files

func durationOf(_ url: URL) -> Double? {
    if let item = MDItemCreateWithURL(nil, url as CFURL),
       let n = MDItemCopyAttribute(item, kMDItemDurationSeconds) as? NSNumber { return n.doubleValue }
    return nil
}

func fileInfo(_ url: URL) -> [String: Any]? {
    guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
          (a[.type] as? FileAttributeType) == .typeRegular else { return nil }
    var d: [String: Any] = ["path": url.path, "name": url.lastPathComponent,
                            "size": (a[.size] as? NSNumber)?.int64Value ?? 0,
                            "mtime": ((a[.modificationDate] as? Date) ?? Date()).timeIntervalSince1970 * 1000]
    if let s = durationOf(url) { d["seconds"] = s }
    return d
}

func listExports(_ folder: String, limit: Int) -> [[String: Any]] {
    let dir = URL(fileURLWithPath: (folder as NSString).expandingTildeInPath)
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
    var files: [(Date, URL)] = []
    for n in names where !n.hasPrefix(".") && VIDEO_EXT.contains((n as NSString).pathExtension.lowercased()) {
        let u = dir.appendingPathComponent(n)
        if let m = (try? FileManager.default.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date { files.append((m, u)) }
    }
    files.sort { $0.0 > $1.0 }
    return files.prefix(limit).compactMap { fileInfo($0.1) }
}

// MARK: Upload (worker makes the Iconik asset + signed URL; the bytes go straight from this Mac to Iconik storage)

final class Uploader: NSObject {
    let jobId: String, path: String, collection: String
    let emit: ([String: Any]) -> Void
    var size: Int64 = 0
    private var sent: [Int: Int64] = [:]                 // bytes sent per running piece
    private var done: Int64 = 0                          // bytes in finished parts
    private let lock = NSLock()
    private var lastEmit = Date.distantPast
    private var task: Task<Void, Never>?
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 600
        c.timeoutIntervalForResource = 60 * 60 * 24
        return URLSession(configuration: c)
    }()

    init(jobId: String, path: String, collection: String, emit: @escaping ([String: Any]) -> Void) {
        self.jobId = jobId; self.path = path; self.collection = collection; self.emit = emit
    }

    func start() { task = Task { await self.run() } }
    func cancel() { task?.cancel(); session.invalidateAndCancel() }

    private func say(_ phase: String, _ extra: [String: Any] = [:]) {
        var d: [String: Any] = ["jobId": jobId, "phase": phase]
        extra.forEach { d[$0] = $1 }
        DispatchQueue.main.async { self.emit(d) }
    }

    /// Bytes sent so far for one upload piece (key 0 = whole file, n = multipart part n).
    func progress(_ key: Int, _ bytes: Int64) {
        lock.lock()
        sent[key] = bytes
        let total = done + sent.values.reduce(0, +)
        let now = Date(), go = now.timeIntervalSince(lastEmit) > 0.4
        if go { lastEmit = now }
        lock.unlock()
        if go { say("uploading", ["sent": total, "total": size]) }
    }
    private func finishPart(_ key: Int, bytes: Int64) {
        lock.lock(); sent[key] = nil; done += bytes; lock.unlock()
    }
    private func relay(_ key: Int) -> ProgressRelay { ProgressRelay(key: key, owner: self) }

    private func waitUntilWritten() async throws -> Int64 {
        var last: Int64 = -1
        while true {
            try Task.checkCancellation()
            let s = ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.int64Value ?? 0
            if s == last && s > 0 { return s }
            if last >= 0 { say("writing", ["size": s]) }
            last = s
            try await Task.sleep(nanoseconds: 6_000_000_000)
        }
    }

    private func check(_ resp: URLResponse, _ data: Data?, _ what: String) throws -> HTTPURLResponse {
        let h = resp as! HTTPURLResponse
        if !(200..<300).contains(h.statusCode) {
            let body = data.flatMap { String(data: $0, encoding: .utf8) }?.prefix(300) ?? ""
            throw WorkerError(message: "\(what) failed (HTTP \(h.statusCode)) \(body)")
        }
        return h
    }

    private func run() async {
        do {
            let url = URL(fileURLWithPath: path)
            say("checking")
            size = try await waitUntilWritten()
            let name = url.lastPathComponent
            say("starting", ["total": size])
            log("upload start \(name) \(size) → \(collection)")
            let up = try await worker("POST", "/iconik/upload/start", ["collection": collection, "filename": name, "size": size])
            guard let assetId = up["assetId"] as? String, let fileId = up["fileId"] as? String,
                  let uploadURL = up["upload_url"] as? String else { throw WorkerError(message: "Iconik gave no upload link") }
            let method = ((up["upload_method"] as? String) ?? "").uppercased()
            let storage = ((up["storage_method"] as? String) ?? "").uppercased()
            let mime = (up["mime"] as? String) ?? "video/mp4"
            var headers = (up["upload_headers"] as? [String: String]) ?? [:]
            headers["Content-Type"] = headers["Content-Type"] ?? mime
            say("uploading", ["sent": 0, "total": size, "assetUrl": up["assetUrl"] ?? ""])
            log("asset \(assetId) method=\(method) storage=\(storage) host=\(URL(string: uploadURL)?.host ?? "")")

            if method.contains("GCS") || storage.contains("GCS") || uploadURL.contains("storage.googleapis.com") {
                // Resumable session: POST to open it, then PUT the whole file to the session URL.
                var r = URLRequest(url: URL(string: uploadURL)!)
                r.httpMethod = "POST"
                headers.forEach { r.setValue($1, forHTTPHeaderField: $0) }
                r.setValue("start", forHTTPHeaderField: "x-goog-resumable")
                let (d, resp) = try await session.upload(for: r, from: Data())
                let h = try check(resp, d, "Opening the upload")
                guard let loc = h.value(forHTTPHeaderField: "Location"), let lu = URL(string: loc) else {
                    throw WorkerError(message: "Storage didn't open an upload session") }
                var p = URLRequest(url: lu); p.httpMethod = "PUT"
                p.setValue(headers["Content-Type"], forHTTPHeaderField: "Content-Type")
                let (d2, r2) = try await session.upload(for: p, fromFile: url, delegate: relay(0))
                _ = try check(r2, d2, "Upload")
            } else if size <= 4_800_000_000 {
                var p = URLRequest(url: URL(string: uploadURL)!); p.httpMethod = "PUT"
                headers.forEach { p.setValue($1, forHTTPHeaderField: $0) }
                let (d, r) = try await session.upload(for: p, fromFile: url, delegate: relay(0))
                _ = try check(r, d, "Upload")
            } else {
                try await multipartS3(up: up, assetId: assetId, fileId: fileId, url: url)
            }
            say("finishing")
            let fin = try await worker("POST", "/iconik/upload/finish", ["assetId": assetId, "fileId": fileId])
            log("upload done \(assetId) transcode=\(fin["transcode"] ?? "")")
            say("done", ["assetId": assetId, "assetUrl": up["assetUrl"] ?? "https://app.iconik.io/asset/\(assetId)",
                         "transcode": fin["transcode"] ?? ""])
        } catch is CancellationError {
            say("cancelled")
        } catch {
            if (error as NSError).code == NSURLErrorCancelled { say("cancelled"); return }
            log("upload error \(error.localizedDescription)")
            say("error", ["error": error.localizedDescription])
        }
    }

    /// Exports over ~5 GB: S3 multipart (create → signed part URLs → PUT parts → complete).
    private func multipartS3(up: [String: Any], assetId: String, fileId: String, url: URL) async throws {
        guard let create = up["multipart_upload_url"] as? String, let cu = URL(string: create) else {
            throw WorkerError(message: "This export is over 5 GB and Iconik gave no multipart link") }
        var r = URLRequest(url: cu); r.httpMethod = "POST"
        let (d, resp) = try await session.upload(for: r, from: Data())
        _ = try check(resp, d, "Starting the multipart upload")
        let xml = String(data: d, encoding: .utf8) ?? ""
        guard let uploadId = xml.range(of: "(?<=<UploadId>)[^<]+", options: .regularExpression).map({ String(xml[$0]) }) else {
            throw WorkerError(message: "Storage didn't return an UploadId") }
        let partSize: Int64 = max(128 * 1024 * 1024, (size + 9_000) / 9_000)
        let parts = Int((size + partSize - 1) / partSize)
        // Signed URL per part, 100 at a time.
        var urls: [Int: URL] = [:]
        var page = 1
        while urls.count < parts && page <= 200 {
            let j = try await worker("POST", "/app/upload/parts", ["assetId": assetId, "fileId": fileId, "uploadId": uploadId,
                                                                  "partsNum": parts, "page": page, "perPage": 100])
            let objs = (j["objects"] as? [[String: Any]]) ?? []
            if objs.isEmpty { break }
            for (i, o) in objs.enumerated() {
                let n = (o["number"] as? Int) ?? (o["part_number"] as? Int) ?? ((page - 1) * 100 + i + 1)
                if let s = (o["url"] as? String) ?? (o["upload_url"] as? String), let u = URL(string: s) { urls[n] = u }
            }
            page += 1
        }
        guard urls.count >= parts else { throw WorkerError(message: "Iconik gave \(urls.count) of \(parts) part links") }
        var etags = [Int: String]()
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let readLock = NSLock()
        func read(_ n: Int) -> Data {
            readLock.lock(); defer { readLock.unlock() }
            handle.seek(toFileOffset: UInt64(Int64(n - 1) * partSize))
            return handle.readData(ofLength: Int(min(partSize, size - Int64(n - 1) * partSize)))
        }
        try await withThrowingTaskGroup(of: (Int, String).self) { group in
            var next = 1
            func add() {
                let n = next; next += 1
                group.addTask {
                    var tries = 0
                    while true {
                        do {
                            let data = read(n)
                            var p = URLRequest(url: urls[n]!); p.httpMethod = "PUT"
                            let (rd, rr) = try await self.session.upload(for: p, from: data, delegate: self.relay(n))
                            let h = try self.check(rr, rd, "Part \(n)")
                            self.finishPart(n, bytes: Int64(data.count))
                            return (n, h.value(forHTTPHeaderField: "ETag") ?? "")
                        } catch {
                            tries += 1
                            if tries >= 4 || error is CancellationError { throw error }
                            try await Task.sleep(nanoseconds: UInt64(tries) * 3_000_000_000)
                        }
                    }
                }
            }
            for _ in 0..<min(3, parts) { add() }
            while let (n, tag) = try await group.next() {
                etags[n] = tag
                if next <= parts { add() }
            }
        }
        let j = try await worker("POST", "/app/upload/complete-url", ["assetId": assetId, "fileId": fileId, "uploadId": uploadId, "partsNum": parts])
        guard let cs = (j["complete_url"] as? String) ?? (j["url"] as? String), let cURL = URL(string: cs) else {
            throw WorkerError(message: "Iconik gave no link to finish the multipart upload") }
        var body = "<CompleteMultipartUpload>"
        for n in 1...parts { body += "<Part><PartNumber>\(n)</PartNumber><ETag>\(etags[n] ?? "")</ETag></Part>" }
        body += "</CompleteMultipartUpload>"
        var c = URLRequest(url: cURL); c.httpMethod = "POST"
        c.setValue("application/xml", forHTTPHeaderField: "Content-Type")
        let (cd, cr) = try await session.upload(for: c, from: body.data(using: .utf8)!)
        _ = try check(cr, cd, "Finishing the multipart upload")
        let cx = String(data: cd, encoding: .utf8) ?? ""
        if cx.contains("<Error>") { throw WorkerError(message: "Storage refused the finished upload: \(cx.prefix(200))") }
    }
}

final class ProgressRelay: NSObject, URLSessionTaskDelegate {
    let key: Int; weak var owner: Uploader?
    init(key: Int, owner: Uploader) { self.key = key; self.owner = owner }
    func urlSession(_ s: URLSession, task: URLSessionTask, didSendBodyData _: Int64, totalBytesSent: Int64, totalBytesExpectedToSend _: Int64) {
        owner?.progress(key, totalBytesSent)
    }
}

// MARK: Web view that takes dropped files

final class DropWebView: WKWebView {
    var onDrop: (([String]) -> Void)?
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
        if fileURLs(s).isEmpty { return super.draggingEntered(s) }
        evaluateJavaScript("window.onNative && onNative('dragging', true)")
        return .copy
    }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { fileURLs(s).isEmpty ? super.draggingUpdated(s) : .copy }
    override func draggingExited(_ s: NSDraggingInfo?) { evaluateJavaScript("window.onNative && onNative('dragging', false)"); super.draggingExited(s) }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let urls = fileURLs(s)
        if urls.isEmpty { return super.performDragOperation(s) }
        onDrop?(urls.map { $0.path })
        return true
    }
    private func fileURLs(_ s: NSDraggingInfo) -> [URL] {
        (s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
}

// MARK: App

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandlerWithReply, WKScriptMessageHandler, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: DropWebView!
    var uploads: [String: Uploader] = [:]
    var autofillWindows: [String: NSWindow] = [:]
    var pendingOpen: [String] = []
    var ready = false

    func applicationDidFinishLaunching(_ n: Notification) {
        try? FileManager.default.createDirectory(at: SUPPORT, withIntermediateDirectories: true)
        log("launch \(Bundle.main.bundlePath)")
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = DropWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }
        web.onDrop = { [weak self] paths in self?.send("dropped", paths.compactMap { fileInfo(URL(fileURLWithPath: $0)) }) }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Push to Iconik"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.04, green: 0.08, blue: 0.16, alpha: 1)
        window.minSize = NSSize(width: 820, height: 600)
        window.contentView = web
        window.delegate = self
        window.setFrameAutosaveName("PushToIconikMain")
        if !window.setFrameUsingName("PushToIconikMain") { window.center() }
        let ui = Bundle.main.resourceURL!.appendingPathComponent("ui")
        web.loadFileURL(ui.appendingPathComponent("index.html"), allowingReadAccessTo: ui)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if ProcessInfo.processInfo.environment["PTI_DEV"] != nil { startDevHook() }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    // Files dropped on the Dock / Desktop icon.
    func application(_ app: NSApplication, open urls: [URL]) {
        let files = urls.compactMap { fileInfo($0) }
        if ready { send("dropped", files) } else { pendingOpen += urls.map { $0.path } }
        showMain()
    }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool { showMain(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
        if uploads.isEmpty { return .terminateNow }
        let a = NSAlert()
        a.messageText = "An upload is still running"
        a.informativeText = "Quitting stops it, and you'll have to push that export again."
        a.addButton(withTitle: "Keep uploading"); a.addButton(withTitle: "Quit anyway")
        return a.runModal() == .alertSecondButtonReturn ? .terminateNow : .terminateCancel
    }
    // Closing the window just hides it, so uploads and YouTube checks keep going. The Dock icon brings it back.
    func windowShouldClose(_ w: NSWindow) -> Bool {
        if w === window { w.orderOut(nil); return false }
        return true
    }
    func showMain() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Push to Iconik", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Push to Iconik", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Push to Iconik", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    // Native → page events.
    func send(_ event: String, _ data: Any) {
        guard let d = try? JSONSerialization.data(withJSONObject: ["e": event, "d": data], options: [.fragmentsAllowed]),
              let s = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.onNativeRaw && onNativeRaw(\(s))")
    }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { log("page loaded \(w.url?.absoluteString ?? "")") }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { log("page failed \(e.localizedDescription)") }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { log("page failed (provisional) \(e.localizedDescription)") }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { log("web process died"); w.reload() }

    // Links the page opens go to the default browser.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if w === web, let u = a.request.url, u.scheme == "http" || u.scheme == "https" { NSWorkspace.shared.open(u); decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    // Autofill window → result of its Push to Iconik.
    func userContentController(_ uc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let d = m.body as? [String: Any], let jobId = d["jobId"] as? String else { return }
        send("autofill", d)
        log("autofill \(jobId) status=\(d["status"] ?? "")")
    }

    // Page → native commands. Each returns a JSON-able value (or an error string).
    func userContentController(_ uc: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let d = m.body as? [String: Any], let cmd = d["cmd"] as? String else { replyHandler(nil, "bad message"); return }
        Task { @MainActor in
            do { replyHandler(try await self.handle(cmd, d), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    @MainActor func handle(_ cmd: String, _ d: [String: Any]) async throws -> Any? {
        switch cmd {
        case "load":
            ready = true
            let read = { (f: String) -> Any in
                (try? JSONSerialization.jsonObject(with: Data(contentsOf: SUPPORT.appendingPathComponent(f)))) ?? NSNull() }
            let opened = pendingOpen.compactMap { fileInfo(URL(fileURLWithPath: $0)) }
            pendingOpen = []
            return ["config": read("config.json"), "jobs": read("jobs.json"), "hasKey": pushKey != nil,
                    "user": NSFullUserName(), "home": NSHomeDirectory(), "opened": opened,
                    "appPath": Bundle.main.bundlePath, "inApplications": Bundle.main.bundlePath.hasPrefix("/Applications/"),
                    "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "dev",
                    "agent": agentInstalled(), "agentRunning": agentRunning()]
        case "desktopInfo":
            // Touching ~/Desktop can wait on macOS's folder-access prompt, so never do it during startup.
            return await Task.detached { () -> [String: Bool] in
                let d = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
                let fm = FileManager.default
                return ["onDesktop": fm.fileExists(atPath: d.appendingPathComponent("Push to Iconik").path) || fm.fileExists(atPath: d.appendingPathComponent("Push to Iconik.app").path),
                        "desktopExports": fm.fileExists(atPath: d.appendingPathComponent("EXPORTS").path)]
            }.value
        case "save":
            let name = d["file"] as! String
            guard ["config.json", "jobs.json"].contains(name) else { throw WorkerError(message: "bad file") }
            let data = try JSONSerialization.data(withJSONObject: d["data"] ?? NSNull(), options: [.prettyPrinted, .fragmentsAllowed])
            try data.write(to: SUPPORT.appendingPathComponent(name), options: .atomic)
            return true
        case "setKey":
            let key = (d["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let (st, j) = try await workerCall("GET", "/app/key", key: key)
            if st == 200 { try TeamKey.set(key); return true }
            throw WorkerError(message: ((j as? [String: Any])?["error"] as? String) ?? "That key didn't work (HTTP \(st))")
        case "forgetKey":
            TeamKey.delete(); return true
        case "api":
            let (st, j) = try await workerCall(d["method"] as? String ?? "GET", d["path"] as! String, d["body"])
            return ["status": st, "json": j]
        case "pickFolder":
            let p = NSOpenPanel()
            p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
            p.prompt = "Use this folder"; p.message = d["message"] as? String ?? "Where do your exports go?"
            if let s = d["start"] as? String { p.directoryURL = URL(fileURLWithPath: (s as NSString).expandingTildeInPath) }
            return await p.beginSheetModal(for: window) == .OK ? p.url?.path : nil
        case "pickFile":
            let p = NSOpenPanel()
            p.canChooseFiles = true; p.allowsMultipleSelection = false
            p.allowedContentTypes = [.movie, .audio, .mpeg4Movie, .quickTimeMovie]
            if let s = d["start"] as? String { p.directoryURL = URL(fileURLWithPath: (s as NSString).expandingTildeInPath) }
            return await p.beginSheetModal(for: window) == .OK ? p.url.flatMap { fileInfo($0) } : nil
        case "listExports":
            let folder = d["folder"] as? String ?? "", limit = d["limit"] as? Int ?? 30
            return await Task.detached { listExports(folder, limit: limit) }.value
        case "fileInfo":
            return fileInfo(URL(fileURLWithPath: d["path"] as! String))
        case "folderExists":
            var dir: ObjCBool = false
            return FileManager.default.fileExists(atPath: ((d["path"] as? String ?? "") as NSString).expandingTildeInPath, isDirectory: &dir) && dir.boolValue
        case "upload":
            let id = d["jobId"] as! String
            if uploads[id] != nil { return false }
            let u = Uploader(jobId: id, path: d["path"] as! String, collection: d["collection"] as! String) { [weak self] ev in
                self?.send("upload", ev)
                if let ph = ev["phase"] as? String, ["done", "error", "cancelled"].contains(ph) { self?.uploads[id] = nil }
            }
            uploads[id] = u; u.start()
            return true
        case "cancelUpload":
            uploads[d["jobId"] as! String]?.cancel(); return true
        case "open":
            if let u = URL(string: d["url"] as! String) { NSWorkspace.shared.open(u) }; return true
        case "reveal":
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: d["path"] as! String)]); return true
        case "openApp":
            NSWorkspace.shared.open(URL(fileURLWithPath: d["path"] as! String)); return true
        case "copy":
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(d["text"] as! String, forType: .string); return true
        case "notify":
            notify(d["title"] as? String ?? "Push to Iconik", d["body"] as? String ?? ""); return true
        case "agent":
            return ["installed": agentInstalled(), "running": agentRunning()]
        case "autofill":
            openAutofill(jobId: d["jobId"] as! String, url: d["url"] as! String, title: d["title"] as? String ?? "Iconik Autofill",
                         front: d["front"] as? Bool ?? true)
            return true
        case "closeAutofill":
            autofillWindows[d["jobId"] as! String]?.close(); return true
        case "install":
            return try install()
        case "desktopAlias":
            return try desktopAlias()
        case "show":
            showMain(); return true
        case "bounce":
            NSApp.requestUserAttention(.informationalRequest); return true
        case "badge":
            NSApp.dockTile.badgeLabel = (d["text"] as? String).flatMap { $0.isEmpty ? nil : $0 }; return true
        case "update":
            // Re-runs the team installer (downloads the newest zip, replaces this app, relaunches it).
            let p = Process(); p.launchPath = "/bin/bash"
            p.arguments = ["-c", "curl -fsSL \(SITE)app/install.sh | bash -s -- --relaunch >> \"\(SUPPORT.path)/update.log\" 2>&1"]
            try p.run()
            return true
        case "log":
            log("page: \(d["text"] as? String ?? "")"); return true
        default:
            throw WorkerError(message: "unknown command \(cmd)")
        }
    }

    /// Testing only (launched with PTI_DEV=1): runs Support/dev.js in the page and writes the result to dev.out.
    func startDevHook() {
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            let f = SUPPORT.appendingPathComponent("dev.js")
            guard let js = try? String(contentsOf: f, encoding: .utf8) else { return }
            try? FileManager.default.removeItem(at: f)
            self?.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                let out: String
                switch r { case .success(let v): out = "\(v)"; case .failure(let e): out = "ERROR \(e)" }
                try? out.write(to: SUPPORT.appendingPathComponent("dev.out"), atomically: true, encoding: .utf8)
            }
        }
    }

    func agentInstalled() -> Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "io.iconik.desktopagent") != nil
            || FileManager.default.fileExists(atPath: "/Applications/iconik Agent.app")
    }
    func agentRunning() -> Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: "io.iconik.desktopagent").isEmpty }

    func notify(_ title: String, _ body: String) {
        let c = UNMutableNotificationContent(); c.title = title; c.body = body; c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) { err in
            if err != nil {    // notifications off / not allowed: fall back to AppleScript's
                let p = Process(); p.launchPath = "/usr/bin/osascript"
                p.arguments = ["-e", "display notification \(Self.asq(body)) with title \(Self.asq(title))"]
                try? p.run()
            }
        }
    }
    static func asq(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }

    /// Copies the app into /Applications (if it isn't there) and relaunches from there.
    func install() throws -> Any {
        let here = Bundle.main.bundleURL
        let dest = URL(fileURLWithPath: "/Applications/Push to Iconik.app")
        if here.path == dest.path { return ["moved": false] }
        if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.trashItem(at: dest, resultingItemURL: nil) }
        try FileManager.default.copyItem(at: here, to: dest)
        _ = try? desktopAlias(target: dest)
        let p = Process(); p.launchPath = "/usr/bin/open"; p.arguments = ["-n", dest.path]
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { try? p.run(); NSApp.terminate(nil) }
        return ["moved": true]
    }
    /// Desktop shortcut (a symlink: Finder shows it with the app's icon and double-click opens the app).
    func desktopAlias(target: URL? = nil) throws -> Any {
        let t = target ?? Bundle.main.bundleURL
        let link = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop/Push to Iconik")
        try? FileManager.default.removeItem(at: link)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: t)
        return true
    }

    /// Iconik Autofill in its own window, already signed in with the team key. Its Push to Iconik reply comes back
    /// to the main page as an "autofill" event, so the job can be marked done.
    func openAutofill(jobId: String, url: String, title: String, front: Bool) {
        if let w = autofillWindows[jobId] { w.close() }
        let cfg = WKWebViewConfiguration()
        let uc = cfg.userContentController
        uc.add(self, name: "autofill")
        let keyJS = (try? String(data: JSONSerialization.data(withJSONObject: [pushKey ?? ""]), encoding: .utf8)!) ?? "[\"\"]"
        let jobJS = (try? String(data: JSONSerialization.data(withJSONObject: [jobId]), encoding: .utf8)!) ?? "[\"\"]"
        let js = """
        (function(){
          const KEY = \(keyJS)[0], JOB = \(jobJS)[0];
          try { if (KEY) localStorage.setItem('iconikPushKey', KEY); } catch (e) {}
          const post = (m) => { try { window.webkit.messageHandlers.autofill.postMessage(Object.assign({jobId: JOB}, m)); } catch (e) {} };
          const f = window.fetch;
          window.fetch = async function(input, init) {
            const u = String((input && input.url) || input || '');
            const isPush = /\\/iconik\\/push/.test(u) && init && String(init.method || '').toUpperCase() === 'POST';
            let res;
            try { res = await f.apply(this, arguments); }
            catch (e) { if (isPush) post({status: 0, error: String(e && e.message || e)}); throw e; }
            if (isPush) {
              let dry = false; try { dry = !!JSON.parse(init.body).dryRun; } catch (e) {}
              res.clone().json().then(j => post({status: res.status, body: j, dry})).catch(() => post({status: res.status, dry}));
            }
            return res;
          };
          window.addEventListener('error', e => post({pageError: String(e.message || e)}));
        })();
        """
        uc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.uiDelegate = self
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 860),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = title
        w.contentView = wv
        w.isReleasedWhenClosed = false
        w.setFrameAutosaveName("PushToIconikAutofill")
        if !w.setFrameUsingName("PushToIconikAutofill") { w.center() }
        autofillWindows[jobId] = w
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in
            uc.removeScriptMessageHandler(forName: "autofill")
            self?.autofillWindows[jobId] = nil
            self?.send("autofillClosed", ["jobId": jobId])
        }
        wv.load(URLRequest(url: URL(string: url)!))
        if front { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) } else { w.orderBack(nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
