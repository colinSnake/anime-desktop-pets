import XCTest
@testable import DragonCore

final class PetPresentationTests: XCTestCase {
    func testLongmeiDisplayNameKeepsLegacyIdentity() {
        XCTAssertEqual(PetPresentation.name(id: "white-dragon"), "龙妹")
        XCTAssertEqual(PetPresentation.name(id: "white-dragon-copy"), "龙妹·分身")
        XCTAssertEqual(PetPresentation.name(id: "white-dragon-copy-2"), "龙妹·分身-2")
        XCTAssertEqual(PetPresentation.name(id: "other-pet", displayName: "小猫"), "小猫")
        XCTAssertEqual(PetPresentation.name(id: "other-pet"), "other-pet")
        XCTAssertEqual(PetPresentation.name(id: "white-dragon-copycat", displayName: "小猫"), "小猫")
    }

    func testRunningTitleDoesNotExposeAutoRestoreDetail() throws {
        let package = try PetPackageReference(id: "local.bailong.white-dragon", version: "1.0.0")
        for restore in [true, false] {
            let row = PetInstanceControlRow(id: "white-dragon", package: package, enabled: true,
                autoStartOnLaunch: restore, preferences: .init(), phase: .running)
            XCTAssertEqual(PetPresentation.menuTitle(row), "龙妹 · 运行中")
            XCTAssertEqual(row.autoStartOnLaunch, restore)
        }
        let stopped = PetInstanceControlRow(id: "cat", package: package, enabled: true,
            preferences: .init(), phase: .failed, error: "校验失败", displayName: "小猫")
        XCTAssertEqual(PetPresentation.menuTitle(stopped), "小猫 · 异常 · 校验失败")
    }

    func testDisplayNameIsOptionalAndRoundTripsWithoutChangingIDs() throws {
        let package = try PetPackageReference(id: "local.cat", version: "1.0.0")
        let row = try PetInstanceDefinition(id: "cat", package: package, autoStartOnLaunch: false, displayName: "小猫")
        let decoded = try JSONDecoder().decode(PetInstanceDefinition.self, from: JSONEncoder().encode(row))
        XCTAssertEqual(decoded, row)
        let old = try PetInstanceDefinition(id: "white-dragon", package: package)
        XCTAssertNil(try JSONDecoder().decode(PetInstanceDefinition.self, from: JSONEncoder().encode(old)).displayName)
        for name in ["", "\n", "cat\u{7f}", String(repeating: "猫", count: 81)] {
            XCTAssertThrowsError(try PetInstanceDefinition(id: "cat", package: package, displayName: name))
        }
    }

    func testAddPetsProtocolValidatesBatchIdentityAndLimit() throws {
        let first = try PetPackageReference(id: "local.cat", version: "1.0.0")
        let second = try PetPackageReference(id: "local.dog", version: "1.0.0")
        XCTAssertNoThrow(try PetInstanceControlRequest(.addPets, packages: [first, second]).encoded())
        for request in [PetInstanceControlRequest(.addPets), .init(.addPets, packages: []),
                        .init(.addPets, packages: [first, first]),
                        .init(.addPets, instanceID: "cat", packages: [first]),
                        .init(.status, packages: [first])] {
            XCTAssertThrowsError(try request.encoded())
        }
        let tooMany = try (1...17).map { try PetPackageReference(id: "local.pet\($0)", version: "1.0.0") }
        XCTAssertThrowsError(try PetInstanceControlRequest(.addPets, packages: tooMany).encoded())
    }
}
