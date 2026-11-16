import AppKit
import SwiftUI

/// Preserve SwiftUI's native editor, focus, selection, undo stack and IME.
struct CharacterTextEditor: View {
    @Binding var text: String

    var body: some View {
        TextEditor(text: $text)
            .scrollIndicators(.hidden)
            .background(TextEditorNativePolicy(text: $text))
    }
}

/// SwiftUI may re-enable native scrollers after layout or a binding update.
/// Each probe owns one editor's policy and releases it on unmount.
private struct TextEditorNativePolicy: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> Probe { Probe(text: $text) }
    func updateNSView(_ view: Probe, context: Context) {
        view.undoBinding.text = $text
        view.scheduleUpdate()
    }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.detachInput() }

    final class Probe: CharacterNativeInputProbe {
        let undoBinding: CharacterNativeUndoBinding
        private weak var scroll: NSScrollView?
        private var observations: [NSKeyValueObservation] = []

        init(text: Binding<String>) {
            undoBinding = CharacterNativeUndoBinding(text: text)
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func refreshInput() {
            guard let input = ownedInput(NSScrollView.self, matching: {
                ($0.documentView as? NSTextView)?.isFieldEditor == false
            }), let editor = input.documentView as? NSTextView else {
                detachInput()
                return
            }
            if scroll !== input {
                detachInput()
                scroll = input
                observations = [
                    input.observe(\.hasVerticalScroller, options: [.new]) { [weak input] _, change in
                        guard change.newValue == true else { return }
                        MainActor.assumeIsolated { input?.hasVerticalScroller = false }
                    },
                    input.observe(\.hasHorizontalScroller, options: [.new]) { [weak input] _, change in
                        guard change.newValue == true else { return }
                        MainActor.assumeIsolated { input?.hasHorizontalScroller = false }
                    },
                ]
            }
            undoBinding.attach(to: editor)
            input.hasVerticalScroller = false
            input.hasHorizontalScroller = false
            input.autohidesScrollers = true
        }

        override func detachInput() {
            observations.removeAll()
            undoBinding.detach()
            scroll = nil
        }
    }
}
