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
            List(capabilities) { item in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: icon(for: item.status)).foregroundStyle(color(for: item.status))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(item.name).font(.headline)
                            Spacer()
                            Text(item.status.rawValue).foregroundStyle(color(for: item.status))
                        }
                        Text(item.detail).font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            .listStyle(.inset)
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
