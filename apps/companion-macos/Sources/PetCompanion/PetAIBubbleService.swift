import CharacterCore
import Darwin
import Foundation

/// Coarse events are the entire online payload. No arbitrary helper text is accepted.
enum PetBubbleEvent: String, Codable, Sendable { case idle, interaction, reminder }

@MainActor
final class PetAIBubbleService {
    private struct Budget: Codable {
        var day: Int
        var attempts: Int
        var lastAttempt: Date
    }
    private let settings: SpeechSettingsStore
    private let budgetURL: URL
    private let now: () -> Date
    private let generate: (PetBubbleEvent) async throws -> String
    private var active: Task<String?, Never>?
    private var generation = UUID()
    private var observer: NSObjectProtocol?

    init(stateDirectory: URL, now: @escaping () -> Date = Date.init,
         generate: @escaping (PetBubbleEvent) async throws -> String) {
        settings = SpeechSettingsStore(stateDirectory: stateDirectory)
        budgetURL = stateDirectory.appendingPathComponent("ai-bubble-budget.json")
        self.now = now
        self.generate = generate
        observer = NotificationCenter.default.addObserver(forName: .petAIBubbleConsentChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.cancel() }
        }
    }

    deinit {
        active?.cancel()
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    func cancel() {
        generation = UUID()
        active?.cancel()
        active = nil
    }

    func reply(to event: PetBubbleEvent) async -> String? {
        guard active == nil,
              let consent = try? settings.load(), consent.aiBubblesEnabled,
              let consentID = consent.aiBubblesConsentID else { return nil }
        // Persist the attempt before any work, including failed model/configuration calls.
        guard (try? reserve(at: now())) == true else { return nil }
        let token = UUID()
        generation = token
        let generate = self.generate
        let task = Task<String?, Never> {
            do {
                let line = try await generate(event)
                try Task.checkCancellation()
                return Self.safeLine(line)
            } catch { return nil }
        }
        active = task
        let result = await task.value
        guard generation == token else { return nil }
        active = nil
        guard !Task.isCancelled,
              let current = try? settings.load(), current.aiBubblesEnabled,
              current.aiBubblesConsentID == consentID else { return nil }
        return result
    }

    private func reserve(at date: Date) throws -> Bool {
        let day = Int(floor(date.timeIntervalSince1970 / 86_400))
        var info = stat()
        var budget: Budget
        if lstat(budgetURL.path, &info) == 0 {
            guard (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_size <= 4096 else { return false }
            budget = try JSONDecoder().decode(Budget.self, from: Data(contentsOf: budgetURL))
            guard budget.attempts >= 0, budget.attempts <= 12,
                  day >= budget.day, date.timeIntervalSince(budget.lastAttempt) >= 600 else { return false }
            if day > budget.day { budget.day = day; budget.attempts = 0 }
            guard budget.attempts < 12 else { return false }
            budget.attempts += 1; budget.lastAttempt = date
        } else {
            guard errno == ENOENT else { return false }
            budget = Budget(day: day, attempts: 1, lastAttempt: date)
        }
        try JSONEncoder().encode(budget).write(to: budgetURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: budgetURL.path)
        return true
    }

    static func safeLine(_ value: String) -> String? {
        let line = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, line.count <= 60,
              !line.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !CharacterMemoryReview.isCredentialLike(line),
              !["http", "www.", "```", "已经完成", "已完成", "任务完成", "提交了", "修改了", "删除了", "保存了", "已解决", "处理好了", "测试通过", "已修复", "发给了"].contains(where: { line.lowercased().contains($0) }) else { return nil }
        return line
    }
}

extension Notification.Name {
    static let petAIBubbleConsentChanged = Notification.Name("local.anime-desktop-pets.ai-bubble-consent-changed")
}
