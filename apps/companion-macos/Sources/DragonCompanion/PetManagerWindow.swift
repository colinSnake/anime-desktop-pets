import AppKit
import DragonCore
import SwiftUI

@MainActor
final class PetManagerWindow: NSWindowController, NSWindowDelegate, ObservableObject {
    var addPackages: (([PetPackageReference], @escaping (Result<String, Error>) -> Void) -> Void)?

    private let runtime: Runtime
    typealias CoverOperation = @Sendable (PetCoverSource) async -> CGImage?
    private let loadCover: CoverOperation
    private var coverTask: Task<Void, Never>?
    private var scanID = UUID()
    @Published private(set) var covers: [String: PetSourceCoverState] = [:]

    typealias SourceOperation = @Sendable (String, [String]) async throws -> LocalPetToolReply
    private let sourceOperation: SourceOperation
    private let foldersURL: URL
    private weak var presentingWindow: NSWindow?
    private var outsideClickMonitor: Any?
    private var roots: [String] = []
    private var selectionAnchor: String?

    @Published private(set) var sources: [LocalPetSource] = []
    @Published private(set) var selectedPaths = Set<String>()
    @Published private(set) var status = "正在读取本地桌宠…"
    @Published private(set) var busy = false
    @Published var query = ""

    var filteredSources: [LocalPetSource] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return sources }
        return sources.filter {
            $0.name.localizedCaseInsensitiveContains(value)
                || $0.version.localizedCaseInsensitiveContains(value)
                || $0.path.localizedCaseInsensitiveContains(value)
        }
    }

    var selectedCount: Int { selectedPaths.count }
    var canAdd: Bool { !busy && (1...16).contains(selectedCount) }

    init(runtime: Runtime, sourceOperation: SourceOperation? = nil,
         loadCover: @escaping CoverOperation = { await PetCoverLoader.shared.image(for: $0, refresh: true) }) throws {
        self.runtime = runtime
        self.loadCover = loadCover
        if let sourceOperation {
            self.sourceOperation = sourceOperation
        } else {
            let tool = try PetSourceTool(runtime: runtime)
            self.sourceOperation = { operation, paths in try await tool.run(operation: operation, paths: paths) }
        }
        foldersURL = runtime.state.appendingPathComponent("pet-search-folders.json")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 420),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "添加桌宠"
        window.minSize = NSSize(width: 580, height: 360)
        window.maxSize = NSSize(width: 900, height: 620)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: PetManagerPage(model: self))
        loadRoots()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    deinit { coverTask?.cancel() }

    private func loadRoots() {
        let hints = runtime.resources.appendingPathComponent("pet-search-directories.json")
        for url in [foldersURL, hints] {
            if let data = try? Data(contentsOf: url), data.count <= 64 * 1024,
               let paths = try? JSONDecoder().decode([String].self, from: data) {
                for path in paths where path != runtime.petLibraryURL.path && !roots.contains(path) && roots.count < 31 {
                    roots.append(path)
                }
            }
        }
        if !roots.contains(runtime.petLibraryURL.path) { roots.append(runtime.petLibraryURL.path) }
    }

    func open(parentWindow: NSWindow? = nil) {
        if let parentWindow, let window {
            presentingWindow = parentWindow
            window.appearance = parentWindow.appearance
            if window.sheetParent == nil { parentWindow.beginSheet(window) }
            else { window.makeKeyAndOrderFront(nil) }
            installOutsideClickMonitor()
        } else {
            presentingWindow = nil
            window?.center()
            showWindow(nil)
            window?.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        if !busy { rescan() }
    }

    private func installOutsideClickMonitor() {
        guard outsideClickMonitor == nil else { return }
        outsideClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self, let parent = self.presentingWindow,
                  let sheet = self.window, parent.isVisible,
                  event.window === parent || event.window === sheet else { return event }
            let point = event.window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation
            guard parent.frame.contains(point), !sheet.frame.contains(point) else { return event }
            self.dismissManager()
            return nil
        }
    }

    private func removeOutsideClickMonitor() {
        guard let outsideClickMonitor else { return }
        NSEvent.removeMonitor(outsideClickMonitor)
        self.outsideClickMonitor = nil
    }

    func dismissManager() {
        guard let window else { return }
        removeOutsideClickMonitor()
        if let parent = window.sheetParent { parent.endSheet(window, returnCode: .cancel) }
        else { window.close() }
    }

    func chooseRoots() {
        guard !busy, let window else { return }
        let panel = NSOpenPanel()
        panel.title = "选择桌宠所在目录或 .petpack 文件"
        panel.prompt = "读取桌宠"
        panel.message = "可同时选择多个目录。支持含 manifest.json 的桌宠目录和 .petpack；普通应用或图片目录不会作为可运行桌宠添加。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.treatsFilePackagesAsDirectories = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self else { return }
            var updated = self.roots
            for url in panel.urls where !updated.contains(url.path) { updated.append(url.path) }
            guard updated.count <= 32 else {
                self.status = "最多保留32个扫描目录；请减少本次选择。"
                return
            }
            self.roots = updated
            do {
                try JSONEncoder().encode(updated).write(to: self.foldersURL, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.foldersURL.path)
            } catch {
                self.status = "无法保存目录选择：\(error.localizedDescription)"
                return
            }
            self.rescan()
        }
    }

    func rescan() {
        guard !busy else { return }
        coverTask?.cancel()
        scanID = UUID()
        setBusy(true, message: "正在扫描本地目录…")
        let sourceOperation = sourceOperation
        let paths = roots
        Task { @MainActor [weak self] in
            do {
                let result = try await sourceOperation("scan", paths)
                guard let self else { return }
                self.sources = result.pets ?? []
                self.prepareCovers(self.sources)
                self.selectedPaths.removeAll()
                self.selectionAnchor = nil
                let warnings = (result.warnings ?? []).joined(separator: "；")
                self.status = self.sources.isEmpty
                    ? "未发现兼容桌宠；请选择其它目录。\(warnings)"
                    : "发现\(self.sources.count)只桌宠，按 ⌘ 或 ⇧ 可多选。\(warnings)"
                self.busy = false
            } catch {
                guard let self else { return }
                self.status = error.localizedDescription
                self.busy = false
                self.covers = self.covers.mapValues { state in
                    if case .loading = state { return .unavailable }
                    return state
                }
            }
        }
    }

    /// Scanning/addition remains usable while one background decoder prepares bounded thumbnails.
    private func prepareCovers(_ sources: [LocalPetSource]) {
        covers = Dictionary(sources.map { ($0.path, .loading) }, uniquingKeysWith: { first, _ in first })
        let generation = scanID
        let loadCover = loadCover
        coverTask = Task { @MainActor [weak self] in
            for source in sources {
                guard !Task.isCancelled else { return }
                let request = PetCoverSource(directory: URL(fileURLWithPath: source.path),
                                             isPackage: !source.builtin, fallback: nil, maximumPixelSize: 256)
                let image = await loadCover(request)
                guard !Task.isCancelled, let self, self.scanID == generation else { return }
                self.covers[source.path] = image.map(PetSourceCoverState.ready) ?? .unavailable
            }
        }
    }

    func selectSource(_ path: String, modifiers: NSEvent.ModifierFlags = NSEvent.modifierFlags) {
        guard !busy, let index = filteredSources.firstIndex(where: { $0.path == path }) else { return }
        let visible = filteredSources.map(\.path)
        if modifiers.contains(.shift), let anchor = selectionAnchor,
           let anchorIndex = visible.firstIndex(of: anchor) {
            let range = min(index, anchorIndex)...max(index, anchorIndex)
            selectedPaths.formUnion(range.map { visible[$0] })
        } else if modifiers.contains(.command) || modifiers.contains(.control) {
            if !selectedPaths.insert(path).inserted { selectedPaths.remove(path) }
            selectionAnchor = path
        } else {
            selectedPaths = [path]
            selectionAnchor = path
        }
        updateSelectionStatus()
    }

    func selectAllVisible() {
        guard !busy else { return }
        selectedPaths.formUnion(filteredSources.map(\.path))
        updateSelectionStatus()
    }

    func queryChanged() {
        updateSelectionStatus()
    }

    private func updateSelectionStatus() {
        if selectedCount > 16 {
            status = "一次最多添加16只，请减少选择。"
        } else if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && filteredSources.isEmpty {
            status = selectedCount == 0 ? "没有匹配的桌宠。" : "没有匹配项；仍保留已选\(selectedCount)只。"
        } else if sources.isEmpty {
            status = "未发现兼容桌宠；请选择其它目录。"
        } else {
            status = "已选择\(selectedCount)只；新桌宠添加后保持停止。"
        }
    }

    func addSelected() {
        let selected = sources.filter { selectedPaths.contains($0.path) }
        guard canAdd else { return }
        setBusy(true, message: "正在校验并添加\(selected.count)只桌宠；大动画可能需要一些时间…")
        let sourceOperation = sourceOperation
        Task { @MainActor [weak self] in
            do {
                let result = try await sourceOperation("prepare", selected.map(\.path))
                guard let self else { return }
                let failures = (result.failures ?? []).joined(separator: "；")
                guard let packages = result.packages, !packages.isEmpty else {
                    self.setBusy(false, message: "未添加桌宠。\(failures)")
                    return
                }
                guard let add = self.addPackages else {
                    self.setBusy(false, message: "实例控制器不可用；素材已校验，但未登记桌宠。")
                    return
                }
                add(packages) { [weak self] outcome in
                    guard let self else { return }
                    switch outcome {
                    case .success(let message): self.setBusy(false, message: message + (failures.isEmpty ? "" : "；部分未添加：" + failures))
                    case .failure(let error): self.setBusy(false, message: error.localizedDescription + (failures.isEmpty ? "" : "；" + failures))
                    }
                }
            } catch {
                self?.setBusy(false, message: error.localizedDescription)
            }
        }
    }

    func revealSourceDirectory(_ path: String) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            status = "桌宠目录已不存在，请刷新列表。"
            return
        }
        let url = URL(fileURLWithPath: path)
        if isDirectory.boolValue { NSWorkspace.shared.open(url) }
        else { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    private func setBusy(_ value: Bool, message: String) {
        busy = value
        status = message
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { true }

    func windowWillClose(_ notification: Notification) {
        removeOutsideClickMonitor()
        presentingWindow = nil
    }
}

private struct PetManagerPage: View {
    @ObservedObject var model: PetManagerWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                WorkspacePageHeading(title: "添加桌宠", subtitle: "")
                Spacer()
                Button(action: model.dismissManager) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain).help("关闭").accessibilityLabel("关闭添加桌宠")
            }
            HStack(spacing: 7) {
                Button(action: model.chooseRoots) { Text("选择素材目录") }
                    .disabled(model.busy)
                Button(action: model.rescan) { Text("刷新") }
                    .disabled(model.busy)
                Button(action: model.selectAllVisible) { Text("全选") }
                    .disabled(model.busy || model.filteredSources.isEmpty)
                TextField("搜索名称、版本或路径", text: $model.query)
                    .textFieldStyle(.roundedBorder).frame(minWidth: 130)
                    .disabled(model.busy)
                Button(action: model.addSelected) { Text("添加") }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(WorkspaceActionButtonStyle(prominent: true, compact: true))
                    .disabled(!model.canAdd)
            }
            .controlSize(.small)
            .buttonStyle(WorkspaceActionButtonStyle(compact: true))

            ScrollView {
                VStack(spacing: 8) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: PetManagerSourceCard.width, maximum: PetManagerSourceCard.width), spacing: 12)],
                              alignment: .leading, spacing: 12) {
                        ForEach(model.filteredSources, id: \.path) { source in
                            PetManagerSourceCard(source: source,
                                                 cover: model.covers[source.path] ?? .loading,
                                                 selected: model.selectedPaths.contains(source.path),
                                                 busy: model.busy,
                                                 select: { model.selectSource(source.path) },
                                                 reveal: { model.revealSourceDirectory(source.path) })
                        }
                    }
                    if model.filteredSources.isEmpty && !model.busy {
                        VStack(spacing: 8) {
                            Image(systemName: model.sources.isEmpty ? "pawprint" : "magnifyingglass")
                                .font(.system(size: 22)).foregroundStyle(.secondary)
                            Text(model.sources.isEmpty ? "没有发现兼容桌宠" : "没有匹配的桌宠")
                                .font(.system(size: 13, weight: .medium))
                            Text("可添加素材目录后重新扫描。")
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 150)
                    }
                }
                // Keep edge cards clear of the scroll viewport's clipping boundary.
                .padding(2)
            }
            .overlay {
                if model.busy && model.sources.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            Text(model.status)
                .font(.system(size: 11)).foregroundStyle(model.selectedCount > 16 ? Color.red : Color.secondary)
                .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("pet-manager-status")
        }
        .padding(16)
        .frame(minWidth: 548, minHeight: 328)
        .tint(Color(nsColor: WorkspacePalette.accent))
        .onChange(of: model.query) { _ in model.queryChanged() }
    }
}
