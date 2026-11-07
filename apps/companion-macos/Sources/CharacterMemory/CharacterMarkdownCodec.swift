import CharacterCore
import Foundation

enum CharacterMarkdownCodec {
    private struct Envelope<Value: Codable & Sendable>: Codable, Sendable {
        let schema: Int
        let value: Value
    }

    private struct MemoryMetadata: Codable, Sendable {
        let schema: Int
        let id: String
        let kind: CharacterMemoryKind
        let createdAt: Date
        let source: String
        let status: CharacterMemory.Status
        let shareWithOnlineModel: Bool
    }

    private struct IdentityMetadata: Codable, Sendable {
        let schema: Int
        let shareWithOnlineModel: Bool
    }

    private struct GoalMetadata: Codable, Sendable {
        let schema: Int
        let id: String
        let createdAt: Date
        let status: CharacterGoal.Status
    }

    static func encode(identity: CharacterIdentity) throws -> Data {
        let metadata = IdentityMetadata(schema: 1, shareWithOnlineModel: identity.shareWithOnlineModel)
        let frontMatter = try encodeFrontMatter(metadata)
        let markdown = """
        ---
        \(frontMatter)
        ---

        # \(identity.name)

        ## 身份定位
        \(identity.role)

        ## 背景
        \(identity.background)

        ## 性格
        \(identity.personality)

        ## 核心价值观
        \(identity.values)

        ## 当前愿望与长期方向
        \(identity.motivations)

        ## 与用户的关系
        \(identity.relationship)

        ## 表达方式
        \(identity.speakingStyle)

        ## 知识与擅长边界
        \(identity.knowledgeScope)

        ## 边界
        \(identity.boundaries)
        """
        return Data(markdown.utf8)
    }

