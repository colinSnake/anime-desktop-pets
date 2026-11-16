import Foundation
import XCTest
@testable import PetCompanion

private final class TrickleModelProtocol: URLProtocol {
    private var work: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            for _ in 0..<30 {
                guard self.work?.isCancelled == false else { return }
                self.client?.urlProtocol(self, didLoad: Data(" ".utf8))
                Thread.sleep(forTimeInterval: 0.02)
            }
            guard self.work?.isCancelled == false else { return }
            self.client?.urlProtocol(self, didLoad: Data(#"{"choices":[{"message":{"content":"陪你坐一会儿。"}}]}"#.utf8))
            self.client?.urlProtocolDidFinishLoading(self)
        }
        work = item
        DispatchQueue.global().async(execute: item)
    }
    override func stopLoading() { work?.cancel() }
}

final class ModelSingleRequestDeadlineTests: XCTestCase {
    func testTrickledBytesCannotExtendTotalDeadline() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TrickleModelProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let started = Date()
        var timedOut = false
        do {
            _ = try await ModelProviderClient(session: session).singleReply(settings: ModelProviderSettings(), apiKey: "synthetic",
                system: "合成气泡", user: "idle", timeout: 0.08)
        } catch { timedOut = (error as? URLError)?.code == .timedOut }
        XCTAssertTrue(timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.4)
    }
}
