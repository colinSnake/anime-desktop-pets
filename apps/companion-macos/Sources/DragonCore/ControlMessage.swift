import Foundation

public enum ControlCommand: String, Codable, CaseIterable, Sendable {
    case status, show, hide, dismiss, pause, resume, quit, speak
}
public struct ControlRequest: Codable, Sendable {
    public let command: ControlCommand
    public let text: String?
    public init(_ command: ControlCommand, text: String? = nil) {
        self.command = command; self.text = text
    }
}
public struct CompanionStatus: Codable, Sendable {
    public let ok: Bool
    public let message: String
    public let phase: String
    public let codexPID: Int32?
    public let paused: Bool
    public let petVisible: Bool
    public let backend: String
    public let posterReady: Bool
    public let petState: String
    public let petError: String?
    private enum CodingKeys: String, CodingKey {
        case ok, message, phase, codexPID, paused, petVisible, backend, posterReady, petState, petError
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(ok: try values.decode(Bool.self, forKey: .ok),
                  message: try values.decode(String.self, forKey: .message),
                  phase: try values.decode(String.self, forKey: .phase),
                  codexPID: try values.decodeIfPresent(Int32.self, forKey: .codexPID),
                  paused: try values.decode(Bool.self, forKey: .paused),
                  petVisible: try values.decode(Bool.self, forKey: .petVisible),
                  backend: try values.decode(String.self, forKey: .backend),
                  posterReady: try values.decode(Bool.self, forKey: .posterReady),
                  petState: try values.decodeIfPresent(String.self, forKey: .petState) ?? "unknown",
                  petError: try values.decodeIfPresent(String.self, forKey: .petError))
    }
    public init(ok: Bool = true, message: String, phase: String, codexPID: Int32?, paused: Bool, petVisible: Bool, backend: String, posterReady: Bool, petState: String = "idle", petError: String? = nil) {
        self.ok = ok; self.message = message; self.phase = phase; self.codexPID = codexPID
        self.paused = paused; self.petVisible = petVisible; self.backend = backend; self.posterReady = posterReady
        self.petState = petState; self.petError = petError
    }
}
