import SwiftUI

enum PetSourceCoverState {
    case loading
    case ready(CGImage)
    case unavailable
}

/// Selection lives on the cover; the only explicit card action opens its source folder.
struct PetManagerSourceCard: View {
    static let width: CGFloat = 160
    let source: LocalPetSource
    let cover: PetSourceCoverState
    let selected: Bool
    let busy: Bool
    let select: () -> Void
    let reveal: () -> Void

    private var cardFill: Color {
        selected ? Color(nsColor: WorkspacePalette.accent).opacity(0.12) : Color(nsColor: .controlBackgroundColor)
    }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: select) {
                VStack(alignment: .leading, spacing: 0) {
                    ZStack(alignment: .top) {
                        Color(nsColor: .windowBackgroundColor)
                        coverContent
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        HStack(alignment: .top, spacing: 6) {
                            Text(source.builtin ? "内置桌宠" : "v\(source.version)")
                                .lineLimit(1).truncationMode(.middle)
                                .help(source.builtin ? "内置桌宠" : "版本 \(source.version)")
                                .padding(.horizontal, 6).padding(.vertical, 4)
                                .background(.regularMaterial, in: Capsule())
                            Spacer(minLength: 0)
                            Text("\(source.actionCount) 个动作").lineLimit(1).fixedSize()
                                .padding(.horizontal, 6).padding(.vertical, 4)
                                .background(.regularMaterial, in: Capsule())
                        }
                        .font(.system(size: 9, weight: .medium))
                        .padding(7)
                    }
                    .frame(height: 118)
                    Text(source.name)
                        .font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .frame(height: 20)
                        .padding(.horizontal, 8).padding(.top, 6)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("选择\(source.name)；按 ⌘ 或 ⇧ 可多选")
            .accessibilityLabel("\(selected ? "取消选择" : "选择")\(source.name)")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .disabled(busy)

            Button(action: reveal) {
                Text("查看目录").frame(maxWidth: .infinity)
            }
            .buttonStyle(WorkspaceActionButtonStyle(compact: true))
            .help(source.path)
            .accessibilityLabel("在 Finder 中查看\(source.name)的素材目录")
            .padding(10)
        }
        // Reserve a border lane outside the clipped content. Cover images, material badges
        // and button drawing must not share the border's pixels, including in a scroll view.
        // Keep this inset constant so selection never changes the content's geometry.
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(2)
        .frame(width: Self.width)
        .background(cardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(selected ? Color(nsColor: WorkspacePalette.accent) : Color(nsColor: .separatorColor).opacity(0.55),
                    lineWidth: selected ? 2 : 1)
            .allowsHitTesting(false))
    }

    @ViewBuilder
    private var coverContent: some View {
        switch cover {
        case .loading:
            ProgressView().controlSize(.small).accessibilityLabel("正在生成封面")
        case .ready(let image):
            Image(decorative: image, scale: 2).resizable().scaledToFit()
                .padding(.horizontal, 12).padding(.top, 28).padding(.bottom, 6)
        case .unavailable:
            Text("封面暂不可用").font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.top, 20)
        }
    }
}
