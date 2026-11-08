import CharacterCore
@testable import CharacterUI
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

    func testActionPolicyAllowsOnlyIssuedExplicitReversibleLocalChanges() async {
        await MainActor.run {
            var uptime: TimeInterval = 100
            let issuer = CharacterActionContextIssuer(lifetime: 30, uptime: { uptime })
            let read = issuer.issueFromUserEvent(kind: .readCharacterData)
            XCTAssertEqual(issuer.authorizeForExecution(read),
                           .allowAutomatically("只读取角色资料目录，不访问其它用户文件。"))

            let write = issuer.issueFromUserEvent(kind: .writeLocalMemory,
                                                  reversibility: .confirmed)
            XCTAssertEqual(issuer.authorizeForExecution(write),
                           .allowAutomatically("用户已明确提出，且变更仅限本机、可撤销。"))

            let unknownReversibility = issuer.issueFromUserEvent(kind: .updateLocalGoal)
            XCTAssertEqual(issuer.authorizeForExecution(unknownReversibility),
                           .requireUserApproval("变更的撤销能力未确认，需要人工审核。"))

            let suggestion = issuer.issueModelSuggestion(kind: .writeLocalMemory)
            XCTAssertEqual(issuer.authorizeForExecution(suggestion),
                           .requireUserApproval("必须由用户明确提出，不能从普通对话推断。"))
            uptime += 1
        }
    }

    func testActionPolicyRequiresApprovalForHighImpactAndDeniesCredentialAccess() async {
        await MainActor.run {
            let issuer = CharacterActionContextIssuer()
            let protectedKinds: [CharacterActionKind] = [
                .deleteLocalData, .changeIdentity, .publishExternalContent, .makePayment, .changePermission
            ]
            for kind in protectedKinds {
                guard case .requireUserApproval = issuer.authorizeForExecution(
                    issuer.issueFromUserEvent(kind: kind)
                ) else {
                    return XCTFail("\(kind.rawValue) must require approval")
                }
            }

            let credential = issuer.issueFromUserEvent(kind: .accessCredential)
            XCTAssertEqual(issuer.authorizeForExecution(credential),
                           .deny("桌边小崽不读取或暴露密码、API Key、Token 等凭证。"))

            let unknown = issuer.issueModelSuggestion(kind: .unknown)
            XCTAssertEqual(issuer.authorizeForExecution(unknown),
                           .requireUserApproval("未知动作不得自动执行。"))
        }
    }

    func testActionContextIsOneTimeExpiresAndCannotCrossIssuer() async {
        await MainActor.run {
            var uptime: TimeInterval = 100
            let issuer = CharacterActionContextIssuer(lifetime: 5, uptime: { uptime })
            let context = issuer.issueFromUserEvent(kind: .sendOnlineRequest)
            XCTAssertEqual(issuer.authorizeForExecution(context),
                           .allowAutomatically("用户已明确发起本轮请求；身份和记忆分享仍分别受授权控制。"))
            XCTAssertEqual(issuer.authorizeForExecution(context),
                           .deny("操作凭证无效、已过期或已使用，请重新发起。"))

            let foreignIssuer = CharacterActionContextIssuer(lifetime: 5, uptime: { uptime })
            let foreign = foreignIssuer.issueFromUserEvent(kind: .readCharacterData)
            XCTAssertEqual(issuer.authorizeForExecution(foreign),
                           .deny("操作凭证无效、已过期或已使用，请重新发起。"))

            let expired = issuer.issueFromUserEvent(kind: .readCharacterData)
            uptime += 6
            XCTAssertEqual(issuer.authorizeForExecution(expired),
                           .deny("操作凭证无效、已过期或已使用，请重新发起。"))
        }
    }

    func testSensitiveActionNeedsFreshApprovalContext() async {
        await MainActor.run {
            var uptime: TimeInterval = 100
            let issuer = CharacterActionContextIssuer(lifetime: 5, uptime: { uptime })
            let request = issuer.issueFromUserEvent(kind: .publishExternalContent)
            guard case .requireUserApproval = issuer.authorizeForExecution(request) else {
                return XCTFail("Unapproved external action must not pass")
            }

            guard let approved = issuer.issueAfterUserApproval(for: request) else {
                return XCTFail("A valid pending external action should be approvable")
            }
            XCTAssertEqual(issuer.authorizeForExecution(approved),
                           .allowAutomatically("用户已对本次明确操作作出确认。"))
            XCTAssertEqual(issuer.authorizeForExecution(approved),
                           .deny("操作凭证无效、已过期或已使用，请重新发起。"))
            XCTAssertNil(issuer.issueAfterUserApproval(for: request), "A pending approval can be renewed only once")

            let foreignIssuer = CharacterActionContextIssuer(lifetime: 5, uptime: { uptime })
            let foreignRequest = foreignIssuer.issueFromUserEvent(kind: .makePayment)
            XCTAssertNil(issuer.issueAfterUserApproval(for: foreignRequest), "Approval cannot cross issuers")

            let expired = issuer.issueFromUserEvent(kind: .changeIdentity)
            uptime += 6
            XCTAssertNil(issuer.issueAfterUserApproval(for: expired), "Expired actions cannot be approved")

            let credential = issuer.issueFromUserEvent(kind: .accessCredential)
            XCTAssertNil(issuer.issueAfterUserApproval(for: credential), "Credential access cannot be approved")
        }
    }

    func testGoalDraftNormalizationTrimsAndRejectsInvalidLimits() {
        let draft = CharacterGoalDraft(title: "  学习 Swift  ", details: "  每天练习  ",
                                       steps: ["  看文档 ", "", "完成小项目"])
        XCTAssertEqual(draft.normalized(), CharacterGoalDraft(title: "学习 Swift", details: "每天练习",
                                                               steps: ["看文档", "完成小项目"]))
        XCTAssertNil(CharacterGoalDraft(title: "\n", steps: ["步骤"]).normalized())
        XCTAssertNil(CharacterGoalDraft(title: "有效标题", steps: [String(repeating: "a", count: 501)]).normalized())
        XCTAssertNil(CharacterGoalDraft(title: "有效标题", steps: Array(repeating: "步骤", count: 51)).normalized())
        XCTAssertNil(CharacterGoalDraft(title: "有效标题", steps: ["<!-- 注释载荷 -->"]).normalized())
    }
    func testChatSessionKeepsOnlyBoundedRecentTurnsInMemory() {
        var session = CharacterChatSession()
        for index in 0..<20 {
            session.append(role: index.isMultiple(of: 2) ? .user : .assistant,
                           text: String(repeating: "字", count: 2_000))
        }

        XCTAssertLessThanOrEqual(session.turns.count, CharacterChatSession.maxTurns)
        XCTAssertLessThanOrEqual(session.turns.reduce(0) { $0 + $1.text.count },
                                  CharacterChatSession.maxCharacters)
        XCTAssertEqual(session.turns.last?.text.count, CharacterChatSession.maxTextCharacters)
    }

    func testChatInputRejectsEmptyAndOverlongMessagesWithoutTruncating() {
        XCTAssertNil(CharacterChatSession.validatedInput(" \n "))
        XCTAssertEqual(CharacterChatSession.validatedInput("  你好  "), "你好")
        XCTAssertEqual(CharacterChatSession.validatedInput(String(repeating: "字", count: 1_200))?.count, 1_200)
        XCTAssertNil(CharacterChatSession.validatedInput(String(repeating: "字", count: 1_201)))
    }

    func testKnowledgeIsSeparatedFromUserMemoryInOnlineContext() {
        let memories = [
            CharacterMemory(kind: .knowledge, text: "龙妹喜欢把复杂事情拆成小步骤", source: "test",
                            status: .confirmed, shareWithOnlineModel: true),
            CharacterMemory(kind: .preference, text: "用户喜欢短句", source: "test",
                            status: .confirmed, shareWithOnlineModel: true),
        ]

        let context = CharacterContextBuilder.make(identity: nil, memories: memories,
                                                   query: "拆成小步骤，用户喜欢短句")

        XCTAssertTrue(context?.contains("角色知识") == true)
        XCTAssertTrue(context?.contains("龙妹喜欢把复杂事情拆成小步骤") == true)
        XCTAssertTrue(context?.contains("用户记忆") == true)
        XCTAssertTrue(context?.contains("用户喜欢短句") == true)
    }

}
