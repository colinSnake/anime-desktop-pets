import Foundation

/// Use exactly the same bounded text for the spoken reply and the pet bubble.
enum SpeechReplyText {
    static func prepare(_ text: String, maxCharacters: Int = 160, maxBytes: Int = 512) -> String? {
        let normalized = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !normalized.isEmpty, maxCharacters > 0, maxBytes >= 3 else { return nil }
        if normalized.count <= maxCharacters && normalized.utf8.count <= maxBytes { return normalized }
        var result = ""
        var bytes = 0
        for character in normalized {
            let count = String(character).utf8.count
            guard result.count < maxCharacters - 1, bytes + count <= maxBytes - 3 else { break }
            result.append(character)
            bytes += count
        }
        return result + "…"
    }
}
