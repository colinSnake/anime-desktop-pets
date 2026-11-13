import AppKit
import SwiftUI

@MainActor
final class WorkspaceShellModel: ObservableObject {
    @Published private(set) var selected: WorkspaceSection
    @Published private(set) var theme: CompanionWorkspaceWindow.Theme
    @Published private(set) var serviceConnected = false
    var onSelect: ((WorkspaceSection) -> Void)?
    var onThemeChanged: ((CompanionWorkspaceWindow.Theme) -> Void)?

    init(section: WorkspaceSection) {
        selected = section
        theme = CompanionWorkspaceWindow.Theme(rawValue: UserDefaults.standard.integer(forKey: "workspaceTheme")) ?? .system
    }

    func select(_ section: WorkspaceSection) {
        guard selected != section else { return }
        onSelect?(section)
        selected = section
    }

    func cycleTheme() {
        let cases = CompanionWorkspaceWindow.Theme.allCases
        let next = cases[(theme.rawValue + 1) % cases.count]
        theme = next
        UserDefaults.standard.set(next.rawValue, forKey: "workspaceTheme")
        onThemeChanged?(next)
    }

    func refreshStatus(_ connected: Bool) {
        serviceConnected = connected
    }
}

struct WorkspaceShellView: View {
    @ObservedObject var model: WorkspaceShellModel
    let modules: [WorkspaceSection: NSViewController]
    let isServiceConnected: () -> Bool
    let tagline: String
    let appIcon: NSImage?

    private let groups: [(String, [WorkspaceSection])] = [
        ("梦境区", [.pets, .characterChat, .character, .characterMemories, .characterCapabilities]),
        ("工作区", [.models, .speech, .live]),
        ("系统区", [.advanced]),
    ]

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Rectangle().fill(Color(nsColor: .separatorColor).opacity(0.55)).frame(height: 1)
            HStack(spacing: 0) {
                sidebar
                    .frame(width: 200)
                Rectangle().fill(Color(nsColor: .separatorColor).opacity(0.55)).frame(width: 1)
                detail
            }
        }
        .background(Color(nsColor: .windowBackgroundColor).ignoresSafeArea())
        .preferredColorScheme(model.theme.preferredColorScheme)
        .onAppear { model.refreshStatus(isServiceConnected()) }
        .onChange(of: model.selected) { section in
            if section == .pets { model.refreshStatus(isServiceConnected()) }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Button { model.select(.pets) } label: {
                Group {
                    if let appIcon { Image(nsImage: appIcon).resizable().scaledToFit() }
                    else { Image(systemName: "pawprint.fill").font(.system(size: 19, weight: .medium)) }
                }
                .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .help("打开桌宠工作区")
            .accessibilityLabel("打开桌宠工作区")
            Text("桌边小崽").font(.system(size: 13, weight: .semibold))
            Spacer()
            Button(action: model.cycleTheme) {
                Image(systemName: model.theme.symbol)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("外观：\(model.theme.title)（点击切换）")
            .accessibilityLabel("外观：\(model.theme.title)")
        }
        .padding(.horizontal, 18)
        .frame(height: 48)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(groups, id: \.0) { title, sections in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10)
                                .padding(.bottom, 2)
                            ForEach(sections, id: \.self) { section in
                                navigationButton(section)
                            }
                        }
                    }
                }
                .padding(.top, 20)
                .padding(.horizontal, 12)
            }
            Divider().padding(.horizontal, 14).padding(.top, 10)
            Text(tagline)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
        }
        .background(Color(nsColor: NSColor(name: "WorkspaceSidebar") { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedRed: 0.18, green: 0.19, blue: 0.22, alpha: 1)
                : NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.98, alpha: 1)
        }))
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(model.selected.rawValue).font(.system(size: 24, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if model.selected == .pets {
                    Circle().fill(model.serviceConnected ? Color.green : Color.secondary.opacity(0.6))
                        .frame(width: 8, height: 8)
                    Text(model.serviceConnected ? "已连接" : "未连接")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(model.serviceConnected ? Color.green : Color.secondary)
                }
            }
            .padding(.horizontal, 34)
            .padding(.top, 20)
            .padding(.bottom, 20)
            if let controller = modules[model.selected] {
                WorkspaceModuleHost(controller: controller)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 20)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "rectangle.slash").foregroundStyle(.secondary)
                    Text("页面不可用").font(.system(size: 13)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func navigationButton(_ section: WorkspaceSection) -> some View {
        WorkspaceNavigationButton(section: section, selected: model.selected == section) {
            model.select(section)
        }
    }
}

private struct WorkspaceModuleHost: NSViewControllerRepresentable {
    let controller: NSViewController

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSViewController(context: Context) -> NSViewController {
        let container = NSViewController()
        container.view = NSView()
        attach(controller, to: container)
        context.coordinator.current = controller
        return container
    }

    func updateNSViewController(_ container: NSViewController, context: Context) {
        guard context.coordinator.current !== controller else { return }
        context.coordinator.current?.view.removeFromSuperview()
        context.coordinator.current?.removeFromParent()
        attach(controller, to: container)
        context.coordinator.current = controller
    }

    static func dismantleNSViewController(_ container: NSViewController, coordinator: Coordinator) {
        coordinator.current?.view.removeFromSuperview()
        coordinator.current?.removeFromParent()
        coordinator.current = nil
    }

    private func attach(_ child: NSViewController, to parent: NSViewController) {
        parent.addChild(child)
        let childView = child.view
        childView.translatesAutoresizingMaskIntoConstraints = false
        parent.view.addSubview(childView)
        NSLayoutConstraint.activate([
            childView.leadingAnchor.constraint(equalTo: parent.view.leadingAnchor),
            childView.trailingAnchor.constraint(equalTo: parent.view.trailingAnchor),
            childView.topAnchor.constraint(equalTo: parent.view.topAnchor),
            childView.bottomAnchor.constraint(equalTo: parent.view.bottomAnchor),
        ])
    }

    final class Coordinator {
        var current: NSViewController?
    }
}