    static func decodeIdentity(_ data: Data) throws -> CharacterIdentity {
        let markdown = try decodeUTF8(data)
        let (metadataData, body) = try split(markdown)
        let metadata = try JSONDecoder().decode(IdentityMetadata.self, from: metadataData)
        guard metadata.schema == 1,
              let heading = body.split(separator: "\n", omittingEmptySubsequences: true).first,
              heading.hasPrefix("# ") else { throw CharacterMemoryStoreError.invalidRecord }
        let name = String(heading.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 80 else { throw CharacterMemoryStoreError.invalidRecord }
        return CharacterIdentity(name: name, role: section("身份定位", in: body),
                                 background: section("背景", in: body),
                                 personality: section("性格", in: body),
                                 values: section("核心价值观", in: body),
                                 motivations: section("当前愿望与长期方向", in: body),
                                 relationship: section("与用户的关系", in: body),
                                 speakingStyle: section("表达方式", in: body),
                                 knowledgeScope: section("知识与擅长边界", in: body),
                                 boundaries: section("边界", in: body),
                                 shareWithOnlineModel: metadata.shareWithOnlineModel)
    }

    static func encode(memory: CharacterMemory) throws -> Data {
        let metadata = MemoryMetadata(schema: 1, id: memory.id, kind: memory.kind,
                                      createdAt: memory.createdAt, source: memory.source,
                                      status: memory.status, shareWithOnlineModel: memory.shareWithOnlineModel)
        let frontMatter = try encodeFrontMatter(metadata)
        return Data("---\n\(frontMatter)\n---\n\n\(memory.text)\n".utf8)
    }

    static func decodeMemory(_ data: Data, expectedID: String) throws -> CharacterMemory {
        let markdown = try decodeUTF8(data)
        let (metadataData, body) = try split(markdown)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let metadata = try decoder.decode(MemoryMetadata.self, from: metadataData)
        let text = body.trimmingCharacters(in: .newlines)
        guard metadata.schema == 1, metadata.id == expectedID,
              metadata.id.range(of: "^[A-Fa-f0-9-]{16,64}$", options: .regularExpression) != nil,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 1_000 else {
            throw CharacterMemoryStoreError.invalidRecord
        }
        return CharacterMemory(id: metadata.id, kind: metadata.kind, text: text,
                               createdAt: metadata.createdAt, source: metadata.source,
                               status: metadata.status, shareWithOnlineModel: metadata.shareWithOnlineModel)
    }

    static func encode(goal: CharacterGoal) throws -> Data {
        let metadata = GoalMetadata(schema: 1, id: goal.id, createdAt: goal.createdAt, status: goal.status)
        let frontMatter = try encodeFrontMatter(metadata)
        let steps = goal.steps.enumerated().map { index, step in
            "- [\(step.isComplete ? "x" : " ")] \(index + 1). \(step.text) <!-- \(step.id) -->"
        }.joined(separator: "\n")
        let markdown = "---\n\(frontMatter)\n---\n\n# \(goal.title)\n\n## 说明\n\(goal.details)\n\n## 步骤\n\(steps)\n"
        return Data(markdown.utf8)
    }

    static func decodeGoal(_ data: Data, expectedID: String) throws -> CharacterGoal {
        let markdown = try decodeUTF8(data)
        let (metadataData, body) = try split(markdown)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let metadata = try decoder.decode(GoalMetadata.self, from: metadataData)
        let lines = body.components(separatedBy: .newlines)
        guard metadata.schema == 1, metadata.id == expectedID,
              CharacterGoalValidation.isSafeIdentifier(metadata.id),
              let heading = lines.first(where: { $0.hasPrefix("# ") }) else {
            throw CharacterMemoryStoreError.invalidRecord
        }
        let title = String(heading.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
        let details = section("说明", in: body)
        let stepLines = section("步骤", in: body).components(separatedBy: .newlines)
        let steps = try stepLines.filter { $0.hasPrefix("- [") }.map { line -> CharacterGoal.Step in
            guard let close = line.firstIndex(of: "]"),
                  let marker = line.range(of: "<!-- "),
                  let markerEnd = line.range(of: " -->", range: marker.upperBound..<line.endIndex) else {
                throw CharacterMemoryStoreError.invalidRecord
            }
            let checked = line[line.index(line.startIndex, offsetBy: 3)] == "x"
            let textStart = line.index(close, offsetBy: 2)
            let rawText = line[textStart..<marker.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            let text = rawText.replacingOccurrences(of: "^\\d+\\. ", with: "", options: .regularExpression)
            let id = String(line[marker.upperBound..<markerEnd.lowerBound])
            return CharacterGoal.Step(id: id, text: text, isComplete: checked)
        }
        let goal = CharacterGoal(id: metadata.id, title: title, details: details, createdAt: metadata.createdAt,
                                 status: metadata.status, steps: steps)
        guard CharacterGoalValidation.validate(goal) else { throw CharacterMemoryStoreError.invalidRecord }
        return goal
    }

    private static func encodeFrontMatter<Value: Codable & Sendable>(_ value: Value) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private static func decodeUTF8(_ data: Data) throws -> String {
        guard data.count <= 64 * 1024, let value = String(data: data, encoding: .utf8) else {
            throw CharacterMemoryStoreError.invalidRecord
        }
        return value
    }

    private static func split(_ markdown: String) throws -> (Data, String) {
        let lines = markdown.components(separatedBy: .newlines)
        guard lines.first == "---",
              let end = lines.dropFirst().firstIndex(of: "---"),
              let metadata = lines[1..<end].joined(separator: "\n").data(using: .utf8) else {
            throw CharacterMemoryStoreError.invalidRecord
        }
        return (metadata, lines[(end + 1)...].joined(separator: "\n"))
    }

    private static func section(_ title: String, in body: String) -> String {
        let lines = body.components(separatedBy: .newlines)
        guard let heading = lines.firstIndex(of: "## \(title)") else { return "" }
        let content = lines.dropFirst(heading + 1).prefix { !$0.hasPrefix("## ") }
        return content.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
