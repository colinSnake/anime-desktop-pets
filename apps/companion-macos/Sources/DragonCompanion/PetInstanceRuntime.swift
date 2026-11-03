import AppKit
import DragonCore
import Foundation

/// Swift host for the single Qt process that owns all real pet windows.
@MainActor
final class PetInstanceRuntime {
    var taskFollowingAllowed = false
    private let runtime: Runtime
    private let profile: URL
    private let executable: URL
    private var process: Process?
    private var poll: Timer?
    private var expectedTermination = false
    private var controlReady = false
    private var generation = UUID()
    private enum Operation {
        case restore(excluding: Set<String>)
        case request(PetInstanceControlRequest)
    }
    private var pending: [Operation] = []
    private var sending = false
    private var reservedCloneIDs = Set<String>()
    private(set) var status: PetInstanceControlStatus?
    private(set) var lastError: String?
    var onChanged: (() -> Void)?

    var isConfigured: Bool {
        guard let data = try? Data(contentsOf: profile.appendingPathComponent("pet-instances.json")),
              let registry = try? PetInstanceRegistry.decode(data) else { return false }
        return registry.instances.contains(where: { $0.enabled })
    }

    var isVisible: Bool {
        status?.instances.contains(where: { $0.phase == .running }) == true
    }

    /// Status is populated asynchronously after the helper opens its socket. Keep
    /// the menu useful during that short window by reading the validated registry.
    var instances: [PetInstanceControlRow] {
        if let rows = status?.instances { return rows }
        guard let data = try? Data(contentsOf: profile.appendingPathComponent("pet-instances.json")),
              let registry = try? PetInstanceRegistry.decode(data) else { return [] }
        return registry.instances.map { definition in
            PetInstanceControlRow(id: definition.id, package: definition.package,
                                  enabled: definition.enabled, preferences: definition.preferences,
                                  phase: .stopped, error: nil)
        }
    }

    var state: String {
        if let lastError { return "failed: \(lastError)" }
        if process?.isRunning == true {
            if status?.instances.contains(where: { $0.phase == .starting }) == true { return "starting" }
            if isVisible { return "visible" }
            return "running";
        }
        return "idle"
    }

    init?(runtime: Runtime) {
        guard runtime.configuration.petBackend == "external" else { return nil }
        let profile = runtime.state
        guard let data = try? Data(contentsOf: profile.appendingPathComponent("pet-instances.json")),
              let registry = try? PetInstanceRegistry.decode(data),
              registry.instances.contains(where: { $0.enabled }) else { return nil }
        let appURL = runtime.configuration.resourceURL(runtime.configuration.externalPetAppPath, relativeTo: runtime.resources)
        guard let executable = Bundle(url: appURL)?.executableURL else { return nil }
        self.runtime = runtime
        self.profile = profile
        self.executable = executable
    }

    func start() { show() }

