import AppKit
import CharacterCore
import SwiftUI
import UniformTypeIdentifiers

struct CharacterKnowledgeImportView: View {
    @ObservedObject var model: CharacterWorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var source = ""
    @State private var citation = ""
    @State private var version = ""
    @State private var hasExpiry = false
    @State private var expiresAt = Date.now.addingTimeInterval(30 * 86400)
    @State private var preview: [CharacterMemory] = []
    @State private var message = ""
    @State private var busy = false

    private var fingerprint: String { [text, source, citation, version, hasExpiry ? expiresAt.description : ""].joined(separator: "\0") }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("导入角色知识").font(.title2)
            Text("选择本机 .txt/.md 或粘贴文本，空行分段。最多32KiB、50段，每段1,000字符。全部进入待审核，在线分享关闭。")
                .font(.callout).foregroundStyle(.secondary)
            Button("选择文本文件…", action: chooseFile).disabled(busy)
            TextEditor(text: $text).frame(minHeight: 100)
            TextField("知识来源（必填）", text: $source)
            HStack { TextField("引用或定位", text: $citation); TextField("版本", text: $version) }
            Toggle("设置有效期", isOn: $hasExpiry)
            if hasExpiry { DatePicker("有效至", selection: $expiresAt, displayedComponents: [.date, .hourAndMinute]) }
            if !preview.isEmpty {
                Text("预览：\(preview.count) 条待审核知识").font(.headline)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(preview) { item in
                            Text(item.text).textSelection(.enabled)
                            Text([item.source, item.citation, item.version].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            Divider()
                        }
                    }
                }.frame(height: 120)
            }
            Text(message).font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("取消") { dismiss() }.disabled(busy)
                Spacer()
                Button("预览导入") {
                    do {
                        preview = try CharacterKnowledgeImport.preview(text: text, source: source, citation: citation,
                                                                       version: version, expiresAt: hasExpiry ? expiresAt : nil)
                        message = "请核对正文和来源；导入不会覆盖已有知识，相同条目将跳过。"
                    } catch { preview = []; message = error.localizedDescription }
                }.disabled(busy)
                Button("导入待审核") {
                    busy = true
                    Task {
                        let success = await model.importKnowledge(text: text, source: source, citation: citation,
                                                                  version: version, expiresAt: hasExpiry ? expiresAt : nil)
                        busy = false
                        if success { dismiss() } else { message = model.status }
                    }
                }.disabled(preview.isEmpty || busy)
            }
        }
        .padding(20).frame(width: 620, height: 650)
        .disabled(busy)
        .onChange(of: fingerprint) { _ in preview = []; message = "内容已变化，请重新预览。" }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.plainText, UTType(filenameExtension: "md") ?? .plainText]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true
        Task {
            do {
                text = try await model.loadKnowledgeImportText(from: url)
                // Only the filename is proposed as provenance; never store the private absolute path.
                source = url.lastPathComponent
                message = "已读取文本，请填写依据并预览。"
            } catch { message = error.localizedDescription }
            busy = false
        }
    }
}
