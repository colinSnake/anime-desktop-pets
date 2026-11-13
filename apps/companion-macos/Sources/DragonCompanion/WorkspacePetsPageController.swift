import AppKit
import SwiftUI

@MainActor
final class WorkspacePetsPageModel: ObservableObject {
    @Published var status = ""
    @Published var visible = false
    @Published var paused = false
    @Published var canToggle = false
    @Published var canPause = false
    @Published var canAdd = false
    @Published var instances: [WorkspacePetInstance] = []
    let actions: CompanionWorkspaceWindow.Actions

    init(actions: CompanionWorkspaceWindow.Actions) { self.actions = actions }

    func refresh() {
        status = actions.petStatus()
        visible = actions.petIsVisible()
        paused = actions.isPaused()
        canToggle = actions.canControlPets()
        canPause = actions.canTogglePause()
        canAdd = actions.canManagePets()
        instances = actions.petInstances()
    }
}

@MainActor
final class WorkspacePetsPageController: NSHostingController<WorkspacePetsPage> {
    private let model: WorkspacePetsPageModel

    init(actions: CompanionWorkspaceWindow.Actions) {
        model = WorkspacePetsPageModel(actions: actions)
        super.init(rootView: WorkspacePetsPage(model: model))
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    override func viewWillAppear() { super.viewWillAppear(); refresh() }
    func refresh() { model.refresh() }
}

struct WorkspacePetsPage: View {
    @ObservedObject var model: WorkspacePetsPageModel
    private let columns = [GridItem(.adaptive(minimum: 190, maximum: 280), spacing: 14, alignment: .top)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { heading; status }
                    VStack(alignment: .leading, spacing: 8) { heading; status }
                }
                VStack(alignment: .leading, spacing: 16) {
                    WorkspaceToggleRow(title: "显示桌宠", isOn: model.visible, enabled: model.canToggle) {
                        model.actions.togglePet(); model.refresh()
                    }
                    WorkspaceToggleRow(title: "暂停联动", isOn: model.paused, enabled: model.canPause) {
                        model.actions.togglePause(); model.refresh()
                    }
                }
                Divider()
                    .padding(.vertical, 2)
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 6) {
                        Text("我的桌宠").font(.system(size: 15, weight: .semibold))
                        Text("（\(model.instances.count)）")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                        Spacer()
                        Button { model.actions.managePets() } label: {
                            Label("添加桌宠", systemImage: "plus")
                                .foregroundStyle(Color(nsColor: .labelColor))
                        }
                            .buttonStyle(WorkspaceActionButtonStyle(compact: true)).disabled(!model.canAdd)
                    }
                    if model.instances.isEmpty {
                        Text("还没有桌宠实例，添加一只开始陪伴。")
                            .foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 150)
                    } else {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                            ForEach(model.instances) { instance in
                                WorkspacePetInstanceCard(instance: instance, toggle: {
                                    model.actions.toggleInstance(instance.id); model.refresh()
                                }, clone: {
                                    model.actions.cloneInstance(instance.id); model.refresh()
                                }, delete: {
                                    model.actions.deleteInstance(instance.id); model.refresh()
                                })
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Color(nsColor: WorkspacePalette.canvas))
        .tint(Color(nsColor: WorkspacePalette.accent))
    }

    private var heading: some View {
        Text("桌宠控制").font(.system(size: 15, weight: .semibold))
    }
    private var status: some View {
        Text("（\(model.status)）").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}
