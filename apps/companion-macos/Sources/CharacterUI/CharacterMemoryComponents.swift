import CharacterCore
import SwiftUI

struct CharacterMemoryEditor: View {
    @Binding var text: String
    let identifier: String
    var placeholder = ""
    @FocusState private var isFocused: Bool

    private var threeLineHeight: CGFloat {
        NSLayoutManager().defaultLineHeight(for: NSFont.preferredFont(forTextStyle: .body)) * 3
    }

    var body: some View {
        CharacterTextEditor(text: $text)
            .font(.body)
            .focused($isFocused)
            .scrollContentBackground(.hidden)
            .frame(height: threeLineHeight)
            .padding(10)
            .modifier(CharacterInputSurface(isFocused: isFocused))
            .overlay(alignment: .topLeading) {
                if text.isEmpty, !placeholder.isEmpty {
                    Text(placeholder)
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 13)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityIdentifier(identifier)
            .onExitCommand { isFocused = false }
    }
}

struct CharacterMemoryTextField: View {
    let title: String
    @Binding var text: String
    let identifier: String
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, text: $text)
                .font(.system(size: 12))
                .textFieldStyle(.plain)
                .padding(.horizontal, 9)
                .frame(height: ManagementControlStyle.compactHeight)
                .modifier(CharacterInputSurface(isFocused: isFocused, cornerRadius: 7))
                .focused($isFocused)
                .accessibilityIdentifier(identifier)
                .onExitCommand { isFocused = false }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}


struct CharacterMemoryCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CharacterUIStyle.cardBackground, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(CharacterUIStyle.border, lineWidth: 0.7))
    }
}

/// Intrinsic-width navigation: no enclosing segmented bezel or redundant label.
struct CharacterMemoryCollectionTabs: View {
    @Binding var selection: CharacterMemoryCollection

    var body: some View {
        HStack(spacing: 24) {
            ForEach(CharacterMemoryCollection.allCases, id: \.self) { item in
                Button { if selection != item { selection = item } } label: {
                    Label(item.rawValue, systemImage: item == .personal ? "brain.head.profile" : "books.vertical")
                        .font(.system(size: 12, weight: selection == item ? .semibold : .medium))
                        .foregroundStyle(selection == item ? Color.primary : Color.secondary)
                        .padding(.horizontal, 2)
                        .frame(height: 36)
                        .contentShape(Rectangle())
                        .overlay(alignment: .bottom) {
                            if selection == item {
                                Capsule().fill(Color.primary).frame(height: 2)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("memory-tab-\(item == .personal ? "personal" : "knowledge")")
                .accessibilityAddTraits(selection == item ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(CharacterUIStyle.border).frame(height: 0.5)
                .allowsHitTesting(false)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("资料类型")
    }
}

struct CharacterMemoryCategoryMenu: View {
    @Binding var selection: CharacterMemoryKind

    var body: some View {
        Menu {
            ForEach([CharacterMemoryKind.fact, .preference, .episode], id: \.self) { kind in
                Button { selection = kind } label: {
                    if selection == kind {
                        Label(kind.rawValue, systemImage: "checkmark")
                    } else {
                        Text(kind.rawValue)
                    }
                }
            }
        } label: {
            HStack(spacing: 12) {
                Text(selection.rawValue)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .frame(width: 64)
            .modifier(ManagementControlSurface())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("记忆类别")
        .accessibilityValue(selection.rawValue)
        .accessibilityIdentifier("memory-category")
    }
}
