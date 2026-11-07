import Foundation
import XCTest
import DragonCore
@testable import DragonCompanion

@MainActor
final class PetRegistrationFailureTests: XCTestCase {
    private func fixture(executable: Bool) throws -> (PetInstanceRuntime, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pet-registration-" + UUID().uuidString)
        let app = root.appendingPathComponent("Fixture.app")
        let binaries = app.appendingPathComponent("Contents/MacOS")
        try FileManager.default.createDirectory(at: binaries, withIntermediateDirectories: true)
        let info: [String: Any] = ["CFBundleIdentifier": "local.test.registration", "CFBundleExecutable": "Fixture", "CFBundlePackageType": "APPL"]
        let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try plist.write(to: app.appendingPathComponent("Contents/Info.plist"))
        let binary = binaries.appendingPathComponent("Fixture")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: executable ? 0o700 : 0o600], ofItemAtPath: binary.path)
        let package = try PetPackageReference(id: "local.synthetic", version: "1.0.0")
        let registry = try PetInstanceRegistry(instances: [.init(id: "original", package: package)])
        try JSONEncoder().encode(registry).write(to: root.appendingPathComponent("pet-instances.json"))
        var config = CompanionConfiguration()
        config.petBackend = "external"
        config.externalPetAppPath = app.path
        let runtime = Runtime(resources: root, state: root, configuration: config)
        let manager = try XCTUnwrap(PetInstanceRuntime(runtime: runtime))
        return (manager, root)
    }

    private func checkFailedRegistration(executable: Bool) async throws {
        let (manager, root) = try fixture(executable: executable)
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = root.appendingPathComponent("pet-instances.json")
        let before = try Data(contentsOf: registry)
        let finished = expectation(description: "Failed helper completes the add operation")
        let package = try PetPackageReference(id: "local.other", version: "1.0.0")
        Task { @MainActor in
            do {
                _ = try await manager.addPets([package])
                XCTFail("A helper that cannot answer must not report a successful registration")
            } catch {
                XCTAssertFalse(error.localizedDescription.isEmpty)
            }
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 3)
        XCTAssertEqual(try Data(contentsOf: registry), before)
        XCTAssertEqual(manager.instances.map(\.id), ["original"])
    }

    func testExitedHelperCompletesPendingRegistrationWithoutChangingRegistry() async throws {
        try await checkFailedRegistration(executable: true)
    }

    func testLaunchFailureCompletesPendingRegistrationWithoutChangingRegistry() async throws {
        try await checkFailedRegistration(executable: false)
    }
}
