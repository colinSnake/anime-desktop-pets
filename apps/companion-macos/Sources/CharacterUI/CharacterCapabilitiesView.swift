import CharacterCore
import SwiftUI

struct CharacterCapabilitiesView: View {
    let capabilities: [CharacterCapability]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CharacterSectionHeader(
                title: "当前能力",
                subtitle: "状态来自应用配置和运行时，不由模型或角色资料决定。"
            )
            ScrollView {
                LazyVStack(spacing: 10) {
                    if capabilities.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "bolt.badge.clock")
                                .font(.system(size: 24))
                                .foregroundStyle(.secondary)
                            Text("暂无能力状态").font(.headline)
                            Text("应用加载运行状态后会显示在这里。")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 160)
                    }
                    ForEach(capabilities) { item in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: icon(for: item.status))
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(color(for: item.status))
                                .frame(width: 24, height: 24)
                            VStack(alignment: .leading, spacing: 5) {
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Text(item.name).font(.headline)
                                    Spacer(minLength: 8)
                                    Text(item.status.rawValue)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(color(for: item.status))
                                }
                                Text(item.detail)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(CharacterUIStyle.cardBackground)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 10)
                                        .stroke(CharacterUIStyle.border, lineWidth: 0.5)
                                }
                        }
                    }
                }
            }
        }
        .padding(20)
    }

    private func icon(for status: CharacterCapability.Status) -> String {
        switch status {
        case .enabled: "checkmark.circle.fill"
        case .needsSetup: "slider.horizontal.3"
        case .unavailable: "exclamationmark.circle"
        case .planned: "minus.circle"
        case .onDemand: "clock"
        }
    }

    private func color(for status: CharacterCapability.Status) -> Color {
        switch status {
        case .enabled: .green
        case .needsSetup: .orange
        case .unavailable: .red
        case .planned: .secondary
        case .onDemand: .secondary
        }
    }
}
