import AppKit
import SwiftUI

/// Native undo/redo can update the text storage without publishing SwiftUI's
/// binding. Observe the unchanged native undo stack, never replace it or the
/// editor's delegate, and publish only text changed by this exact operation.
@MainActor
final class CharacterNativeUndoBinding {
    var text: Binding<String>
    private weak var editor: NSTextView?
    private var observations: [NSObjectProtocol] = []
    private var textBeforeUndoRedo: String?

    init(text: Binding<String>) { self.text = text }

    deinit { observations.forEach { NotificationCenter.default.removeObserver($0) } }

    func attach(to input: NSTextView?) {
        guard editor !== input else { return }
        detach()
        guard let input else { return }
        editor = input
        let names: [Notification.Name] = [
            .NSUndoManagerWillUndoChange, .NSUndoManagerWillRedoChange,
            .NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange,
        ]
        observations = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated { self?.handle(note) }
            }
        }
    }

    func detach() {
        observations.forEach { NotificationCenter.default.removeObserver($0) }
        observations.removeAll()
        textBeforeUndoRedo = nil
        editor = nil
    }

    private func handle(_ note: Notification) {
        guard let editor, let manager = note.object as? UndoManager,
              editor.undoManager === manager else { return }
        if note.name == .NSUndoManagerWillUndoChange || note.name == .NSUndoManagerWillRedoChange {
            textBeforeUndoRedo = editor.string
            return
        }
        defer { textBeforeUndoRedo = nil }
        // Several inputs share one window undo manager. Siblings may have model
        // changes not yet rendered by SwiftUI; do not overwrite those bindings.
        guard let previous = textBeforeUndoRedo, previous != editor.string,
              !editor.hasMarkedText(), text.wrappedValue != editor.string else { return }
        text.wrappedValue = editor.string
    }
}
