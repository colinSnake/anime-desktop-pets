import XCTest
@testable import DragonCore

final class ConfigurationTests: XCTestCase {
    func testDefaultsValidate() throws { try CompanionConfiguration().validate() }
    func testRoundTrip() throws {
        let original = CompanionConfiguration()
        XCTAssertEqual(try CompanionConfiguration.decode(JSONEncoder().encode(original)), original)
    }
    func testLegacyConfigurationDefaultsNewPetAssetPath() throws {
        let data = Data("{\"schemaVersion\":1,\"codexBundleIdentifier\":\"com.openai.codex\",\"codexAppPath\":\"\",\"videoPath\":\"media/startup.mp4\",\"holdAt\":11.3,\"transitionStart\":12.7,\"transitionEnd\":13.65,\"launchTimeout\":60,\"windowWaitTimeout\":30,\"volume\":1,\"playerMaxWidth\":1280,\"petEnabled\":true,\"petImagePath\":\"pet/preview.png\",\"petSize\":210,\"hidePetInFullscreen\":true,\"petBackend\":\"native\",\"externalPetAppPath\":\"\",\"themeEnabled\":false}".utf8)
        XCTAssertEqual(try CompanionConfiguration.decode(data).externalPetAssetsPath, "")
        XCTAssertTrue(try CompanionConfiguration.decode(data).taskFollowingEnabled)
    }
    func testTaskFollowingCanBeDisabledAndRejectsInvalidType() throws {
        var configuration = CompanionConfiguration()
        configuration.taskFollowingEnabled = false
        let data = try JSONEncoder().encode(configuration)
        XCTAssertFalse(try CompanionConfiguration.decode(data).taskFollowingEnabled)
        var fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        fields["taskFollowingEnabled"] = "true"
        XCTAssertThrowsError(try CompanionConfiguration.decode(JSONSerialization.data(withJSONObject: fields)))
    }
    func testOrderedTimings() {
        for values in [(0.0, 2.0, 3.0), (2, 1, 3), (1, 3, 3)] {
            var c = CompanionConfiguration(); c.holdAt = values.0; c.transitionStart = values.1; c.transitionEnd = values.2
            XCTAssertThrowsError(try c.validate())
        }
    }
    func testNonFiniteValuesRejected() {
        var c = CompanionConfiguration(); c.volume = .nan; XCTAssertThrowsError(try c.validate())
        c = .init(); c.holdAt = .infinity; XCTAssertThrowsError(try c.validate())
    }
    func testVolumeAndDimensions() {
        var c = CompanionConfiguration(); c.volume = 1.01; XCTAssertThrowsError(try c.validate())
        c = .init(); c.petSize = 0; XCTAssertThrowsError(try c.validate())
        c = .init(); c.petSize = 127; XCTAssertThrowsError(try c.validate())
        c = .init(); c.petSize = 385; XCTAssertThrowsError(try c.validate())
        c = .init(); c.petSize = 384; XCTAssertNoThrow(try c.validate())
        c = .init(); c.playerMaxWidth = 10000; XCTAssertThrowsError(try c.validate())
    }
    func testWaitBudgets() {
        var c = CompanionConfiguration(); c.launchTimeout = 0; XCTAssertThrowsError(try c.validate())
        c = .init(); c.windowWaitTimeout = -1; XCTAssertThrowsError(try c.validate())
    }
    func testUnknownSchemaRejected() {
        var c = CompanionConfiguration(); c.schemaVersion = 2; XCTAssertThrowsError(try c.validate())
    }
    func testBlankBundleRejected() {
        var c = CompanionConfiguration(); c.codexBundleIdentifier = "  "; XCTAssertThrowsError(try c.validate())
    }
    func testThemeCannotBeSilentlyEnabled() {
        var c = CompanionConfiguration(); c.themeEnabled = true; XCTAssertThrowsError(try c.validate())
    }
    func testExternalBackendNeedsPath() {
        var c = CompanionConfiguration(); c.petBackend = "external"; XCTAssertThrowsError(try c.validate())
        c.externalPetAppPath = "/Applications/Pet.app"; XCTAssertNoThrow(try c.validate())
    }
    func testUnknownBackendRejected() {
        var c = CompanionConfiguration(); c.petBackend = "shell"; XCTAssertThrowsError(try c.validate())
    }
    func testOpacityEndpointsAndMidpoint() {
        let c = CompanionConfiguration()
        XCTAssertEqual(c.opacity(at: 0), 1)
        XCTAssertEqual(c.opacity(at: c.transitionStart), 1)
        XCTAssertEqual(c.opacity(at: (c.transitionStart + c.transitionEnd) / 2), 0.5, accuracy: 0.0001)
        XCTAssertEqual(c.opacity(at: c.transitionEnd), 0)
        XCTAssertEqual(c.opacity(at: 100), 0)
        XCTAssertEqual(c.opacity(at: .nan), 1)
    }
    func testOpacityMonotonic() {
        let c = CompanionConfiguration(); var previous = 1.0
        for i in 0...200 {
            let current = c.opacity(at: Double(i) / 10)
            XCTAssertLessThanOrEqual(current, previous); XCTAssertGreaterThanOrEqual(current, 0); previous = current
        }
    }
    func testResourcePaths() {
        let c = CompanionConfiguration(), root = URL(fileURLWithPath: "/test/resources")
        XCTAssertEqual(c.resourceURL("media/startup.mp4", relativeTo: root).path, "/test/resources/media/startup.mp4")
        XCTAssertEqual(c.resourceURL("/tmp/movie.mp4", relativeTo: root).path, "/tmp/movie.mp4")
        XCTAssertTrue(c.resourceURL("~/movie.mp4", relativeTo: root).path.hasPrefix(NSHomeDirectory()))
        var configured = c
        configured.externalPetAssetsPath = "~/.local/pet-assets/白龙"
        XCTAssertEqual(configured.externalPetAssetsURL(relativeTo: root)?.path,
                       NSHomeDirectory() + "/.local/pet-assets/白龙")
        configured.externalPetAssetsPath = ""
        XCTAssertNil(configured.externalPetAssetsURL(relativeTo: root))
    }
    func testMalformedAndPartialConfigRejected() {
        XCTAssertThrowsError(try CompanionConfiguration.decode(Data("{}".utf8)))
        XCTAssertThrowsError(try CompanionConfiguration.decode(Data("{\"schemaVersion\":2}".utf8)))
        XCTAssertThrowsError(try CompanionConfiguration.decode(Data("oops".utf8)))
    }
}
