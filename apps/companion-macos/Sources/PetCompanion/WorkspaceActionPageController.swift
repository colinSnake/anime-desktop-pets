import AppKit
import SwiftUI

@MainActor
final class WorkspaceActionPageController: NSHostingController<WorkspaceActionPage> {
    struct Action {
        let title: () -> String
        let symbol: String
        let run: () -> Void
        var enabled: () -> Bool = { true }
        var isOn: () -> Bool = { false }
        var isToggle = false

        init(_ title: String, symbol: String, run: @escaping () -> Void,
             enabled: @escaping () -> Bool = { true }, isOn: @escaping () -> Bool = { false },
             isToggle: Bool = false) {
            self.title = { title }
            self.symbol = symbol
            self.run = run
            self.enabled = enabled
            self.isOn = isOn
            self.isToggle = isToggle
        }

        init(title: @escaping () -> String, symbol: String, run: @escaping () -> Void,
             enabled: @escaping () -> Bool = { true }, isOn: @escaping () -> Bool = { false },
             isToggle: Bool = false) {
            self.title = title
            self.symbol = symbol
            self.run = run
            self.enabled = enabled
            self.isOn = isOn
            self.isToggle = isToggle
        }
    }

    private let model: WorkspaceActionPageModel

    init(title: String, accent: NSColor, status: @escaping () -> String,
         actionTitle: String = "快捷操作", actions: [Action]) {
        let model = WorkspaceActionPageModel(title: title, accent: accent, status: status,
                                             actionTitle: actionTitle, actions: actions)
        self.model = model
        super.init(rootView: WorkspaceActionPage(model: model))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    override func viewWillAppear() {
        super.viewWillAppear()
        model.refresh()
    }

    func refresh() { model.refresh() }
}

@MainActor
final class WorkspaceActionPageModel: ObservableObject {
    struct Row: Identifiable {
        let id: Int
        let title: String
        let symbol: String
        let enabled: Bool
        let isOn: Bool
        let isToggle: Bool
    }

    let title: String
    let accent: Color
    let actionTitle: String
    private let statusProvider: () -> String
    private let actions: [WorkspaceActionPageController.Action]
    @Published private(set) var status = ""
    @Published private(set) var rows: [Row] = []

    init(title: String, accent: NSColor, status: @escaping () -> String, actionTitle: String,
         actions: [WorkspaceActionPageController.Action]) {
        self.title = title
        self.accent = Color(nsColor: accent)
        statusProvider = status
        self.actionTitle = actionTitle
        self.actions = actions
        refresh()
    }

    func refresh() {
        status = statusProvider()
        rows = actions.enumerated().map { index, action in
            Row(id: index, title: action.title(), symbol: action.symbol,
                enabled: action.enabled(), isOn: action.isOn(), isToggle: action.isToggle)
        }
    }

    func perform(_ id: Int) {
        guard actions.indices.contains(id), actions[id].enabled() else { return }
        actions[id].run()
        refresh()
    }
}

@MainActor
struct WorkspaceActionPage: View {
    @ObservedObject var model: WorkspaceActionPageModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WorkspaceSectionCard(title: "运行状态") {
                    Label(model.status, systemImage: "info.circle")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                WorkspaceSectionCard(title: model.actionTitle) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(model.rows) { row in
                            if row.isToggle {
                                Toggle(row.title, isOn: Binding(
                                    get: { row.isOn },
                                    set: { _ in model.perform(row.id) }
                                ))
                                .disabled(!row.enabled)
                            } else {
                                Button { model.perform(row.id) } label: {
                                    Label(row.title, systemImage: row.symbol)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.bordered)
                                .disabled(!row.enabled)
                            }
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Color(nsColor: WorkspacePalette.canvas))
        .tint(model.accent)
    }
}
