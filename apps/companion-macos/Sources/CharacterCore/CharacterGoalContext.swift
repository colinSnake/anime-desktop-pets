import Foundation

public enum CharacterGoalContext {
    public static func content(_ goal: CharacterGoal) -> String {
        ([goal.title, goal.details] + goal.steps.map(\.text)).joined(separator: " ")
    }

    public static func isOverview(_ query: String) -> Bool {
        let normalized = query.filter { !$0.isWhitespace && !$0.isPunctuation }
        return ["当前目标", "当前目标是什么", "现在的目标", "现在的目标是什么", "有哪些目标", "我的目标", "我的目标有哪些",
                "我们现在推进到哪", "我们现在推进到哪一步了", "我们推进到哪", "我们推进到哪一步了",
                "目标进度", "目标进度如何", "计划进度", "计划进度如何"].contains(normalized)
    }

    public static func relevant(to query: String, goals: [CharacterGoal], onlineOnly: Bool,
                                limit: Int = 3) -> [CharacterGoal] {
        let safe = goals.filter {
            CharacterGoalValidation.validate($0) && (!onlineOnly || $0.shareWithOnlineModel)
                && !CharacterMemoryReview.isCredentialLike(content($0))
        }
        let named = safe.filter { query.localizedCaseInsensitiveContains($0.title.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if !named.isEmpty { return Array(named.prefix(max(0, limit))) }
        if isOverview(query) {
            return Array(safe.sorted {
                if $0.status != $1.status {
                    let order: [CharacterGoal.Status: Int] = [.active: 0, .paused: 1, .completed: 2]
                    return order[$0.status]! < order[$1.status]!
                }
                if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                return $0.id < $1.id
            }.prefix(max(0, limit)))
        }
        let proxies = safe.map {
            CharacterMemory(id: $0.id, kind: .fact, text: content($0), createdAt: $0.createdAt,
                            source: "目标", status: .confirmed)
        }
        let ids = CharacterMemoryRetriever.relevant(to: query, in: proxies, limit: limit).map(\.id)
        let byID = Dictionary(safe.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.compactMap { byID[$0] }
    }

    public static func summary(_ goal: CharacterGoal) -> String {
        let next: String
        if goal.status == .completed { next = "目标已由用户标记完成" }
        else if goal.status == .paused { next = "已暂停，等待用户决定是否继续" }
        else if let step = goal.steps.first(where: { !$0.isComplete }) { next = "下一步：" + String(step.text.prefix(180)) }
        else { next = goal.steps.isEmpty ? "尚未填写步骤" : "步骤已勾选完，目标状态仍由用户确认" }
        return "\(goal.title)：\(goal.status.rawValue)，已完成 \(goal.completedStepCount)/\(goal.steps.count) 步；\(next)"
    }

    public static func localAnswer(for query: String, goals: [CharacterGoal]) -> String? {
        guard isOverview(query) || (["目标", "计划"].contains(where: query.contains)
            && ["进度", "哪一步", "下一步", "推进到", "做到哪"].contains(where: query.contains)) else { return nil }
        let matches = relevant(to: query, goals: goals, onlineOnly: false)
        guard !matches.isEmpty else { return "没有找到相关的可回顾目标。可以在目标页新建或检查目标。" }
        return "本机记录的目标进度：\n" + matches.map(summary).joined(separator: "\n")
            + "\n进度以你在目标页保存的记录为准；聊天不会自动执行或修改计划。"
    }
}
