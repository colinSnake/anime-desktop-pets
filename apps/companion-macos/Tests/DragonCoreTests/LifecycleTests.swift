import XCTest
@testable import DragonCore

final class LifecycleTests: XCTestCase {
    func testNewProcessPlaysOnce() {
        var s = LaunchSession(); XCTAssertTrue(s.begin(pid: 123)); XCTAssertEqual(s.phase, .waitingWindow)
        XCTAssertFalse(s.begin(pid: 123)); s.startAnimation(pid: 123); XCTAssertEqual(s.phase, .playing)
        XCTAssertTrue(s.finishAnimation(pid: 123)); XCTAssertEqual(s.phase, .accompanying)
        XCTAssertFalse(s.begin(pid: 123))
    }
    func testAlreadyRunningDoesNotReplay() {
        var s = LaunchSession(); s.begin(pid: 123, alreadyRunning: true); XCTAssertEqual(s.phase, .accompanying)
    }
    func testHideDuringAnimationSurvivesFinish() {
        var s = LaunchSession(); s.begin(pid: 1); s.startAnimation(pid: 1); s.hidePet()
        XCTAssertEqual(s.phase, .playing); XCTAssertFalse(s.finishAnimation(pid: 1)); XCTAssertEqual(s.phase, .petHidden)
    }
    func testDismissDuringAnimationSuppressesPet() {
        var s = LaunchSession(); s.begin(pid: 1); s.startAnimation(pid: 1); s.dismissPet()
        XCTAssertEqual(s.phase, .playing); XCTAssertFalse(s.finishAnimation(pid: 1)); XCTAssertEqual(s.phase, .petDismissed)
    }
    func testShowDuringAnimationDoesNotEscapeOverlay() {
        var s = LaunchSession(); s.begin(pid: 1); s.startAnimation(pid: 1); s.dismissPet(); s.showPet()
        XCTAssertEqual(s.phase, .playing); XCTAssertTrue(s.finishAnimation(pid: 1))
    }
    func testDismissDuringWindowWaitDoesNotBreakMovieState() {
        var s = LaunchSession(); s.begin(pid: 1); s.dismissPet(); s.startAnimation(pid: 1)
        XCTAssertEqual(s.phase, .playing); XCTAssertFalse(s.finishAnimation(pid: 1))
    }
    func testSameProcessDoesNotUndoUserDismissal() {
        var s = LaunchSession(); s.begin(pid: 1, alreadyRunning: true); s.dismissPet()
        XCTAssertFalse(s.begin(pid: 1)); XCTAssertTrue(s.dismissed)
    }
    func testNextProcessResetsDismissal() {
        var s = LaunchSession(); s.begin(pid: 1); s.dismissPet(); s.terminate(pid: 1)
        XCTAssertTrue(s.begin(pid: 2)); XCTAssertFalse(s.dismissed); XCTAssertTrue(s.finishAnimation(pid: 2))
    }
    func testStaleFinishCannotMutateNewSession() {
        var s = LaunchSession(); s.begin(pid: 1); s.begin(pid: 2)
        XCTAssertFalse(s.finishAnimation(pid: 1)); XCTAssertEqual(s.pid, 2); XCTAssertEqual(s.phase, .waitingWindow)
    }
    func testStaleTerminationIgnored() {
        var s = LaunchSession(); s.begin(pid: 2); XCTAssertFalse(s.terminate(pid: 1)); XCTAssertEqual(s.pid, 2)
    }
    func testTerminationResetsAllFlags() {
        var s = LaunchSession(); s.begin(pid: 1); s.hidePet(); s.dismissPet(); XCTAssertTrue(s.terminate(pid: 1))
        XCTAssertNil(s.pid); XCTAssertEqual(s.phase, .idle); XCTAssertFalse(s.hidden); XCTAssertFalse(s.dismissed)
    }
    func testExplicitShowRestoresDismissedPet() {
        var s = LaunchSession(); s.begin(pid: 1, alreadyRunning: true); s.dismissPet(); s.showPet()
        XCTAssertFalse(s.hidden); XCTAssertFalse(s.dismissed); XCTAssertEqual(s.phase, .accompanying)
    }
}

final class PlaybackWatchdogTests: XCTestCase {
    func testStallBounded() {
        var w = PlaybackWatchdog(timeout: 5)
        XCTAssertFalse(w.stalled(position: 1, now: 0, intentionallyPaused: false))
        XCTAssertFalse(w.stalled(position: 1, now: 4, intentionallyPaused: false))
        XCTAssertTrue(w.stalled(position: 1, now: 5, intentionallyPaused: false))
    }
    func testProgressResetsTimer() {
        var w = PlaybackWatchdog(timeout: 5)
        _ = w.stalled(position: 1, now: 0, intentionallyPaused: false)
        XCTAssertFalse(w.stalled(position: 2, now: 5, intentionallyPaused: false))
        XCTAssertFalse(w.stalled(position: 2, now: 9, intentionallyPaused: false))
    }
    func testIntentionalWaitNotAStall() {
        var w = PlaybackWatchdog(timeout: 5)
        _ = w.stalled(position: 11.3, now: 0, intentionallyPaused: false)
        XCTAssertFalse(w.stalled(position: 11.3, now: 60, intentionallyPaused: true))
        XCTAssertFalse(w.stalled(position: 11.3, now: 61, intentionallyPaused: false))
        XCTAssertTrue(w.stalled(position: 11.3, now: 66, intentionallyPaused: false))
    }
    func testNonFiniteClockIgnored() {
        var w = PlaybackWatchdog(); XCTAssertFalse(w.stalled(position: .nan, now: .nan, intentionallyPaused: false))
    }
}

final class ControlMessageTests: XCTestCase {
    func testCommandRoundTrip() throws {
        for c in ControlCommand.allCases {
            let encoded = try JSONEncoder().encode(ControlRequest(c))
            XCTAssertEqual(try JSONDecoder().decode(ControlRequest.self, from: encoded).command, c)
        }
    }
    func testUnknownCommandRejected() {
        XCTAssertThrowsError(try JSONDecoder().decode(ControlRequest.self, from: Data("{\"command\":\"run-shell\"}".utf8)))
    }
}
