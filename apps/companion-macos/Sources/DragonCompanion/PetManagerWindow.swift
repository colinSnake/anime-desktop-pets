import AppKit
import DragonCore

@MainActor
final class PetManagerWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    var addPackages: (([PetPackageReference], @escaping (Result<String, Error>) -> Void) -> Void)?
    private let runtime: Runtime
    private let tool: PetSourceTool
    private let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "正在读取本地桌宠…")
    private let addButton = NSButton(title: "添加所选", target: nil, action: nil)
    private var controls: [NSButton] = []
    private var roots: [String] = []
    private var sources: [LocalPetSource] = []
    private var busy = false
    private let foldersURL: URL

    init(runtime: Runtime) throws {
        self.runtime = runtime
        tool = try PetSourceTool(runtime: runtime)
        foldersURL = runtime.state.appendingPathComponent("pet-search-folders.json")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 470),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "桌宠管理"
        window.minSize = NSSize(width: 640, height: 380)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        buildContent()
        loadRoots()
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    private func loadRoots() {
        let hints = runtime.resources.appendingPathComponent("pet-search-directories.json")
        for url in [foldersURL, hints] {
            if let data = try? Data(contentsOf: url), data.count <= 64 * 1024,
               let paths = try? JSONDecoder().decode([String].self, from: data) {
                for path in paths where path != runtime.petLibraryURL.path && !roots.contains(path) && roots.count < 31 { roots.append(path) }
            }
        }
        if !roots.contains(runtime.petLibraryURL.path) { roots.append(runtime.petLibraryURL.path) }
    }

    private func buildContent() {
        guard let content = window?.contentView else { return }
        let title = NSTextField(labelWithString: "选择要添加的桌宠")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString: "从本地目录发现桌宠；支持多选。添加后在“实例管理”中启动。")
        note.textColor = .secondaryLabelColor
        let folders = NSButton(title: "选择目录或桌宠包…", target: self, action: #selector(chooseRoots))
        let refresh = NSButton(title: "刷新", target: self, action: #selector(rescan))
        let select = NSButton(title: "全选", target: self, action: #selector(selectAllRows))
        controls = [folders, refresh, select]
        let toolbar = NSStackView(views: controls)
        toolbar.orientation = .horizontal; toolbar.spacing = 8

        for (identifier, title, width) in [("name", "桌宠", 160.0), ("version", "版本", 130.0), ("source", "所在目录", 430.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(identifier))
            column.title = title; column.width = width; column.minWidth = identifier == "source" ? 180 : 90
            table.addTableColumn(column)
        }
        table.allowsMultipleSelection = true
        table.rowHeight = 30
        table.usesAlternatingRowBackgroundColors = true
        table.dataSource = self; table.delegate = self
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true
        scroll.borderType = .bezelBorder
        addButton.target = self; addButton.action = #selector(addSelected)
        addButton.bezelStyle = .rounded; addButton.isEnabled = false
        addButton.keyEquivalent = "\r"
        let footer = NSStackView(views: [status, addButton])
        footer.orientation = .horizontal; footer.spacing = 12
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        addButton.setContentHuggingPriority(.required, for: .horizontal)
        let stack = NSStackView(views: [title, note, toolbar, scroll, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 170),
            note.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    }

    func open() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !busy { rescan() }
    }

    @objc private func chooseRoots() {
        guard !busy, let window else { return }
        let panel = NSOpenPanel()
        panel.title = "选择桌宠所在目录或 .petpack 文件"
        panel.prompt = "读取桌宠"
        panel.message = "可同时选择多个目录。支持含 manifest.json 的桌宠目录和 .petpack；普通应用或图片目录不会作为可运行桌宠添加。"
        panel.canChooseDirectories = true; panel.canChooseFiles = true
        panel.allowsMultipleSelection = true; panel.treatsFilePackagesAsDirectories = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self else { return }
            var updated = self.roots
            for url in panel.urls where !updated.contains(url.path) { updated.append(url.path) }
            guard updated.count <= 32 else {
                self.status.stringValue = "最多保留32个扫描目录；请减少本次选择。"
                return
            }
            self.roots = updated
            do {
                try JSONEncoder().encode(updated).write(to: self.foldersURL, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.foldersURL.path)
            } catch {
                self.status.stringValue = "无法保存目录选择：\(error.localizedDescription)"
                return
            }
            self.rescan()
        }
    }

    private func setBusy(_ value: Bool) {
        busy = value
        for control in controls { control.isEnabled = !value }
        table.isEnabled = !value
        addButton.isEnabled = !value && (1...16).contains(table.selectedRowIndexes.count)
    }

    @objc private func rescan() {
        guard !busy else { return }
        setBusy(true)
        status.stringValue = "正在扫描本地目录…"
        let tool = tool, paths = roots
        Task { @MainActor [weak self] in
            do {
                let result = try await tool.run(operation: "scan", paths: paths)
                guard let self else { return }
                self.sources = result.pets ?? []
                self.table.reloadData()
                self.table.deselectAll(nil)
                let warnings = (result.warnings ?? []).joined(separator: "；")
                self.status.stringValue = self.sources.isEmpty
                    ? "未发现兼容桌宠；请选择其它目录。\(warnings)"
                    : "发现\(self.sources.count)只桌宠，按 ⌘ 或 ⇧ 可多选。\(warnings)"
                self.setBusy(false)
            } catch {
                self?.status.stringValue = error.localizedDescription
                self?.setBusy(false)
            }
        }
    }

    @objc private func selectAllRows() { table.selectAll(nil) }

    @objc private func addSelected() {
        let selected = table.selectedRowIndexes.compactMap { sources.indices.contains($0) ? sources[$0] : nil }
        guard !busy, (1...16).contains(selected.count) else { return }
        setBusy(true)
        status.stringValue = "正在校验并添加\(selected.count)只桌宠；大动画可能需要一些时间…"
        let tool = tool
        Task { @MainActor [weak self] in
            do {
                let result = try await tool.run(operation: "prepare", paths: selected.map(\.path))
                guard let self else { return }
                let failures = (result.failures ?? []).joined(separator: "；")
                guard let packages = result.packages, !packages.isEmpty else {
                    self.status.stringValue = "未添加桌宠。\(failures)"
                    self.setBusy(false)
                    return
                }
                guard let add = self.addPackages else {
                    self.status.stringValue = "实例控制器不可用；素材已校验，但未登记桌宠。"
                    self.setBusy(false)
                    return
                }
                add(packages) { [weak self] outcome in
                    guard let self else { return }
                    switch outcome {
                    case .success(let message): self.status.stringValue = message + (failures.isEmpty ? "" : "；部分未添加：" + failures)
                    case .failure(let error): self.status.stringValue = error.localizedDescription + (failures.isEmpty ? "" : "；" + failures)
                    }
                    self.setBusy(false)
                }
            } catch {
                self?.status.stringValue = error.localizedDescription
                self?.setBusy(false)
            }
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { sources.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard sources.indices.contains(row) else { return nil }
        let source = sources[row]
        let text: String
        switch tableColumn?.identifier.rawValue {
        case "name": text = source.name
        case "version": text = source.builtin ? "当前内置" : source.version
        default: text = source.path
        }
        let label = NSTextField(labelWithString: text)
        label.lineBreakMode = .byTruncatingMiddle
        label.toolTip = source.path
        return label
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !busy else { return }
        let count = table.selectedRowIndexes.count
        addButton.isEnabled = (1...16).contains(count)
        status.stringValue = count > 16 ? "一次最多添加16只，请减少选择。" : "已选择\(count)只；新桌宠添加后保持停止。"
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if busy { status.stringValue = "正在处理桌宠，请完成后再关闭。" }
        return !busy
    }
}
