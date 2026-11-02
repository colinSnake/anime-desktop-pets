import Foundation

public enum SessionPhase: String, Codable, Sendable {
    case idle, waitingWindow, playing, accompanying, petHidden, petDismissed
}

/// Pure lifecycle state. PID checks reject callbacks left over from a previous launch.
public struct LaunchSession {
    public private(set) var pid: Int32?
    public private(set) var phase: SessionPhase = .idle
    public private(set) var hidden = false
    public private(set) var dismissed = false
    public init() {}

    @discardableResult
    public mutating func begin(pid newPID: Int32, alreadyRunning: Bool = false) -> Bool {
        guard pid != newPID else { return false }
        pid = newPID
        hidden = false
        dismissed = false
        phase = alreadyRunning ? .accompanying : .waitingWindow
        return true
    }
    public mutating func startAnimation(pid expected: Int32) {
        guard pid == expected else { return }
        phase = .playing
    }
    @discardableResult
    public mutating func finishAnimation(pid expected: Int32) -> Bool {
        guard pid == expected else { return false }
        phase = dismissed ? .petDismissed : hidden ? .petHidden : .accompanying
        return !dismissed && !hidden
    }
    public mutating func hidePet() {
        hidden = true
        if phase != .playing && phase != .waitingWindow && !dismissed { phase = .petHidden }
    }
    public mutating func dismissPet() {
        dismissed = true
        if phase != .playing && phase != .waitingWindow { phase = .petDismissed }
    }
    public mutating func showPet() {
        hidden = false
        dismissed = false
        if pid != nil && phase != .playing && phase != .waitingWindow { phase = .accompanying }
    }
    @discardableResult
    public mutating func terminate(pid expected: Int32) -> Bool {
        guard pid == expected else { return false }
        self = LaunchSession()
        return true
    }
}

public struct PlaybackWatchdog {
    public let timeout: Double
    private var lastPosition: Double?
    private var lastProgress: Double?
    public init(timeout: Double = 12) { self.timeout = timeout }
    public mutating func stalled(position: Double, now: Double, intentionallyPaused: Bool) -> Bool {
        guard now.isFinite else { return false }
        if intentionallyPaused || lastProgress == nil || (position.isFinite && (lastPosition == nil || abs(position - lastPosition!) > 0.01)) {
            lastProgress = now
            lastPosition = position.isFinite ? position : nil
            return false
        }
        return now - lastProgress! >= timeout
    }
}
