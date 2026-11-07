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
        let identity = CharacterIdentity(name: "龙妹", background: "来自东方", values: "诚实",
                                         shareWithOnlineModel: false)
        XCTAssertNil(CharacterContextBuilder.make(identity: identity, memories: [], query: "随便聊聊"))

        var sharedIdentity = identity
        sharedIdentity.shareWithOnlineModel = true
        let context = CharacterContextBuilder.make(identity: sharedIdentity, memories: [], query: "随便聊聊")
        XCTAssertTrue(context?.contains("来自东方") == true)
        XCTAssertTrue(context?.contains("核心价值观：诚实") == true)
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

    func testCredentialLikeMemoryNeverEntersOnlineContextEvenWhenMarkedShareable() {
        let memory = CharacterMemory(kind: .fact, text: "我的 API key 是 secret", source: "test",
                                     status: .confirmed, shareWithOnlineModel: true)

        let context = CharacterContextBuilder.make(identity: nil, memories: [memory], query: "API key")

        XCTAssertNil(context)
        XCTAssertTrue(CharacterMemoryReview.isCredentialLike(memory.text))
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
        let identity = CharacterIdentity(name: "龙妹", role: "住在桌边的伙伴", background: "我是桌边小崽的龙妹")
        let capabilities = [CharacterCapability(id: "asr", name: "本机语音识别", status: .enabled, detail: ""),
                            CharacterCapability(id: "live", name: "B 站直播接入", status: .planned, detail: "")]
        XCTAssertTrue(CharacterLocalAnswer.answer(for: "你是谁？", identity: identity, memories: [], capabilities: capabilities)?.contains("龙妹") == true)
        XCTAssertTrue(CharacterLocalAnswer.answer(for: "你会什么？", identity: identity, memories: [], capabilities: capabilities)?.contains("本机语音识别") == true)
        XCTAssertNil(CharacterLocalAnswer.answer(for: "讲个故事", identity: identity, memories: [], capabilities: capabilities))
    }

    func testLocalMemoryRecallRanksRelevantConfirmedMemoriesWithoutOnlineSharing() {
        let memories = [
            CharacterMemory(kind: .fact, text: "狗狗名字叫雪球", createdAt: Date(timeIntervalSince1970: 3),
                            source: "test", status: .confirmed),
            CharacterMemory(kind: .preference, text: "喜欢安静的咖啡馆", createdAt: Date(timeIntervalSince1970: 2),
                            source: "test", status: .confirmed),
            CharacterMemory(kind: .preference, text: "喜欢热闹的酒吧", createdAt: Date(timeIntervalSince1970: 4),
                            source: "test", status: .candidate),
        ]
        let identity = CharacterIdentity(name: "龙妹")

        let answer = CharacterLocalAnswer.answer(for: "你记得我喜欢什么咖啡馆吗？", identity: identity,
                                                 memories: memories, capabilities: [])

        XCTAssertTrue(answer?.contains("安静的咖啡馆") == true)
        XCTAssertFalse(answer?.contains("雪球") == true)
        XCTAssertFalse(answer?.contains("热闹的酒吧") == true)
    }

    func testMemoryRecallReportsNoRelevantConfirmedItem() {
        let memories = [CharacterMemory(kind: .fact, text: "狗狗名字叫雪球", source: "test", status: .confirmed)]
        let identity = CharacterIdentity(name: "龙妹")

        let answer = CharacterLocalAnswer.answer(for: "你记得我的工作安排吗？", identity: identity,
                                                 memories: memories, capabilities: [])

        XCTAssertEqual(answer, "我没有找到与这个问题相关的已确认记忆。")
    }

    func testRecallPhrasingDoesNotMatchOnlyOnConversationalWrapper() {
        let memories = [CharacterMemory(kind: .fact, text: "狗狗名字叫雪球", source: "test", status: .confirmed)]
        let identity = CharacterIdentity(name: "龙妹")

        let answer = CharacterLocalAnswer.answer(for: "你记得我之前说过的工作安排吗？", identity: identity,
                                                 memories: memories, capabilities: [])

        XCTAssertEqual(answer, "我没有找到与这个问题相关的已确认记忆。")
    }

    func testMemoryAutonomyAutoConfirmsSafeExplicitMemoryWithoutOnlineSharing() {
        let candidate = CharacterMemory(kind: .preference, text: "我喜欢安静的咖啡馆", source: "test")

        let decision = CharacterMemoryReview.automationDecision(for: candidate, against: [])

        XCTAssertEqual(decision, .autoConfirm)
        XCTAssertFalse(candidate.shareWithOnlineModel)
    }

    func testMemoryAutonomyDeduplicatesExactConfirmedMemory() {
        let existing = CharacterMemory(kind: .preference, text: "我喜欢安静的咖啡馆", source: "test",
                                       status: .confirmed)
        let candidate = CharacterMemory(kind: .preference, text: "我喜欢 安静的咖啡馆！", source: "test")

        let decision = CharacterMemoryReview.automationDecision(for: candidate, against: [existing])

        XCTAssertEqual(decision, .alreadyExists(existing))
    }

    func testMemoryAutonomyEscalatesConflictAndSensitiveDetails() {
        let existing = CharacterMemory(kind: .preference, text: "我喜欢喝咖啡", source: "test",
                                       status: .confirmed)
        let conflict = CharacterMemory(kind: .preference, text: "我不喜欢喝咖啡", source: "test")
        let payment = CharacterMemory(kind: .fact, text: "银行卡支付信息", source: "test")
        let credential = CharacterMemory(kind: .fact, text: "我的账号密码是secret", source: "test")

        guard case .requiresReview = CharacterMemoryReview.automationDecision(for: conflict, against: [existing]) else {
            return XCTFail("Conflicting memories must require review")
        }
        guard case .requiresReview = CharacterMemoryReview.automationDecision(for: payment, against: []) else {
            return XCTFail("Payment details must require review")
        }
        XCTAssertEqual(CharacterMemoryReview.automationDecision(for: credential, against: []), .doNotStore)
    }

    func testMemoryAutonomyNeverStoresCredentialEvenWhenItIsAlreadyKnown() {
        let existing = CharacterMemory(kind: .fact, text: "我的 API key 是 secret", source: "test",
                                       status: .confirmed)
        let candidate = CharacterMemory(kind: .fact, text: "我的 API key 是 secret", source: "test")

        XCTAssertEqual(CharacterMemoryReview.automationDecision(for: candidate, against: [existing]), .doNotStore)
    }

    func testMemoryAutonomyPrioritizesConflictOverDuplicate() {
        let duplicate = CharacterMemory(kind: .preference, text: "我喜欢喝咖啡", source: "test",
                                        status: .confirmed)
        let conflict = CharacterMemory(kind: .preference, text: "我不喜欢喝咖啡", source: "test",
                                       status: .confirmed)
        let candidate = CharacterMemory(kind: .preference, text: "我喜欢喝咖啡", source: "test")

        guard case .requiresReview = CharacterMemoryReview.automationDecision(
            for: candidate, against: [duplicate, conflict]
        ) else {
            return XCTFail("A conflicting memory must require review even when an exact duplicate exists")
        }
    }

    func testActionPolicyAllowsOnlyExplicitReversibleLocalChanges() {
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .readCharacterData)),
            .allowAutomatically("只读取角色资料目录，不访问其它用户文件。")
        )
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .writeLocalMemory,
                                                               explicitlyRequested: true,
                                                               reversible: true)),
            .allowAutomatically("用户已明确提出，且变更仅限本机、可撤销。")
        )
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .writeLocalMemory)),
            .requireUserApproval("必须由用户明确提出，不能从普通对话推断。")
        )
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .updateLocalGoal,
                                                               explicitlyRequested: true,
                                                               reversible: false)),
            .requireUserApproval("不可逆的本地变更需要人工确认。")
        )
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .deleteLocalData)),
            .requireUserApproval("删除、覆盖或修改角色核心身份必须人工确认。")
        )
    }

    func testActionPolicyStopsSensitiveExternalActionsAndUnknownActions() {
        let sensitiveKinds: [CharacterAction.Kind] = [
            .publishExternalContent, .accessCredential, .makePayment, .changePermission, .changeIdentity
        ]
        for kind in sensitiveKinds {
            guard case .requireUserApproval = CharacterActionPolicy.decision(
                for: CharacterAction(kind: kind, explicitlyRequested: true)
            ) else {
                return XCTFail("\(kind.rawValue) must require user approval")
            }
        }

        guard case .requireUserApproval = CharacterActionPolicy.decision(
            for: CharacterAction(kind: .unknown, explicitlyRequested: true)
        ) else {
            return XCTFail("Unknown actions must require user approval")
        }
    }

    func testActionPolicyRequiresExplicitRequestBeforeOnlineCall() {
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .sendOnlineRequest)),
            .requireUserApproval("联网请求必须由用户明确发起。")
        )
        XCTAssertEqual(
            CharacterActionPolicy.decision(for: CharacterAction(kind: .sendOnlineRequest,
                                                               explicitlyRequested: true)),
            .allowAutomatically("用户已明确发起本轮请求；资料分享仍受独立授权控制。")
        )
    }
}
