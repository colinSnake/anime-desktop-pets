import SwiftUI

enum WorkspacePalette {
    static let accent = NSColor(calibratedRed: 0.39, green: 0.31, blue: 0.82, alpha: 1)
}

struct WorkspacePageHeading: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 18, weight: .semibold))
            if !subtitle.isEmpty {
                Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.bottom, 2)
    }
}

struct WorkspaceSectionCard<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 0.5))
    }
}

/// 工作区统一使用原生小号开关，保留键盘与辅助功能语义。
struct WorkspaceToggleRow: View {
    let title: String
    let isOn: Bool
    let enabled: Bool
    let perform: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 13)).foregroundStyle(.primary)
            Spacer(minLength: 12)
            Toggle(title, isOn: Binding(get: { isOn }, set: { _ in perform() }))
                .labelsHidden().toggleStyle(.switch).controlSize(.mini).tint(Color(nsColor: WorkspacePalette.accent))
                .fixedSize().accessibilityLabel(title)
        }
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .contentShape(Rectangle())
        .disabled(!enabled)
    }
}