    private func launchIfNeeded() {
        if process?.isRunning == true { return }
        process = nil
        generation = UUID()
        sending = false; status = nil
        let token = generation
        controlReady = false
        expectedTermination = false
        lastError = nil
        let child = Process()
        child.executableURL = executable
        child.arguments = ["--multi-profile", profile.path]
        child.currentDirectoryURL = executable.deletingLastPathComponent()
        var environment = ["BAILONG_DATA_DIR": profile.path]
        environment["BAILONG_PET_LIBRARY_DIR"] = runtime.petLibraryURL.path
        environment["DRAGON_TASK_LEASE"] = taskFollowingAllowed ? runtime.state.appendingPathComponent("codex-task-lease.json").path : ""
        if let assetsURL = runtime.configuration.externalPetAssetsURL(relativeTo: runtime.resources) {
            environment["BAILONG_ASSETS_DIR"] = assetsURL.path
        }
        child.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        child.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                self.helperTerminated()
            }
        }
        do {
            try child.run()
            process = child
            waitForControlSocket(token: token)
        } catch {
            pending.removeAll(); reservedCloneIDs.removeAll()
            fail(error.localizedDescription)
        }
    }

    func show() {
        pending.append(.restore(excluding: []))
        launchIfNeeded()
        drain()
    }

    func start(instanceID: String) {
        pending.append(.request(.init(.startPet, instanceID: instanceID)))
        launchIfNeeded()
        drain()
    }

    func hide() {
        pending.removeAll { operation in
            switch operation {
            case .restore: return true
            case .request(let request): return request.command == .startPet || request.command == .startSelected
            }
        }
        guard process?.isRunning == true else { return }
        send(.init(.stopAll))
    }

    func stop(instanceID: String) {
        pending = pending.compactMap { operation in
            switch operation {
            case .restore(var excluded):
                excluded.insert(instanceID)
                return .restore(excluding: excluded)
            case .request(let request):
                return request.command == .startPet && request.instanceID == instanceID ? nil : operation
            }
        }
        guard process?.isRunning == true else { return }
        send(.init(.stopPet, instanceID: instanceID))
    }

    func clone(sourceID: String) {
        guard let cloneID = PetInstancePlanning.nextCloneID(
            sourceID: sourceID, used: Set(instances.map(\.id)).union(reservedCloneIDs)) else {
            fail("无法生成小分身ID：实例名称过长或数量已达上限")
            return
        }
        reservedCloneIDs.insert(cloneID)
        pending.append(.request(.init(.clonePet, instanceID: sourceID, cloneID: cloneID)))
        launchIfNeeded()
        drain()
    }

    func setSize(_ size: Int, for instanceID: String) {
        guard (128...384).contains(size) else { return }
        setPreferences(.init(size: size), for: instanceID)
    }

    func setPackage(_ package: PetPackageReference, for instanceID: String) {
        pending.append(.request(.init(.setPackage, instanceID: instanceID, package: package)))
        launchIfNeeded()
        drain()
    }

    func stop() {
        poll?.invalidate(); poll = nil
        pending.removeAll()
        guard process?.isRunning == true else { return }
        expectedTermination = true
        send(.init(.shutdown))
    }

    func setPreferences(_ patch: PetPreferencePatch, for instanceID: String) {
        pending.append(.request(.init(.setPreferences, instanceID: instanceID, preferences: patch)))
        launchIfNeeded()
        drain()
    }

    private func waitForControlSocket(token: UUID) {
        Task { @MainActor [weak self] in
            for _ in 0..<100 {
                guard let self, self.generation == token, self.process?.isRunning == true else { return }
                // A file may belong to a stale socket. Only a valid status reply
                // marks the controller ready; no mutation is sent speculatively.
                do {
                    let reply = try await self.sendAsync(.init(.status))
                    guard self.generation == token else { return }
                    if reply.ok {
                        self.apply(reply)
                        self.controlReady = true
                        self.drain()
                        if !self.expectedTermination { self.beginPolling() }
                        return
                    }
                } catch { /* Wait for helper initialization, not just file existence. */ }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            guard let self, self.generation == token else { return }
            self.fail("白龙多实例控制通道启动超时")
        }
    }

    private func beginPolling() {
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.expectedTermination, !self.sending, self.pending.isEmpty else { return }
                self.send(.init(.status))
            }
        }
    }

    private func send(_ request: PetInstanceControlRequest) {
        pending.append(.request(request))
        drain()
    }

    /// Serialize mutations and polling so an older status cannot overwrite the
    /// reply to a newer command. Never replay a command after uncertain delivery.
    private func drain() {
        guard controlReady, !sending, process?.isRunning == true else { return }
        sending = true
        let token = generation
        Task { @MainActor [weak self] in
            guard let self else { return }
            while self.generation == token, self.controlReady, !self.pending.isEmpty {
                let operation = self.pending.removeFirst()
                let request: PetInstanceControlRequest
                switch operation {
                case .request(let value): request = value
                case .restore(let excluded):
                    guard let data = try? Data(contentsOf: self.profile.appendingPathComponent("pet-instances.json")),
                          let registry = try? PetInstanceRegistry.decode(data) else { continue }
                    let ids = PetInstancePlanning.restorationIDs(
                        registry: registry, rows: self.status?.instances ?? [],
                        maximumRunning: self.status?.maximumRunning ?? 3, excluding: excluded)
                    guard !ids.isEmpty else { continue }
                    request = .init(.startSelected, instanceIDs: ids)
                }
                do {
                    let reply = try await self.sendAsync(request)
                    guard self.generation == token else { return }
                    self.apply(reply)
                } catch {
                    guard self.generation == token else { return }
                    self.fail(error.localizedDescription)
                }
                if let cloneID = request.cloneID { self.reservedCloneIDs.remove(cloneID) }
            }
            guard self.generation == token else { return }
            self.sending = false
        }
    }

    private func sendAsync(_ request: PetInstanceControlRequest) async throws -> PetInstanceControlReply {
        let directory = profile
        return try await Task.detached(priority: .utility) {
            try PetInstanceControlClient.send(request, directory: directory, timeout: 2)
        }.value
    }

    private func apply(_ reply: PetInstanceControlReply?) {
        guard let reply else { return }
        status = reply.result?.status
        lastError = reply.ok ? nil : reply.error?.message
        onChanged?()
    }

    private func fail(_ message: String) {
        lastError = String(message.prefix(512))
        onChanged?()
    }

    private func helperTerminated() {
        poll?.invalidate(); poll = nil; process = nil
        generation = UUID()
        controlReady = false; sending = false
        pending.removeAll(); reservedCloneIDs.removeAll()
        status = nil
        if !expectedTermination && lastError == nil { lastError = "白龙多实例 helper 已退出" }
        expectedTermination = false
        onChanged?()
    }
}
