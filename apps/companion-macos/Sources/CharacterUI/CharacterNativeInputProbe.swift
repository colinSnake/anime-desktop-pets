import AppKit

/// SwiftUI can flatten native controls from several sibling views into one parent.
/// Resolve a background probe's own input by its layout bounds, never by taking
/// every text view under the first shared ancestor.
class CharacterNativeInputProbe: NSView {
    private var updateScheduled = false

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        scheduleUpdate()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { detachInput() } else { scheduleUpdate() }
    }

    override func layout() {
        super.layout()
        refreshInput()
        scheduleUpdate()
    }

    func scheduleUpdate() {
        guard !updateScheduled else { return }
        updateScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateScheduled = false
            self.refreshInput()
        }
    }

    func refreshInput() {}
    func detachInput() {}

    func ownedInput<T: NSView>(_ type: T.Type, matching: (T) -> Bool) -> T? {
        guard window != nil, !bounds.isEmpty else { return nil }
        func candidates(in view: NSView) -> [T] {
            if let input = view as? T, matching(input) {
                guard let parent = input.superview else { return [] }
                let rect = convert(input.alignmentRect(forFrame: input.frame), from: parent)
                // Allow pixel rounding, but not adjacent or partially-overlapping fields.
                if abs(rect.minX - bounds.minX) <= 1, abs(rect.minY - bounds.minY) <= 1,
                   abs(rect.width - bounds.width) <= 2, abs(rect.height - bounds.height) <= 2 {
                    return [input]
                }
            }
            return view.subviews.flatMap { candidates(in: $0) }
        }
        var ancestor = superview
        while let container = ancestor {
            let inputs = candidates(in: container)
            if inputs.count == 1 { return inputs.first }
            if inputs.count > 1 { return nil }
            ancestor = container.superview
        }
        return nil
    }
}
