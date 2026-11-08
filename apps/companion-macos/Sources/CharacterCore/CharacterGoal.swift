import Foundation

public struct CharacterGoal: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, CaseIterable, Sendable {
        case active = "进行中"
        case paused = "已暂停"
        case completed = "已完成"
    }

    public struct Step: Codable, Equatable, Identifiable, Sendable {
        public var id: String
        public var text: String
        public var isComplete: Bool

        public init(id: String = UUID().uuidString.lowercased(), text: String, isComplete: Bool = false) {
            self.id = id
            self.text = text
            self.isComplete = isComplete
        }
    }

    public var id: String
    public var title: String
    public var details: String
    public var createdAt: Date
    public var status: Status
    public var steps: [Step]

    public init(id: String = UUID().uuidString.lowercased(), title: String, details: String = "",
                createdAt: Date = .now, status: Status = .active, steps: [Step] = []) {
        self.id = id
        self.title = title
        self.details = details
        self.createdAt = createdAt
        self.status = status
        self.steps = steps
    }

    public var completedStepCount: Int { steps.filter(\.isComplete).count }
}

public struct CharacterGoalDraft: Equatable, Sendable {
    public var title: String
    public var details: String
    public var steps: [String]

    public init(title: String, details: String = "", steps: [String] = []) {
        self.title = title
        self.details = details
        self.steps = steps
    }

    public func normalized() -> CharacterGoalDraft? {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSteps = steps.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !normalizedTitle.isEmpty, normalizedTitle.count <= 120,
              normalizedDetails.count <= 2_000, normalizedSteps.count <= 50,
              normalizedSteps.allSatisfy({ $0.count <= 500 && !$0.contains("\n") && !$0.contains("\r") }) else {
            return nil
        }
        return CharacterGoalDraft(title: normalizedTitle, details: normalizedDetails, steps: normalizedSteps)
    }
}

public enum CharacterGoalValidation {
    public static func validate(_ goal: CharacterGoal) -> Bool {
        let title = goal.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSafeIdentifier(goal.id), !title.isEmpty, title.count <= 120,
              !title.contains("\n"), !title.contains("\r"),
              goal.details.count <= 2_000, goal.steps.count <= 50 else { return false }
        guard goal.steps.allSatisfy({ step in
            isSafeIdentifier(step.id) && !step.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                step.text.count <= 500 && !step.text.contains("\n") && !step.text.contains("\r") &&
                !step.text.contains("<!--") && !step.text.contains("-->")
        }) else { return false }
        return Set(goal.steps.map(\.id)).count == goal.steps.count
    }

    public static func isSafeIdentifier(_ value: String) -> Bool {
        value.range(of: "^[A-Fa-f0-9-]{16,64}$", options: .regularExpression) != nil
    }
}
