import SwiftUI

enum PetSourceCoverState {
    case loading
    case ready(CGImage)
    case unavailable
}

/// Selection lives on the cover; the only explicit card action opens its source folder.
struct PetManagerSourceCard: View {
    static let width: CGFloat = 140
    static let coverHeight: CGFloat = 120
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
                        VStack(spacing: 0) {
                            HStack(alignment: .top, spacing: 6) {
                                Text(source.name)
                                    .font(.system(size: 9, weight: .semibold))
                                    .lineLimit(1).truncationMode(.tail)
                                    .help(source.name)
                                    .padding(.horizontal, 5).padding(.vertical, 3)
                                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                                Spacer(minLength: 0)
                                Text("\(source.actionCount) 个动作").lineLimit(1).fixedSize()
                                    .padding(.horizontal, 5).padding(.vertical, 3)
                                    .background(.regularMaterial, in: Capsule())
                            }
                            Spacer(minLength: 0)
                            HStack(alignment: .bottom, spacing: 6) {
                                Spacer(minLength: 0)
                                Text("v\(source.version)")
                                    .font(.system(size: 8, weight: .medium))
                                    .lineLimit(1).truncationMode(.middle)
                                    .help("版本 \(source.version)")
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 5).padding(.vertical, 3)
                                    .background(.regularMaterial, in: Capsule())
                            }
                        }
                        .font(.system(size: 9, weight: .medium))
                        .padding(7)
                    }
                    .frame(height: Self.coverHeight)
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
            .padding(8)
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
                .padding(.horizontal, 10).padding(.top, 28).padding(.bottom, 24)
        case .unavailable:
            Text("封面暂不可用").font(.system(size: 10)).foregroundStyle(.secondary)
                .padding(.top, 16)
        }
    }
}
