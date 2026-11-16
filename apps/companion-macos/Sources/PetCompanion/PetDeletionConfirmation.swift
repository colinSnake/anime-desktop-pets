import AppKit
import SwiftUI

/// Native sheet ownership only; instance eligibility and deletion stay in Coordinator/runtime.
@MainActor
final class PetDeletionConfirmation {
    private(set) var alert: NSAlert?

    static func makeAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = ""
        let header = NSHostingView(rootView: PetDeletionConfirmationHeader(
            icon: NSApp.applicationIconImage.copy() as? NSImage
        ))
        header.frame = NSRect(x: 0, y: 0, width: 220, height: 44)
        alert.accessoryView = header
        alert.informativeText = ""
        alert.addButton(withTitle: "确认")
        alert.addButton(withTitle: "取消")
        alert.window.hidesOnDeactivate = false
        return alert
    }

    func present(in parent: NSWindow, confirmed: @escaping () -> Void) {
        guard alert == nil, parent.attachedSheet == nil else { return }
        let alert = Self.makeAlert()
        alert.window.appearance = parent.appearance
        self.alert = alert
        alert.beginSheetModal(for: parent) { [weak self, weak alert] response in
            guard let self, let alert, self.alert === alert else { return }
            self.alert = nil
            if response == .alertFirstButtonReturn { confirmed() }
        }
    }

    func dismiss() {
        guard let alert else { return }
        self.alert = nil
        if let parent = alert.window.sheetParent {
            parent.endSheet(alert.window, returnCode: .cancel)
        }
        alert.window.orderOut(nil)
    }
}

private struct PetDeletionConfirmationHeader: View {
    let icon: NSImage?

    var body: some View {
        HStack(spacing: 10) {
            if let icon {
                Image(nsImage: icon)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 32, height: 32)
                    .accessibilityHidden(true)
            }
            Text("删除这个桌宠实例？")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .frame(width: 220, height: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
