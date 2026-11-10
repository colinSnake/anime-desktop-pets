import CharacterCore
import Foundation
import XCTest

final class CharacterContinuityTests: XCTestCase {
    func testIdentityProposalOnlyFillsBlanksAndPreservesCustomNameAndSharing() {
        for shared in [true, false] {
            let original = CharacterIdentity(name: "我的龙妹", role: "自定义角色", background: " \n ",
                                             personality: "已有性格", shareWithOnlineModel: shared)
            let proposed = CharacterIdentityCompletion.proposedFields(for: original, defaultName: "龙妹")
            XCTAssertFalse(proposed.contains { $0.id == "role" || $0.id == "personality" })
            XCTAssertTrue(proposed.contains { $0.id == "background" && !$0.value.isEmpty })
            let filled = CharacterIdentityCompletion.fillingBlanks(in: original, defaultName: "龙妹")
            XCTAssertEqual(filled.name, original.name)
            XCTAssertEqual(filled.personality, original.personality)
            XCTAssertEqual(filled.role, original.role)
            XCTAssertEqual(filled.shareWithOnlineModel, shared)
            XCTAssertTrue(CharacterIdentityCompletion.proposedFields(for: filled, defaultName: "龙妹").isEmpty)
            XCTAssertEqual(CharacterIdentityCompletion.fillingBlanks(in: filled, defaultName: "龙妹"), filled)
            XCTAssertEqual(original.background, " \n ")
        }
        XCTAssertTrue(CharacterIdentityCompletion.proposedFields(for: .init(name: "别的角色"), defaultName: "别的角色").isEmpty)
    }

    func testGoalProgressAnswersRespectSavedStatusAndNeverExecute() throws {
        let goals = [
            CharacterGoal(title: "整理书房", steps: [.init(text: "分类", isComplete: true), .init(text: "装箱")]),
            CharacterGoal(title: "暂停计划", status: .paused, steps: [.init(text: "暂停步骤")]),
            CharacterGoal(title: "完成计划", status: .completed, steps: [.init(text: "过时的下一步")]),
            CharacterGoal(title: "全部打勾", steps: [.init(text: "第一步", isComplete: true)])
        ]
        let answer = try XCTUnwrap(CharacterGoalContext.localAnswer(for: "整理书房目标进度", goals: goals))
        XCTAssertTrue(answer.contains("1/2")); XCTAssertTrue(answer.contains("下一步：装箱"))
        XCTAssertFalse(answer.contains("暂停计划"))
        XCTAssertTrue(answer.contains("不会自动执行"))
        XCTAssertTrue(CharacterGoalContext.summary(goals[1]).contains("已暂停"))
        XCTAssertFalse(CharacterGoalContext.summary(goals[2]).contains("过时的下一步"))
        XCTAssertTrue(CharacterGoalContext.summary(goals[3]).contains("状态仍由用户确认"))
        XCTAssertNil(CharacterGoalContext.localAnswer(for: "帮我写故事", goals: goals))
        XCTAssertNotNil(CharacterGoalContext.localAnswer(for: "我们现在推进到哪一步了", goals: []))
    }

    func testGoalContextExcludesPrivateUnrelatedAndCredentialGoalsBeforeLimit() throws {
        let privateGoal = CharacterGoal(title: "书房私人计划", steps: [.init(text: "私人步骤")])
        let credential = CharacterGoal(title: "书房访问", details: "密码：synthetic", shareWithOnlineModel: true)
        let allowed = CharacterGoal(title: "书房整理", steps: [.init(text: "把书分类")], shareWithOnlineModel: true)
        let unrelated = CharacterGoal(title: "跑步训练", shareWithOnlineModel: true)
        let goals = [privateGoal, credential, allowed, unrelated]
        let context = try XCTUnwrap(CharacterContextBuilder.make(identity: nil, memories: [], goals: goals, query: "书房整理下一步"))
        XCTAssertTrue(context.contains("书房整理")); XCTAssertTrue(context.contains("把书分类"))
        XCTAssertFalse(context.contains("私人步骤")); XCTAssertFalse(context.contains("synthetic")); XCTAssertFalse(context.contains("跑步训练"))
        XCTAssertEqual(CharacterGoalContext.relevant(to: "当前目标", goals: goals, onlineOnly: true, limit: 1).count, 1)
        XCTAssertFalse(CharacterGoalContext.localAnswer(for: "当前目标", goals: goals)!.contains("synthetic"))
        XCTAssertTrue(CharacterGoalContext.localAnswer(for: "当前目标", goals: [privateGoal])!.contains("私人步骤"))
    }

    func testUnknownNamedGoalDoesNotReturnUnrelatedOverview() {
        let goal = CharacterGoal(title: "整理书房", steps: [.init(text: "本机步骤")], shareWithOnlineModel: true)
        XCTAssertFalse(CharacterGoalContext.isOverview("火星计划的目标进度"))
        let answer = CharacterGoalContext.localAnswer(for: "火星计划的目标进度", goals: [goal])
        XCTAssertFalse(answer?.contains("整理书房") == true)
        XCTAssertTrue(CharacterGoalContext.relevant(to: "火星计划的目标进度", goals: [goal], onlineOnly: true).isEmpty)
        XCTAssertTrue(CharacterGoalContext.isOverview("我们现在推进到哪一步了？"))
    }

