import CharacterCore
import XCTest

final class CharacterCoreTests: XCTestCase {
    func testLocalOnlyAndPendingMemoriesNeverEnterOnlineContext() {
        let memories = [
            CharacterMemory(kind: .fact, text: "local secret", source: "test", status: .confirmed),
            CharacterMemory(kind: .fact, text: "pending", source: "test", status: .candidate, shareWithOnlineModel: true),
            CharacterMemory(kind: .preference, text: "brief replies", source: "test", status: .confirmed,
                            shareWithOnlineModel: true),
        ]

        let context = CharacterContextBuilder.make(identity: nil, memories: memories, query: "brief replies")

        XCTAssertTrue(context?.contains("brief replies") == true)
        XCTAssertFalse(context?.contains("local secret") == true)
        XCTAssertFalse(context?.contains("pending") == true)
    }

    func testIdentityIsLocalUntilExplicitlyShared() {
        let identity = CharacterIdentity(name: "龙妹", background: "来自东方", shareWithOnlineModel: false)
        XCTAssertNil(CharacterContextBuilder.make(identity: identity, memories: [], query: "随便聊聊"))

        var sharedIdentity = identity
        sharedIdentity.shareWithOnlineModel = true
        XCTAssertTrue(CharacterContextBuilder.make(identity: sharedIdentity, memories: [], query: "随便聊聊")?.contains("来自东方") == true)
    }

    func testOnlyRelevantConfirmedAndAuthorizedMemoriesEnterContext() {
        let memories = [
            CharacterMemory(kind: .preference, text: "我喜欢安静的咖啡馆", source: "test", status: .confirmed,
                            shareWithOnlineModel: true),
            CharacterMemory(kind: .fact, text: "我的狗叫雪球", source: "test", status: .confirmed,
                            shareWithOnlineModel: true),
            CharacterMemory(kind: .fact, text: "我喜欢热闹的酒吧", source: "test", status: .candidate,
                            shareWithOnlineModel: true),
            CharacterMemory(kind: .fact, text: "我偏好安静", source: "test", status: .confirmed,
                            shareWithOnlineModel: false),
        ]

        let context = CharacterContextBuilder.make(identity: nil, memories: memories, query: "推荐安静的地方")

        XCTAssertTrue(context?.contains("安静的咖啡馆") == true)
        XCTAssertFalse(context?.contains("雪球") == true)
        XCTAssertFalse(context?.contains("热闹的酒吧") == true)
        XCTAssertFalse(context?.contains("我偏好安静") == true)
    }

    func testUnrelatedQueryDoesNotAttachAnyMemory() {
        let memory = CharacterMemory(kind: .preference, text: "我喜欢安静的咖啡馆", source: "test",
                                     status: .confirmed, shareWithOnlineModel: true)

        let context = CharacterContextBuilder.make(identity: nil, memories: [memory], query: "火星探测器怎么工作")

        XCTAssertNil(context)
    }

    func testRememberCommandRequiresExplicitPrefixAndEnforcesLength() {
        XCTAssertEqual(CharacterCommand.rememberText(in: "请记住：我喜欢安静"), "我喜欢安静")
        XCTAssertEqual(CharacterCommand.rememberText(in: "记住我喜欢安静"), "我喜欢安静")
        XCTAssertNil(CharacterCommand.rememberText(in: "我喜欢安静"))
        XCTAssertNil(CharacterCommand.rememberText(in: "记住了吗？"))
        XCTAssertNil(CharacterCommand.rememberText(in: "记住：" + String(repeating: "a", count: 1_001)))
    }

    func testIdentityAndCapabilityQuestionsCanBeAnsweredLocally() {
        let identity = CharacterIdentity(name: "龙妹", background: "我是桌边小崽的龙妹")
        let capabilities = [CharacterCapability(id: "asr", name: "本机语音识别", status: .enabled, detail: ""),
                            CharacterCapability(id: "live", name: "B 站直播接入", status: .planned, detail: "")]
        XCTAssertTrue(CharacterLocalAnswer.answer(for: "你是谁？", identity: identity, memories: [], capabilities: capabilities)?.contains("龙妹") == true)
        XCTAssertTrue(CharacterLocalAnswer.answer(for: "你会什么？", identity: identity, memories: [], capabilities: capabilities)?.contains("本机语音识别") == true)
        XCTAssertNil(CharacterLocalAnswer.answer(for: "讲个故事", identity: identity, memories: [], capabilities: capabilities))
    }
}
