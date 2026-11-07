import CharacterCore
import CharacterMemory
import Foundation
import SwiftUI

@MainActor
public final class CharacterWorkspaceModel: ObservableObject {
    @Published public var identity: CharacterIdentity
    @Published public private(set) var memories: [CharacterMemory] = []
    @Published public private(set) var status = ""
    @Published public private(set) var canSaveIdentity = false

    private let store: CharacterMemoryStore
    private let defaultName: String

    public init(store: CharacterMemoryStore, defaultName: String) {
        self.store = store
        self.defaultName = defaultName
        identity = .starter(name: defaultName)
        refresh()
    }

    public func refresh() {
        Task {
            do {
                identity = try await store.loadIdentity(defaultName: defaultName)
                memories = try await store.listMemories()
                canSaveIdentity = true
                status = ""
            } catch {
                canSaveIdentity = false
                status = error.localizedDescription
            }
        }
    }

    public func saveIdentity() {
        guard canSaveIdentity else { return }
        Task {
            do {
                try await store.saveIdentity(identity)
                status = "身份资料已保存。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func addMemory(text: String, kind: CharacterMemoryKind) {
        let item = CharacterMemory(kind: kind, text: text, source: "用户在角色与记忆窗口添加")
        Task {
            do {
                try await store.saveMemory(item)
                memories = try await store.listMemories()
                status = "记忆已加入审核列表，确认后才会正式保存。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func confirm(_ memory: CharacterMemory) {
        Task {
            do {
                try await store.confirmMemory(memory)
                memories = try await store.listMemories()
                status = "记忆已确认。"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func update(_ memory: CharacterMemory) {
        Task {
            do {
                try await store.saveMemory(memory)
                memories = try await store.listMemories()
            } catch {
                status = error.localizedDescription
            }
        }
    }

    public func delete(_ memory: CharacterMemory) {
        Task {
            do {
                try await store.deleteMemory(id: memory.id)
                memories = try await store.listMemories()
                status = "记忆已删除。"
            } catch {
                status = error.localizedDescription
            }
        }
    }
}
