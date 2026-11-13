import AppKit
import DragonCore
import XCTest
@testable import DragonCompanion

@MainActor
final class PetManagerStateTests: XCTestCase {
    private func makeManager(
        loadCover: @escaping PetManagerWindow.CoverOperation = { _ in nil },
        operation: @escaping PetManagerWindow.SourceOperation
    ) throws -> (PetManagerWindow, URL) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pet-manager-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let manager = try PetManagerWindow(
            runtime: Runtime(resources: root, state: root, configuration: .init()),
            sourceOperation: operation, loadCover: loadCover
        )
        return (manager, root)
    }

    private func waitUntilIdle(_ manager: PetManagerWindow) async {
        for _ in 0..<200 where manager.busy {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private actor CoverGate {
        private var pending: [CheckedContinuation<CGImage?, Never>] = []
        var count: Int { pending.count }
        func load() async -> CGImage? {
            await withCheckedContinuation { pending.append($0) }
        }
        func finish(_ index: Int) { pending[index].resume(returning: nil) }
    }

    func testCoverPreparationDoesNotBlockSelectionAndRescanRejectsStaleCompletion() async throws {
        let gate = CoverGate()
        let source = LocalPetSource(path: "/synthetic-cover", id: "preview.one", version: "1.0.0",
                                    name: "Alpha", actionCount: 35, builtin: false)
        let (manager, root) = try makeManager(loadCover: { _ in await gate.load() }) { _, _ in
            LocalPetToolReply(ok: true, pets: [source], packages: nil, warnings: nil, failures: nil, error: nil)
        }
        defer { try? FileManager.default.removeItem(at: root) }
        manager.rescan()
        await waitUntilIdle(manager)
        for _ in 0..<200 {
            if await gate.count == 1 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertFalse(manager.busy)
        manager.selectSource(source.path, modifiers: [])
        XCTAssertTrue(manager.canAdd)
        guard case .loading? = manager.covers[source.path] else { return XCTFail("Cover should still be loading") }

        manager.rescan()
        await waitUntilIdle(manager)
        for _ in 0..<200 {
            if await gate.count == 2 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let count = await gate.count
        XCTAssertEqual(count, 2)
        guard count == 2 else { return }
        await gate.finish(0)
        try await Task.sleep(nanoseconds: 20_000_000)
        guard case .loading? = manager.covers[source.path] else { return XCTFail("Old task replaced the new cover state") }
        await gate.finish(1)
        for _ in 0..<200 {
            if case .unavailable? = manager.covers[source.path] { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        guard case .unavailable? = manager.covers[source.path] else { return XCTFail("Missing image must resolve to unavailable") }
        XCTAssertFalse(manager.busy)
    }

    func testScanErrorClearsLoadingAndKeepsAddDisabled() async throws {
        let (manager, root) = try makeManager { _, _ in
            throw ConfigurationError("模拟扫描失败")
        }
        defer { try? FileManager.default.removeItem(at: root) }

        manager.rescan()
        XCTAssertTrue(manager.busy)
        await waitUntilIdle(manager)

        XCTAssertFalse(manager.busy)
        XCTAssertTrue(manager.sources.isEmpty)
        XCTAssertFalse(manager.canAdd)
        XCTAssertEqual(manager.status, "模拟扫描失败")
        XCTAssertTrue(manager.windowShouldClose(manager.window!))
    }

    func testSearchPreservesHiddenSelectionAndPrepareReportsPackages() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pet-manager-sources-\(UUID().uuidString)", isDirectory: true)
        let sources = [
            LocalPetSource(path: root.appendingPathComponent("one").path, id: "preview.one",
                           version: "1.0.0", name: "Alpha", actionCount: 35, builtin: false),
            LocalPetSource(path: root.appendingPathComponent("two").path, id: "preview.two",
                           version: "2.0.0", name: "Beta", actionCount: 12, builtin: false),
        ]
        var added: [PetPackageReference] = []
        let (manager, state) = try makeManager { operation, paths in
            if operation == "scan" {
                return LocalPetToolReply(ok: true, pets: sources, packages: nil,
                                         warnings: nil, failures: nil, error: nil)
            }
            return LocalPetToolReply(
                ok: true, pets: nil,
                packages: try sources.filter { paths.contains($0.path) }
                    .map { try PetPackageReference(id: $0.id, version: $0.version) },
                warnings: nil, failures: nil, error: nil
            )
        }
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: state)
        }
        manager.addPackages = { packages, completion in
            added = packages
            completion(.success("已加入演示列表"))
        }

        manager.rescan()
        await waitUntilIdle(manager)
        XCTAssertEqual(manager.sources.count, 2)

        manager.selectSource(sources[0].path, modifiers: [])
        manager.query = "Beta"
        manager.queryChanged()
        XCTAssertEqual(manager.filteredSources.map(\.id), ["preview.two"])
        XCTAssertEqual(manager.selectedPaths, [sources[0].path])
        manager.selectSource(sources[1].path, modifiers: [.command])
        XCTAssertEqual(manager.selectedCount, 2)
        XCTAssertTrue(manager.canAdd)

        manager.addSelected()
        XCTAssertTrue(manager.busy)
        await waitUntilIdle(manager)
        XCTAssertEqual(added.map(\.id), ["preview.one", "preview.two"])
        XCTAssertEqual(manager.status, "已加入演示列表")
        XCTAssertFalse(manager.busy)
    }
}
