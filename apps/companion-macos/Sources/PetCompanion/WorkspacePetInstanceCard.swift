import SwiftUI

struct WorkspacePetInstanceCard: View {
    let instance: WorkspacePetInstance
    let toggle: () -> Void
    let clone: () -> Void
    let delete: () -> Void
    @State private var cover: CGImage?

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                Color(nsColor: WorkspacePalette.card)
                Group {
                    if let cover {
                        Image(decorative: cover, scale: 2).resizable().scaledToFit().padding(10)
                    } else {
                        Image(systemName: "pawprint.fill").font(.system(size: 32)).foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                HStack(alignment: .top, spacing: 8) {
                    Text(instance.name)
                        .font(.system(size: 11, weight: .semibold)).lineLimit(1)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(.regularMaterial, in: Capsule())
                    Spacer(minLength: 4)
                    HStack(spacing: 5) {
                        Circle().fill(Color(nsColor: instance.statusColor)).frame(width: 6, height: 6)
                        Text(instance.status).font(.system(size: 9, weight: .medium)).lineLimit(1)
                    }
                    .padding(.horizontal, 7).padding(.vertical, 5)
                    .background(.regularMaterial, in: Capsule())
                    .help(instance.error ?? instance.status)
                }
                .padding(8)
            }
            .frame(height: 124)
            .accessibilityLabel("\(instance.name)，\(instance.status)")

            VStack(alignment: .leading, spacing: 7) {
                if let error = instance.error, !error.isEmpty {
                    Text(error).font(.system(size: 9)).foregroundStyle(.red).lineLimit(1).help(error)
                }
                HStack(spacing: 6) {
                    Button(action: toggle) {
                        Text(instance.isRunning ? "停止实例" : "启动实例")
                            .frame(maxWidth: .infinity).frame(height: 26)
                    }
                    .buttonStyle(WorkspacePetActionButtonStyle(prominent: instance.isRunning))
                    .disabled(!instance.canToggle)

                    if instance.isClone {
                        Button(action: delete) {
                            Text("删除实例")
                                .frame(maxWidth: .infinity).frame(height: 26)
                        }
                        .buttonStyle(WorkspacePetActionButtonStyle(prominent: false))
                        .disabled(!instance.canDelete)
                        .help(instance.canDelete ? "删除已停止的分身" : "请先停止分身后再删除")
                    } else {
                        Button(action: clone) {
                            Text("创建分身")
                                .frame(maxWidth: .infinity).frame(height: 26)
                        }
                        .buttonStyle(WorkspacePetActionButtonStyle(prominent: false))
                        .disabled(!instance.canClone)
                    }
                }
                .font(.system(size: 10, weight: .medium))
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: WorkspacePalette.canvas))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color(nsColor: WorkspacePalette.border), lineWidth: 0.7))
        .task(id: instance.cover) { cover = await PetCoverLoader.shared.image(for: instance.cover) }
    }
}

private struct WorkspacePetActionButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(prominent ? Color(nsColor: WorkspacePalette.canvas) : Color.primary)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(prominent
                          ? Color.primary
                          : Color(nsColor: WorkspacePalette.input))
            }
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(prominent ? Color.clear : Color(nsColor: WorkspacePalette.border), lineWidth: 0.7))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.6)
    }
}
