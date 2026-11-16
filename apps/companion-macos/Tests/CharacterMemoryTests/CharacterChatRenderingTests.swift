import AppKit
import CharacterCore
import CharacterMemory
import SwiftUI
import XCTest
import Vision
@testable import CharacterUI

private struct FocusableChatComposerPreview: View {
    @FocusState private var isFocused: Bool
    let model: CharacterWorkspaceModel
    let initiallyFocused: Bool

    var body: some View {
        CharacterChatComposer(model: model, isFocused: $isFocused)
            .onAppear { isFocused = initiallyFocused }
    }
}

@MainActor
final class CharacterChatRenderingTests: XCTestCase {
    private var lastBitmap: NSBitmapImageRep?
    private func render<V: View>(_ content: V, width: CGFloat, scheme: ColorScheme, name: String) throws -> NSSize {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: content
            .frame(width: width).fixedSize(horizontal: false, vertical: true)
            .padding(20).background(Color(nsColor: ManagementSurfacePalette.canvas))
            .environment(\.colorScheme, scheme))
        host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        host.frame.size = host.fittingSize
        // Native List rows need a hosting window and a layout turn. Keep it hidden.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.frame.size),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.04))
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(window.isVisible)
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        lastBitmap = bitmap
        XCTAssertGreaterThan(bitmap.pixelsWide, 0)
        XCTAssertGreaterThan(bitmap.pixelsHigh, 0)
        XCTAssertEqual(host.bounds.width, width + 40, accuracy: 1, "Content must not push beyond its allotted width")
        if let path = ProcessInfo.processInfo.environment["ADP_CHAT_SNAPSHOT_DIR"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: directory.appendingPathComponent("\(name)-\(scheme).png"))
        }
        return host.bounds.size
    }

    private func fixture() throws -> (URL, CharacterWorkspaceModel) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CharacterMemoryStore(stateDirectory: dir, petID: "synthetic-chat")
        let model = CharacterWorkspaceModel(store: store, defaultName: "龙妹", chat: { _, _, _ in "合成回复" },
            chatModels: { .init(serviceID: "synthetic", providerName: "离线合成服务（不连接网络）",
                                models: ["示例模型 A", "示例模型 B", String(repeating: "long-model-id-", count: 12)], defaultModel: "示例模型 A") })
        model.refreshChatModels()
        return (dir, model)
    }

    func testComposerRendersShortLongAndOversizedDraftsInBothThemesAndWidths() throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(400), 720] {
                model.chatDraft = "你好，龙妹"
                let short = try render(FocusableChatComposerPreview(model: model, initiallyFocused: false), width: width, scheme: scheme, name: "composer-\(Int(width))-short")
                model.chatDraft = (0..<9).map { "第\($0)行合成输入，检查多行编辑。" }.joined(separator: "\n")
                let long = try render(FocusableChatComposerPreview(model: model, initiallyFocused: false), width: width, scheme: scheme, name: "composer-\(Int(width))-long")
                XCTAssertGreaterThan(long.height, short.height)
                XCTAssertLessThan(long.height, 300)
                model.chatDraft = String(repeating: "字", count: 1_201)
                _ = try render(FocusableChatComposerPreview(model: model, initiallyFocused: false), width: width, scheme: scheme, name: "composer-\(Int(width))-limit")
                model.chatDraft = "聚焦状态预览"
                let focused = try render(FocusableChatComposerPreview(model: model, initiallyFocused: true), width: width,
                                         scheme: scheme, name: "composer-\(Int(width))-focused")
                XCTAssertEqual(focused.height, short.height, accuracy: 1)
            }
        }
    }

    func testModelListRendersConfiguredAndEmptyStatesInBothThemes() throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        let empty = CharacterWorkspaceModel(store: try CharacterMemoryStore(stateDirectory: dir, petID: "empty"), defaultName: "龙妹")
        for scheme in [ColorScheme.light, .dark] {
            _ = try render(CharacterChatModelList(model: model, dismiss: {}), width: 332, scheme: scheme, name: "model-list")
            let bitmap = try XCTUnwrap(lastBitmap)
            var rowInkPixels = 0
            for y in 100..<200 {
                for x in 50..<300 {
                    if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
                        if scheme == .light ? color.redComponent < 0.6 : color.redComponent > 0.5 { rowInkPixels += 1 }
                    }
                }
            }
            XCTAssertGreaterThan(rowInkPixels, 50, "The native list rows must actually render, not just its header")
            _ = try render(CharacterChatModelList(model: empty, dismiss: {}), width: 332, scheme: scheme, name: "model-list-empty")
        }
    }

    func testMemoryAutomaticReviewDisclosureRendersOnlyWithOnlineProvider() async throws {
        let (dir, _) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        let onlineStore = try CharacterMemoryStore(stateDirectory: dir, petID: "review-online")
        let offlineStore = try CharacterMemoryStore(stateDirectory: dir, petID: "review-offline")
        let online = CharacterWorkspaceModel(store: onlineStore, defaultName: "合成角色",
            reviewMemories: { _, _ in [] })
        let offline = CharacterWorkspaceModel(store: offlineStore, defaultName: "合成角色")

        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(400), 760] {
                _ = try render(CharacterMemoryView(model: online).frame(height: 860), width: width,
                               scheme: scheme, name: "memory-review-online-\(Int(width))")
                let onlineText = try renderedText()
                XCTAssertTrue(onlineText.contains("自动审核普通记忆"), "Missing opt-in toggle: \(onlineText)")
                XCTAssertTrue(onlineText.contains("可能产生额外费用"), "Missing cost disclosure: \(onlineText)")
                XCTAssertTrue(onlineText.contains("每累计3条用户发言"), "Missing review threshold: \(onlineText)")

                _ = try render(CharacterMemoryView(model: offline).frame(height: 860), width: width,
                               scheme: scheme, name: "memory-review-offline-\(Int(width))")
                XCTAssertFalse(try renderedText().contains("自动审核普通记忆"),
                               "Offline preview must not expose the online review toggle")
            }
        }
    }

    private func renderedText() throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.recognitionLevel = .accurate
        let image = try XCTUnwrap(lastBitmap?.cgImage)
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined().filter { !$0.isWhitespace }
    }

    func testIdentityRendersFourSingleColumnEditorsWithoutExposingFoundationInBothThemes() async throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 10_000_000) }
        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(400), 760] {
                _ = try render(CharacterIdentityView(model: model).frame(height: 760), width: width, scheme: scheme,
                               name: "identity-single-\(Int(width))")
                let text = try renderedText()
                for label in ["名称", "性格", "表达方式", "与你的关系", "基础设定", "保存身份"] {
                    // Vision sometimes omits the light strokes in “的”; geometry still
                    // requires all four distinct, correctly ordered label observations.
                    XCTAssertTrue(text.replacingOccurrences(of: "的", with: "").contains(label.replacingOccurrences(of: "的", with: "")), "Missing \(label): \(text)")
                }
                for hidden in ["知识范围", "核心价值", "行为边界", "身份定位"] {
                    XCTAssertFalse(text.contains(hidden), "Collapsed foundation leaked: \(text)")
                }
                let request = VNRecognizeTextRequest()
                request.recognitionLanguages = ["zh-Hans"]
                request.recognitionLevel = .accurate
                try VNImageRequestHandler(cgImage: XCTUnwrap(lastBitmap?.cgImage)).perform([request])
                let labels = ["名称", "性格", "表达方式", "与你的关系"]
                let bounds = labels.compactMap { label in
                    (request.results ?? []).first { $0.topCandidates(1).first?.string.replacingOccurrences(of: "的", with: "") == label.replacingOccurrences(of: "的", with: "") }?.boundingBox
                }
                XCTAssertEqual(bounds.count, 4)
                for pair in zip(bounds, bounds.dropFirst()) {
                    XCTAssertGreaterThan(pair.0.minY, pair.1.maxY, "Fields must be on separate rows")
                    XCTAssertEqual(pair.0.minX, pair.1.minX, accuracy: 0.025)
                }
            }
        }
    }

    func testSharedInputSurfaceFocusHasBrandColorsWithoutChangingGeometry() throws {
        for scheme in [ColorScheme.light, .dark] {
            for focused in [false, true] {
                _ = try render(Color.clear.frame(height: 92)
                    .modifier(CharacterInputSurface(isFocused: focused)), width: 400, scheme: scheme,
                    name: "identity-input-focus-\(focused)")
                let bitmap = try XCTUnwrap(lastBitmap)
                var brandPixels = 0
                for y in 0..<bitmap.pixelsHigh {
                    for x in 0..<bitmap.pixelsWide {
                        guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                        if color.blueComponent - color.redComponent > 0.15 { brandPixels += 1 }
                    }
                }
                if focused { XCTAssertGreaterThan(brandPixels, 100) }
                else { XCTAssertLessThan(brandPixels, 10) }
            }
        }
    }

    func testWelcomeFollowsEditedNameAndLoadedNameAfterRestart() async throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        for _ in 0..<100 where !model.canSaveIdentity { try await Task.sleep(nanoseconds: 10_000_000) }
        for name in ["小桃", "小雪"] {
            model.identity.name = name
            _ = try render(CharacterChatView(model: model).frame(height: 480), width: 760, scheme: .light, name: "renamed-welcome")
            let text = try renderedText()
            XCTAssertTrue(text.contains("今天想和\(name)聊点什么"), text)
            XCTAssertFalse(text.contains("龙妹"), text)
        }
        model.saveIdentity()
        for _ in 0..<100 where model.status != "身份资料已保存。" { try await Task.sleep(nanoseconds: 10_000_000) }
        let reloaded = CharacterWorkspaceModel(store: try CharacterMemoryStore(stateDirectory: dir, petID: "synthetic-chat"),
                                               defaultName: "龙妹", chat: { _, _, _ in "合成回复" })
        for _ in 0..<100 where !reloaded.canSaveIdentity { try await Task.sleep(nanoseconds: 10_000_000) }
        _ = try render(CharacterChatView(model: reloaded).frame(height: 480), width: 760, scheme: .dark, name: "renamed-welcome-reloaded")
        XCTAssertTrue(try renderedText().contains("今天想和小雪聊点什么"))
    }

    func testEmptyChatShowsWelcomeInsteadOfMemoryInstructionsAndHidesItAfterReply() async throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(300), 400, 760] {
                _ = try render(CharacterChatView(model: model).frame(height: 480), width: width, scheme: scheme, name: "chat-welcome-\(Int(width))")
                let text = try renderedText()
                XCTAssertTrue(text.contains("今天想和龙妹聊点什么"), "Missing visible welcome title: \(text)")
                XCTAssertFalse(text.contains("临时聊天"), "Old welcome/footer instructions must not remain")
                XCTAssertFalse(text.contains("长期记忆"))
                XCTAssertFalse(text.contains("自动存入"))
                XCTAssertTrue(text.contains("示例模型A"), "Removing the footer must preserve model selection")
            }
        }
        model.sendChat("你好")
        for _ in 0..<100 where model.isChatSending { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertFalse(model.isChatSending)
        _ = try render(CharacterChatView(model: model).frame(height: 480), width: 760, scheme: .light, name: "chat-welcome-dismissed")
        let conversation = try renderedText()
        XCTAssertFalse(conversation.contains("今天想和龙妹聊点什么"))
        XCTAssertTrue(conversation.contains("合成回复"))
        model.clearChat()
        _ = try render(CharacterChatView(model: model).frame(height: 480), width: 760, scheme: .light, name: "chat-welcome-restored")
        XCTAssertTrue(try renderedText().contains("今天想和龙妹聊点什么"))
    }

    // A missing/unrenderable bundled SVG leaves this region blank. OCR locates
    // the real title rather than relying on fixed window coordinates.
    func testWelcomeHasVisibleMarkToTheLeftOfTitleInBothThemesAndWidths() throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        for scheme in [ColorScheme.light, .dark] {
            for width in [CGFloat(300), 400, 760] {
                _ = try render(CharacterChatView(model: model).frame(height: 480), width: width,
                               scheme: scheme, name: "chat-mark-\(Int(width))")
                let bitmap = try XCTUnwrap(lastBitmap)
                let request = VNRecognizeTextRequest()
                request.recognitionLanguages = ["zh-Hans", "en-US"]
                request.recognitionLevel = .accurate
                try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage)).perform([request])
                // Vision can include the decorative mark. Measure just the
                // heading's substring, not the observation containing both logo and text.
                let titleRects = try (request.results ?? []).compactMap { observation -> CGRect? in
                    guard let candidate = observation.topCandidates(1).first,
                          let start = candidate.string.range(of: "今天")
                            ?? candidate.string.range(of: "聊点什么") else { return nil }
                    return try candidate.boundingBox(for: start.lowerBound..<candidate.string.endIndex)?.boundingBox
                }
                XCTAssertFalse(titleRects.isEmpty, "Welcome text must remain readable")
                let bounds = try XCTUnwrap(titleRects.reduce(nil as CGRect?) { result, rect in
                    result.map { $0.union(rect) } ?? rect
                })
                let scale = CGFloat(bitmap.pixelsWide) / (width + 40)
                let left = bounds.minX * CGFloat(bitmap.pixelsWide)
                let centerY = (1 - bounds.midY) * CGFloat(bitmap.pixelsHigh)
                let minX = max(0, Int(left - 62 * scale))
                let maxX = max(minX, Int(left - 8 * scale))
                let minY = max(0, Int(centerY - 24 * scale))
                let maxY = min(bitmap.pixelsHigh, Int(centerY + 24 * scale))
                var markInk = 0
                for y in minY..<maxY {
                    for x in minX..<maxX {
                        if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                           scheme == .light ? color.redComponent < 0.35 : color.redComponent > 0.7 {
                            markInk += 1
                        }
                    }
                }
                XCTAssertGreaterThan(markInk, 100, "Expected a visible template logo to the left of the title (\(scheme), \(width)pt)")
            }
        }
    }

    func testOnlyAssistantMessageAddsASecondLineForItsFixedTimestamp() throws {
        let date = Date(timeIntervalSinceReferenceDate: 3_723)
        for scheme in [ColorScheme.light, .dark] {
            let assistant = CharacterChatTurn(role: .assistant, text: "合成回复", createdAt: date)
            let user = CharacterChatTurn(role: .user, text: "合成回复", createdAt: date)
            let legacy = CharacterChatTurn(role: .assistant, text: "合成回复", createdAt: nil)
            let withTime = try render(CharacterChatMessageView(turn: assistant), width: 400, scheme: scheme, name: "assistant-time")
            let userSize = try render(CharacterChatMessageView(turn: user), width: 400, scheme: scheme, name: "user-no-time")
            let legacySize = try render(CharacterChatMessageView(turn: legacy), width: 400, scheme: scheme, name: "legacy-no-time")
            XCTAssertGreaterThan(withTime.height, userSize.height + 8)
            XCTAssertEqual(legacySize.height, userSize.height, accuracy: 1)
        }
    }

    func testFullChatRendersWithoutShowingAWindow() async throws {
        let (dir, model) = try fixture()
        defer { try? FileManager.default.removeItem(at: dir) }
        model.sendChat("你好，介绍一下你自己")
        for _ in 0..<100 where model.isChatSending { try await Task.sleep(nanoseconds: 10_000_000) }
        model.chatDraft = "今天我们聊点什么？"
        for scheme in [ColorScheme.light, .dark] {
            _ = try render(CharacterChatView(model: model).frame(height: 480), width: 760, scheme: scheme, name: "chat-page")
        }
    }
}
