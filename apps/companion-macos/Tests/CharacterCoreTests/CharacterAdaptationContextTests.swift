import CharacterCore
import XCTest

final class CharacterAdaptationContextTests: XCTestCase {
    func testAdaptationRequiresIndependentSharingAndNeverSendsEvidence() {
        var state = CharacterAdaptationState()
        let evidence = "以后请回答简短一点。"
        _ = state.observe(.init(role: .user, text: evidence))
        XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [], adaptation: state, query: "解释缓存"))
        state.shareWithOnlineModel = true
        let context = CharacterContextBuilder.make(identity: nil, memories: [], adaptation: state, query: "解释缓存")
        XCTAssertTrue(context?.contains("表达适应") == true)
        XCTAssertTrue(context?.contains("120字") == true)
        XCTAssertFalse(context?.contains(evidence) == true)
        state.enabled = false
        XCTAssertNil(CharacterContextBuilder.make(identity: nil, memories: [], adaptation: state, query: "解释缓存"))
    }
}
