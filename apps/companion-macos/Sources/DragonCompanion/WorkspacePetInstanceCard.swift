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
                Color(nsColor: .windowBackgroundColor)
                if let cover {
                    Image(decorative: cover, scale: 2).resizable().scaledToFit().padding(12)
                } else {
                    Image(systemName: "pawprint.fill").font(.system(size: 38)).foregroundStyle(.tertiary)
                }
                HStack(alignment: .top, spacing: 8) {
                    Text(instance.name)
                        .font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(.regularMaterial, in: Capsule())
                    Spacer(minLength: 4)
                    HStack(spacing: 5) {
                        Circle().fill(Color(nsColor: instance.statusColor)).frame(width: 6, height: 6)
                        Text(instance.status).font(.system(size: 10, weight: .medium)).lineLimit(1)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(.regularMaterial, in: Capsule())
                    .help(instance.error ?? instance.status)
                }
                .padding(9)
            }
            .frame(height: 142)
            .accessibilityLabel("\(instance.name)，\(instance.status)")

            VStack(alignment: .leading, spacing: 9) {
                if let error = instance.error, !error.isEmpty {
                    Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(1).help(error)
                }
                HStack(spacing: 8) {
                    Button(action: toggle) {
                        Label(instance.isRunning ? "停止实例" : "启动实例",
                              systemImage: instance.isRunning ? "stop.fill" : "play.fill")
                            .frame(maxWidth: .infinity).frame(height: 30)
                    }
                    .buttonStyle(WorkspacePetActionButtonStyle(prominent: instance.isRunning))
                    .disabled(!instance.canToggle)

                    if instance.isClone {
                        Button(action: delete) {
                            Label("删除实例", systemImage: "trash")
                                .frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(WorkspacePetActionButtonStyle(prominent: false))
                        .disabled(!instance.canDelete)
                        .help(instance.canDelete ? "删除已停止的分身" : "请先停止分身后再删除")
                    } else {
                        Button(action: clone) {
                            Label("创建分身", systemImage: "plus")
                                .frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(WorkspacePetActionButtonStyle(prominent: false))
                        .disabled(!instance.canClone)
                    }
                }
                .font(.system(size: 11, weight: .medium))
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(Color(nsColor: .separatorColor).opacity(0.55), lineWidth: 0.7))
        .task(id: instance.cover) { cover = await PetCoverLoader.shared.image(for: instance.cover) }
    }
}

private struct WorkspacePetActionButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(prominent
                          ? Color.black.opacity(configuration.isPressed ? 0.72 : 1)
                          : Color(nsColor: .quaternaryLabelColor).opacity(configuration.isPressed ? 0.34 : 0.2))
            }
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(prominent ? Color.clear : Color(nsColor: .separatorColor).opacity(0.7), lineWidth: 0.7))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
