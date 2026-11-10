import XCTest
@testable import DragonCompanion

@MainActor
final class VoiceInputRecorderLifecycleTests: XCTestCase {
    func testCancelWhilePermissionPendingPreventsLateGrantFromOpeningMicrophone() async throws {
        var answer: ((Bool) -> Void)?
        let recorder = VoiceInputRecorder(requestAccess: { answer = $0 })
        var results = 0
        recorder.start(deviceUID: nil) { result in
            results += 1
            if case .failure(let error) = result { XCTAssertTrue(error.localizedDescription.contains("取消")) }
            else { XCTFail("Cancelled capture must not start") }
        }
        recorder.cancel()
        XCTAssertEqual(results, 1)
        try XCTUnwrap(answer)(true)
        await Task.yield()
        XCTAssertFalse(recorder.isRecording)
        XCTAssertEqual(results, 1)
    }

    func testDuplicateStartIsRejectedAndDeniedPermissionCanRetryWithoutDevices() async throws {
        var answers: [(Bool) -> Void] = []
        let recorder = VoiceInputRecorder(requestAccess: { answers.append($0) })
        var failures = 0
        let completion: (Result<Void, Error>) -> Void = { result in
            if case .failure = result { failures += 1 }
            else { XCTFail("Synthetic denial cannot start capture") }
        }
        recorder.start(deviceUID: nil, completion: completion)
        recorder.start(deviceUID: nil, completion: completion)
        XCTAssertEqual(answers.count, 1)
        XCTAssertEqual(failures, 1)
        answers[0](false)
        for _ in 0..<20 where failures < 2 { await Task.yield() }
        XCTAssertEqual(failures, 2)
        recorder.start(deviceUID: nil, completion: completion)
        XCTAssertEqual(answers.count, 2)
        answers[1](false)
        for _ in 0..<20 where failures < 3 { await Task.yield() }
        XCTAssertEqual(failures, 3)
        XCTAssertFalse(recorder.isRecording)
    }
}
