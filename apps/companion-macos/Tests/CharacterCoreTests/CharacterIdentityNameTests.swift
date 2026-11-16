import CharacterCore
import XCTest

final class CharacterIdentityNameTests: XCTestCase {
    func testRenamedPresetUsesCurrentNameInOnlineAndLocalIdentityWithoutMutatingStoredFields() throws {
        var identity = CharacterIdentity.starter(name: "龙妹")
        let originalRole = identity.role
        identity.name = "小桃"
        identity.shareWithOnlineModel = true
        XCTAssertTrue(identity.promptText.contains("名字：小桃"))
        XCTAssertTrue(identity.promptText.contains("我是桌边小崽里的小桃"))
        XCTAssertFalse(identity.promptText.contains("龙妹"))
        let local = try XCTUnwrap(CharacterLocalAnswer.answer(for: "你是谁", identity: identity, memories: [], capabilities: []))
        XCTAssertTrue(local.contains("小桃"))
        XCTAssertFalse(local.contains("龙妹"))
        XCTAssertEqual(identity.role, originalRole, "Rendering must not rewrite stored content")
        identity.shareWithOnlineModel = false
        XCTAssertTrue(identity.promptText.isEmpty)
    }

    func testRenamingDoesNotReplaceNamesInsideCustomProse() {
        var identity = CharacterIdentity(name: "小桃", role: "与龙妹共同学习的伙伴", background: "曾遇见龙妹", shareWithOnlineModel: true)
        XCTAssertTrue(identity.promptText.contains(identity.role))
        XCTAssertTrue(identity.promptText.contains(identity.background))
        identity.name = "小雪"
        XCTAssertTrue(identity.promptText.contains("名字：小雪"))
        XCTAssertTrue(identity.promptText.contains("与龙妹共同学习的伙伴"))
    }

    func testCompletedProfileCanBeRenamedAgainWithoutStaleSelfName() {
        var identity = CharacterIdentityCompletion.fillingBlanks(in: .init(name: "小桃"), defaultName: "龙妹")
        identity.name = "小雪"
        identity.shareWithOnlineModel = true
        XCTAssertTrue(identity.promptText.contains("我是桌边小崽里的小雪"))
        XCTAssertFalse(identity.promptText.contains("小桃"))
    }

    func testCompletionOfRenamedProfileDoesNotInsertOldSelfName() {
        let identity = CharacterIdentity(name: "小桃")
        let filled = CharacterIdentityCompletion.fillingBlanks(in: identity, defaultName: "龙妹")
        XCTAssertTrue(filled.role.contains("小桃"))
        XCTAssertFalse(filled.role.contains("龙妹"))
        let proposed = CharacterIdentityCompletion.proposedFields(for: identity, defaultName: "龙妹")
        XCTAssertEqual(proposed.first(where: { $0.id == "role" })?.value, filled.role)
    }
}
