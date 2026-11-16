import AppKit
import SwiftUI

/// SwiftUI ends field editing before onSubmit, so Shift+Return must be handled
/// before native dispatch. This in-process monitor handles only the owned field;
/// it does not observe system-wide input or replace SwiftUI's editing delegate.
struct CharacterChatReturnKeyPolicy: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> Probe { Probe(text: $text) }
    func updateNSView(_ view: Probe, context: Context) {
        view.undoBinding.text = $text
        view.scheduleUpdate()
    }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.detachInput() }

    final class Probe: CharacterNativeInputProbe {
        let undoBinding: CharacterNativeUndoBinding
        private weak var field: NSTextField?
        private var monitor: Any?
        private var editingObservations: [NSObjectProtocol] = []

        init(text: Binding<String>) {
            undoBinding = CharacterNativeUndoBinding(text: text)
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func refreshInput() {
            guard let input = ownedInput(NSTextField.self, matching: { $0.isEditable }) else {
                detachInput()
                return
            }
            if field !== input || monitor == nil {
                detachInput()
                field = input
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                    guard let self else { return event }
                    return self.handle(event)
                }
                editingObservations = [NSControl.textDidBeginEditingNotification, NSControl.textDidEndEditingNotification].map { name in
                    NotificationCenter.default.addObserver(forName: name, object: input, queue: .main) { [weak self] _ in
                        MainActor.assumeIsolated { self?.updateEditor() }
                    }
                }
            }
            updateEditor()
        }

        private func updateEditor() {
            undoBinding.attach(to: field?.currentEditor() as? NSTextView)
        }

        override func detachInput() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            editingObservations.forEach { NotificationCenter.default.removeObserver($0) }
            editingObservations.removeAll()
            undoBinding.detach()
            field = nil
        }

        private func handle(_ event: NSEvent) -> NSEvent? {
            let modifiers = event.modifierFlags.intersection([.shift, .control, .option, .command])
            guard modifiers == .shift, event.keyCode == 36 || event.keyCode == 76,
                  let field, event.window === field.window,
                  let editor = field.currentEditor() as? NSTextView,
                  field.window?.firstResponder === editor, !editor.hasMarkedText() else { return event }
            // A normal newline, native selection replacement and the native undo stack.
            editor.insertNewlineIgnoringFieldEditor(nil)
            return nil
        }
    }
}
