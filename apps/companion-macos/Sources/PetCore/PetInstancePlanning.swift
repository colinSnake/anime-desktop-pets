import Foundation

/// Pure host-side admission helpers; the controller remains the final authority.
public enum PetInstancePlanning {
    public static func restorationIDs(registry: PetInstanceRegistry, rows: [PetInstanceControlRow],
                                      maximumRunning: Int, excluding: Set<String> = [],
                                      automaticOnly: Bool = true) -> [String] {
        let occupied = rows.filter { [.starting, .running, .stopping].contains($0.phase) }
        let busy = Set(occupied.map(\.id))
        let slots = max(0, maximumRunning - occupied.count)
        return Array(registry.instances.lazy.filter {
            $0.enabled && (!automaticOnly || $0.autoStartOnLaunch) && !busy.contains($0.id) && !excluding.contains($0.id)
        }.prefix(slots).map(\.id))
    }

    public static func nextCloneID(sourceID: String, used: Set<String>) -> String? {
        guard used.count < 32,
              sourceID.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil,
              sourceID.count <= 64 else { return nil }
        for number in 1...32 {
            let suffix = number == 1 ? "-copy" : "-copy-\(number)"
            var stem = String(sourceID.prefix(64 - suffix.count))
            while stem.hasSuffix("-") { stem.removeLast() }
            let candidate = stem + suffix
            if !used.contains(candidate) { return candidate }
        }
        return nil
    }
}