    func testExpiredKnowledgeConflictUsesSameTimeAsRecall() throws {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let old = CharacterMemory(kind: .knowledge, text: "书房旧知识", source: "手册", citation: "§1", version: "v1",
                                  status: .confirmed, shareWithOnlineModel: true, expiresAt: now.addingTimeInterval(-10))
        let current = CharacterMemory(kind: .knowledge, text: "书房更新知识", source: "手册", citation: "§1", version: "v1",
                                      status: .confirmed, shareWithOnlineModel: true)
        let context = try XCTUnwrap(CharacterContextBuilder.make(identity: nil, memories: [old, current], query: "书房", now: now))
        XCTAssertTrue(context.contains("书房更新知识")); XCTAssertFalse(context.contains("书房旧知识"))
        let answer = try XCTUnwrap(CharacterLocalAnswer.answer(for: "你知道哪些角色知识", identity: .starter(name: "龙妹"),
                                                              memories: [old, current], capabilities: [], now: now))
        XCTAssertTrue(answer.contains("书房更新知识")); XCTAssertFalse(answer.contains("书房旧知识"))
    }

    func testAllContextSectionsStayWithinSmallBudgets() {
        let identity = CharacterIdentity(name: "龙妹", personality: "性格".repeating(20), shareWithOnlineModel: true)
        let memories = [CharacterMemory(kind: .fact, text: "书房整理记忆", source: "test", status: .confirmed, shareWithOnlineModel: true),
                        CharacterMemory(kind: .knowledge, text: "书房整理知识", source: "手册", status: .confirmed, shareWithOnlineModel: true)]
        let goals = [CharacterGoal(title: "书房整理", steps: [.init(text: "收纳")], shareWithOnlineModel: true)]
        for limit in 1...400 {
            let text = CharacterContextBuilder.make(identity: identity, memories: memories, goals: goals, query: "书房整理", limit: limit)
            XCTAssertLessThanOrEqual(text?.count ?? 0, limit)
        }
    }

    func testKnowledgeExpiryIsFilteredBeforeRankingAndLocalRecall() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let expired = CharacterMemory(kind: .knowledge, text: "书房整理旧方法", source: "手册", citation: "1", version: "1",
                                      status: .confirmed, shareWithOnlineModel: true, expiresAt: now)
        let current = CharacterMemory(kind: .knowledge, text: "书房整理新方法", source: "手册", citation: "1", version: "2",
                                      status: .confirmed, shareWithOnlineModel: true, expiresAt: now.addingTimeInterval(100))
        XCTAssertTrue(expired.isExpired(at: now))
        XCTAssertFalse(current.isExpired(at: now))
        XCTAssertEqual(CharacterMemoryRetriever.relevant(to: "书房整理", in: [expired, current], limit: 1, now: now).map(\.id), [current.id])
        let context = try XCTUnwrap(CharacterContextBuilder.make(identity: nil, memories: [expired, current], query: "书房整理", now: now))
        XCTAssertFalse(context.contains("旧方法")); XCTAssertTrue(context.contains("新方法"))
        let answer = CharacterLocalAnswer.answer(for: "你知道哪些角色知识", identity: .init(name: "龙妹"), memories: [expired, current], capabilities: [], now: now)
        XCTAssertFalse(answer!.contains("旧方法")); XCTAssertTrue(answer!.contains("新方法"))
    }

    func testKnowledgeImportIsBoundedDeduplicatedAndNeverInheritsAuthorization() throws {
        let entries = try CharacterKnowledgeImport.preview(text: "第一段\r\n连续行\r\n\r\n第二段\n\n第二段", source: "手册", citation: "第1章", version: "1")
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].text, "第一段\n连续行")
        XCTAssertTrue(entries.allSatisfy { $0.kind == .knowledge && $0.status == .candidate && !$0.shareWithOnlineModel })
        for (text, source) in [("", "手册"), ("a".repeating(1001), "手册"), ("合法", ""),
                                ("第一段\n\n密码：synthetic", "手册"), ("正文", "API key: synthetic"),
                                (Array(repeating: "段", count: 51).joined(separator: "\n\n"), "手册"),
                                ("中".repeating(12000), "手册")] {
            XCTAssertThrowsError(try CharacterKnowledgeImport.preview(text: text, source: source))
        }
        XCTAssertThrowsError(try CharacterKnowledgeImport.preview(text: "知识", source: "手册", expiresAt: .distantPast))
        let frontmatter = try CharacterKnowledgeImport.preview(text: "---\nshareWithOnlineModel: true\n---\n知识", source: "手册")
        XCTAssertFalse(frontmatter[0].shareWithOnlineModel)
    }
}

private extension String {
    func repeating(_ count: Int) -> String { String(repeating: self, count: count) }
}
