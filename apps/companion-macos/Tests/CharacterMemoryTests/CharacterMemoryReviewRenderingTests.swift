import AppKit
import CharacterCore
import CharacterMemory
import SwiftUI
import Vision
import XCTest
@testable import CharacterUI

@MainActor
final class CharacterMemoryReviewRenderingTests: XCTestCase {
    private func renderedText(_ host: NSView) throws -> String {
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let request = VNRecognizeTextRequest()
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.recognitionLevel = .accurate
        try VNImageRequestHandler(cgImage: try XCTUnwrap(bitmap.cgImage)).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined().filter { !$0.isWhitespace }
    }

    func testConfirmedMemoryLeavesPendingSectionWithoutNavigatingAway() async throws {
        _ = NSApplication.shared
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "render-confirmation")
        let memory = CharacterMemory(kind: .preference, text: "合成偏好：喜欢安静的书房", source: "合成资料")
        try await store.saveMemory(memory)
        let model = CharacterWorkspaceModel(store: store, defaultName: "合成角色")
        for _ in 0..<200 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 1_000_000) }
        let host = NSHostingView(rootView: CharacterMemoryView(model: model).frame(width: 800, height: 1000))
        host.frame.size = NSSize(width: 800, height: 1000)
        let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(try renderedText(host).contains("确认此条"))
        model.confirm(memory)
        for _ in 0..<200 where model.memories.first?.status != .confirmed { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertEqual(model.memories.first?.status, .confirmed)
        try await Task.sleep(nanoseconds: 100_000_000)
        let after = try renderedText(host)
        XCTAssertTrue(after.contains("已确认"), after)
        XCTAssertFalse(after.contains("待确认1"), after)
        XCTAssertFalse(after.contains("确认此条"), "保存成功后原位置不得残留待确认操作：\(after)")
    }
}
