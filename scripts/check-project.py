#!/usr/bin/env python3
"""Offline project checks. Does not launch Codex, register services or make API calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ProjectChecks(unittest.TestCase):
    def test_normal_start_keeps_workspace_closed_and_status_menu_only_quits(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        coordinator = (source/'Coordinator.swift').read_text()
        startup = coordinator.split('    func start() {', 1)[1].split('    private func refreshTaskLease', 1)[0]
        preview = '        if mode == .previewCharacterWindow {\n            openWorkspace(.character)\n            return\n        }'
        self.assertIn(preview, startup)
        self.assertNotIn('openWorkspace(', startup.replace(preview, ''))
        self.assertIn('createMenu()', startup)
        self.assertIn('else if mode == .launch { launchCodex() }', startup)
        self.assertIn('statusItem?.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])', coordinator)
        self.assertIn('statusItem?.button?.action = #selector(statusItemClicked(_:))', coordinator)
        click = coordinator.split('@objc private func statusItemClicked(_ sender: NSStatusBarButton)', 1)[1].split('private func addInteractiveSpeechMenuItem', 1)[0]
        self.assertIn('guard let event = NSApp.currentEvent else {', click)
        self.assertIn('event=unavailable route=pets', click)
        self.assertIn('openWorkspace(.pets)', click)
        self.assertIn('NSMenu.popUpContextMenu(menu, with: event, for: sender)', click)
        self.assertNotIn('popUpMenu(menu)', coordinator)
        self.assertIn('openWorkspace(.pets)', coordinator)
        menu = coordinator.split('private func rebuildMenu()', 1)[1].split('@objc private func statusItemClicked(_ sender:', 1)[0]
        self.assertIn('menu.addItem(exit)', menu)
        self.assertEqual(menu.count('menu.addItem('), 1)
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        self.assertIn('func refreshPetControls()', workspace)
        self.assertIn('正在连接桌宠控制器', coordinator)
        self.assertIn('正在准备语音互动', coordinator)

    def test_workspace_toggle_rows_only_constrain_after_joining_view_hierarchy(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        page = (source/'WorkspaceActionPageController.swift').read_text()
        controls = (source/'WorkspaceControls.swift').read_text()
        self.assertIn('Toggle(row.title, isOn: Binding(', page)
        self.assertIn('set: { _ in model.perform(row.id) }', page)
        self.assertIn('.disabled(!row.enabled)', page)
        self.assertIn('struct WorkspaceToggleRow: View', controls)
        self.assertIn('set: { _ in perform() }', controls)

    def test_pet_workspace_shows_instances_by_default(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        page = (source/'WorkspacePetsPageController.swift').read_text()
        cards = (source/'WorkspacePetInstanceCard.swift').read_text()
        cover = (source/'PetCoverLoader.swift').read_text()
        self.assertIn('.pets: WorkspacePetsPageController(actions: actions)', workspace)
        self.assertNotIn('showsInstances', page)
        self.assertNotIn('桌宠操作', page)
        self.assertIn('Text("桌宠控制")', page)
        self.assertIn('Text("我的桌宠")', page)
        self.assertIn('（\\(model.instances.count)）', page)
        self.assertIn('Label("添加桌宠", systemImage: "plus")', page)
        self.assertIn('.foregroundStyle(Color(nsColor: .labelColor))', page)
        self.assertIn('（\\(model.status)）', page)
        self.assertIn('controlSize(.mini)', (source/'WorkspaceControls.swift').read_text())
        self.assertIn('.font(.system(size: 12)).foregroundStyle(.secondary)', page)
        self.assertIn('CGImageSourceCreateThumbnailAtIndex(source, 0', cover)
        self.assertIn('preparedCoverURL(for: source)', cover)
        self.assertIn('workspace-cover.png', cover)
        self.assertIn('Image(decorative: cover', cards)
        self.assertIn('model.actions.toggleInstance(instance.id)', page)
        self.assertIn('model.actions.cloneInstance(instance.id)', page)

    def test_pet_manager_is_compact_and_presented_as_workspace_sheet(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        manager = (source/'PetManagerWindow.swift').read_text()
        coordinator = (source/'Coordinator.swift').read_text()
        self.assertIn('width: 700, height: 420', manager)
        self.assertIn('func open(parentWindow: NSWindow? = nil)', manager)
        self.assertIn('parentWindow.beginSheet(window)', manager)
        self.assertIn('NSHostingController(rootView: PetManagerPage(model: self))', manager)
        self.assertIn('private struct PetManagerPage: View', manager)
        self.assertIn('WorkspaceSearchField(prompt: "搜索名称、版本或路径", text: $model.query)', manager)
        self.assertIn('ForEach(model.filteredSources, id: \\.path)', manager)
        self.assertNotIn('Button(action: model.selectAllVisible)', manager)
        self.assertIn('.disabled(!model.canAdd)', manager)
        self.assertIn('一次最多添加16只', manager)
        self.assertNotIn('func selectAllVisible()', manager)
        self.assertIn('func rescan()', manager)
        self.assertIn('private func setBusy(_ value: Bool, message: String)', manager)
        self.assertIn('if model.busy && model.sources.isEmpty', manager)
        self.assertIn('ProgressView()', manager)
        self.assertIn('Text(model.status)', manager)
        self.assertIn('self.status = error.localizedDescription', manager)
        self.assertIn('model.filteredSources.isEmpty && !model.busy', manager)
        self.assertIn('selectedCount > 16', manager)
        self.assertIn('PetManagerSourceCard(source:', manager)
        self.assertIn('NSWorkspace.shared.open(url)', manager)
        self.assertIn('NSWorkspace.shared.activateFileViewerSelecting([url])', manager)
        self.assertIn('var filteredSources: [LocalPetSource]', manager)
        self.assertIn('$0.name.localizedCaseInsensitiveContains(value)', manager)
        self.assertIn('$0.version.localizedCaseInsensitiveContains(value)', manager)
        self.assertIn('$0.path.localizedCaseInsensitiveContains(value)', manager)
        self.assertIn('@Published private(set) var selectedPaths = Set<String>()', manager)
        self.assertIn('selectedPaths.removeAll()', manager)
        self.assertIn('selectedPaths.formUnion(range.map { visible[$0] })', manager)
        self.assertIn('sources.filter { selectedPaths.contains($0.path) }', manager)
        self.assertIn('guard canAdd else { return }', manager)
        self.assertIn('var canAdd: Bool { !busy && (1...16).contains(selectedCount) }', manager)
        self.assertIn('func dismissManager()', manager)
        self.assertIn('windowShouldClose(_ sender: NSWindow) -> Bool { true }', manager)
        self.assertIn('windowWillClose(_ notification: Notification)', manager)
        self.assertIn('private var outsideClickMonitor: Any?', manager)
        self.assertIn('parent.endSheet(window, returnCode: .cancel)', manager)
        row = (source/'PetManagerSourceCard.swift').read_text()
        self.assertIn('struct PetManagerSourceCard: View', row)
        self.assertIn('Button(action: select)', row)
        self.assertIn('.accessibilityAddTraits(selected ? .isSelected : [])', row)
        self.assertIn('.disabled(busy)', row)
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        self.assertIn('open(parentWindow: companionWorkspaceWindow?.window)', coordinator)


    def test_pet_candidate_cards_prepare_covers_without_blocking_scan_or_import(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        manager = (source/'PetManagerWindow.swift').read_text()
        card = (source/'PetManagerSourceCard.swift').read_text()
        archive = (source/'PetCoverArchive.swift').read_text()
        self.assertIn('LazyVGrid(columns:', manager)
        self.assertIn('.adaptive(minimum: PetManagerSourceCard.width, maximum: PetManagerSourceCard.width)', manager)
        self.assertIn('static let width: CGFloat = 160', card)
        self.assertIn('.frame(width: Self.width)', card)
        self.assertIn('.strokeBorder(selected ?', card)
        self.assertIn('.padding(2)', manager)
        self.assertIn('self.prepareCovers(self.sources)', manager)
        self.assertIn('self.scanID == generation', manager)
        self.assertIn('coverTask?.cancel()', manager)
        self.assertIn('PetCoverLoader.shared.image(for: $0, refresh: true)', manager)
        self.assertIn('case .loading:', card)
        self.assertIn('case .ready(let image):', card)
        self.assertIn('case .unavailable:', card)
        self.assertIn('Image(decorative: image', card)
        self.assertIn('HStack(alignment: .top, spacing: 6)', card)
        self.assertIn('.frame(maxWidth: .infinity, alignment: .center)', card)
        self.assertEqual(card.count('Button(action:'), 2, 'Cover selects; only folder action belongs in footer')
        self.assertIn('process.arguments = ["-p", "-P", "", archive.path, member]', archive)
        self.assertIn('result.count <= limit', archive)
        self.assertIn('CGImageSourceCreateThumbnailAtIndex(source, 0', archive)

    def test_pet_manager_uses_compact_text_only_actions(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        page = (source/'PetManagerWindow.swift').read_text().split('private struct PetManagerPage: View', 1)[1]
        style = (source/'WorkspaceCard.swift').read_text()
        heading = (source/'WorkspaceControls.swift').read_text()
        self.assertIn('WorkspacePageHeading(title: "添加桌宠", subtitle: "")', page)
        self.assertIn('if !subtitle.isEmpty', heading)
        self.assertNotIn('选择本地桌宠素材', page)
        self.assertNotIn('{ Label(', page)
        for title in ['选择素材目录', '刷新', '添加']:
            self.assertIn(f'Text("{title}")', page)
        self.assertNotIn('添加到我的桌宠', page)
        self.assertNotIn('Text("全选")', page)
        self.assertIn('WorkspaceActionButtonStyle(prominent: true, compact: true)', page)
        self.assertIn('.buttonStyle(WorkspaceActionButtonStyle(compact: true))', page)
        self.assertIn('var compact = false', style)
        self.assertIn('static let compactHeight: CGFloat = 26', style)
        self.assertIn('.frame(height: compact ? WorkspaceControlStyle.compactHeight : WorkspaceControlStyle.regularHeight)', style)
        self.assertIn('WorkspaceSearchField(prompt: "搜索名称、版本或路径", text: $model.query)', page)
        self.assertNotIn('.textFieldStyle(.roundedBorder)', page)
        field = (source/'WorkspaceSearchField.swift').read_text()
        self.assertIn('.frame(height: WorkspaceControlStyle.compactHeight)', field)
        self.assertIn('WorkspaceControlStyle.borderColor(for: colorScheme)', field)
        self.assertIn('WorkspaceControlStyle.borderColor(for: colorScheme)', style)
        self.assertIn('.focused($focused)', field)
        pets = (source/'WorkspacePetsPageController.swift').read_text()
        self.assertIn('.buttonStyle(WorkspaceActionButtonStyle(compact: true)).disabled(!model.canAdd)', pets)

    def test_startup_cover_keeps_painting_and_avoids_letterboxing(self):
        host = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        player = (host/'BootPlayer.swift').read_text()
        coordinator = (host/'Coordinator.swift').read_text()
        self.assertIn('preservesTargetActivation ? .resizeAspectFill : .resizeAspect', player)
        self.assertNotIn('hold-final-frame', player, 'normal launch should hand off when the startup video ends')
        self.assertNotIn('player.pause()', player, 'startup playback must not wait for the Codex window readiness signal')
        self.assertIn('let opacity = preservesTargetActivation ? 1 : config.opacity(at: t)', player)
        self.assertEqual(player.count('StartupPresentation.opacity('), 2, 'initial display and every fade tick must cap opacity')
        self.assertNotIn('followsTargetWindow', player, 'keep following actual frame changes until handoff')
        self.assertIn('options.arguments = runtime.startupLaunchArguments(at: url)', coordinator)
        self.assertIn('StartupWindowSizing.request(', coordinator)
        self.assertIn('content-readiness=unknown', coordinator)
        sizing = (host/'StartupWindowSizing.swift').read_text()
        self.assertNotIn('AXIsProcessTrustedWithOptions', sizing, 'never auto-prompt for Accessibility')
        self.assertNotIn('kAXTitleAttribute', sizing, 'window sizing must not inspect UI text')

    def test_config_safe_defaults(self):
        config = json.loads((ROOT/'config/companion.example.json').read_text())
        self.assertFalse(config['themeEnabled'])
        self.assertEqual(config['petBackend'], 'native')
        self.assertLess(config['holdAt'], config['transitionStart'])
        self.assertLess(config['transitionStart'], config['transitionEnd'])

    def test_provider_is_disabled_and_preserves_requested_model(self):
        config = json.loads((ROOT/'config/image-provider.example.json').read_text())
        self.assertFalse(config['enabled'])
        self.assertEqual(config['model'], 'gpt-image-2.5')
        self.assertEqual(config['baseUrl'], '')
        self.assertNotIn('apiKey', config)

    def test_monorepo_application_boundaries(self):
        host = ROOT / 'apps/companion-macos'
        runtime = ROOT / 'apps/pet-runtime'
        for path in (host/'Package.swift', host/'Sources/DragonCore',
                     host/'Sources/DragonCompanion', host/'Tests/DragonCoreTests',
                     runtime/'bailong/dragon_frames.py', runtime/'pets/dragon_pet_helper.py',
                     runtime/'pets/pet_library.py', ROOT/'integrations/bailong/upstream-files.json'):
            self.assertTrue(path.exists(), str(path))
        for old in ('Package.swift', 'Sources', 'Tests', 'integrations/pets'):
            self.assertFalse((ROOT/old).exists(), '旧源码入口不得复活：' + old)
        self.assertFalse(list((ROOT/'integrations').rglob('*.py')), '业务 Python 源码应位于 apps/')

    def test_app_icon_is_required_by_packaging(self):
        branding = ROOT/'resources/branding'
        for name in ('app-icon.svg', 'app-icon.png', 'AppIcon.icns'):
            self.assertTrue((branding/name).is_file(), name)
        script = (ROOT/'scripts/build.sh').read_text()
        self.assertIn('CFBundleIconFile', script)
        self.assertIn('resources/branding/AppIcon.icns', script)
        self.assertNotIn('LSUIElement', script, 'the host must appear as a regular Dock application')

    def test_friendly_copy_keeps_persistent_identity(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        copy = (source/'AppCopy.swift').read_text()
        self.assertIn('static let name = "桌边小崽"', copy)
        self.assertIn('让喜欢的角色，陪在桌边。', copy)
        self.assertNotIn('伴侣', copy)
        coordinator = (source/'Coordinator.swift').read_text()
        for key in ('AppCopy.name', 'AppCopy.tagline', 'AppCopy.runningMessage', 'AppCopy.quitTitle'):
            self.assertIn(key, coordinator)
        for path in source.glob('*.swift'):
            self.assertNotIn('伴侣', path.read_text())
        self.assertIn('AnimeDesktopPets', (source/'Runtime.swift').read_text())
        self.assertIn('DragonCodexCompanion', (source/'Runtime.swift').read_text())
        build = (ROOT/'scripts/build.sh').read_text()
        self.assertIn("CFBundleIdentifier='local.dragon.codex-companion'", build)
        self.assertIn('build/桌边小崽.app', build)
        self.assertIn("CFBundleName='桌边小崽', CFBundleDisplayName='桌边小崽'", build)
        self.assertIn("CFBundleShortVersionString='0.7.11', CFBundleVersion='31'", build)
        self.assertIn('scripts/publish-app-bundle.py', build)

    def test_external_catalog_validation_never_blocks_appkit_main_actor(self):
        controller = (ROOT/'apps/companion-macos/Sources/DragonCompanion/PetController.swift').read_text()
        self.assertIn('Task.detached(priority: .utility)', controller)
        self.assertIn('descriptorLoadTask == nil', controller)
        self.assertIn('guard self.desiredVisible else { return }', controller)
        self.assertIn('private func launchExternal(_ descriptor: ExternalPetDescriptor)', controller)

    def test_pet_menu_uses_truthful_lifecycle_actions(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        coordinator = (source/'Coordinator.swift').read_text()
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        pet_controller = (source/'PetController.swift').read_text()
        runtime = (source/'PetInstanceRuntime.swift').read_text()
        controller = (source/'PetController.swift').read_text()
        self.assertIn('togglePetAvailability', coordinator)
        self.assertIn('"停止全部桌宠"', coordinator)
        self.assertIn('"启动全部桌宠"', coordinator)
        self.assertIn('"停止实例"', coordinator)
        self.assertIn('"启动实例"', coordinator)
        self.assertIn('启动或控制失败：', coordinator)
        self.assertIn('控制器异常：', coordinator)
        self.assertIn('func startEnabledInstances()', runtime)
        self.assertIn('func stopAllInstances()', runtime)
        self.assertIn('WindowGeometry.hasVisibleWindow(pid: $0.processIdentifier)', controller)
        self.assertNotIn('expectedSize: $0.bundleIdentifier', controller)
        self.assertNotIn('"全部显示"', coordinator)
        self.assertNotIn('"隐藏 \\(title)"', coordinator)
        self.assertNotIn('"结束本次桌宠"', pet_controller)
        self.assertIn('"窗口尺寸辅助功能权限"', workspace)
        self.assertIn('openAccessibility: { [weak self] in self?.openWindowPermissionSettings() }', coordinator)
        self.assertNotIn('允许同步 Codex 窗口尺寸', coordinator)

    def test_workspace_theme_and_navigation_use_consistent_controls(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        shell = (source/'WorkspaceShellView.swift').read_text()
        navigation = (source/'WorkspaceNavigation.swift').read_text()
        self.assertIn('case system\n        case dark\n        case light', workspace)
        self.assertIn('workspaceTheme', shell)
        self.assertIn('circle.lefthalf.striped.horizontal', workspace)
        self.assertIn('moon.fill', workspace)
        self.assertIn('sun.max.fill', workspace)
        self.assertIn('window.titleVisibility = .hidden', workspace)
        self.assertIn('WorkspaceShellView(model: shellModel', workspace)
        self.assertIn('private var toolbar: some View', shell)
        self.assertIn('private var sidebar: some View', shell)
        self.assertIn('private var detail: some View', shell)
        self.assertIn('.preferredColorScheme(model.theme.preferredColorScheme)', shell)
        self.assertIn('func cycleTheme()', shell)
        self.assertIn('UserDefaults.standard.set(next.rawValue, forKey: "workspaceTheme")', shell)
        self.assertIn('struct WorkspaceNavigationButton: View', navigation)
        self.assertIn('.accessibilityAddTraits(selected ? .isSelected : [])', navigation)
        self.assertIn('LinearGradient(colors:', navigation)
        controls = (source/'WorkspaceControls.swift').read_text()
        self.assertIn('.labelsHidden().toggleStyle(.switch).controlSize(.mini).tint(Color(nsColor: WorkspacePalette.accent))', controls)
        self.assertIn('enum WorkspacePalette', controls)
        self.assertIn('struct WorkspacePageHeading: View', controls)
        self.assertIn('struct WorkspaceSectionCard<Content: View>: View', controls)
        pets_page = (source/'WorkspacePetsPageController.swift').read_text()
        self.assertIn('Text("桌宠控制")', pets_page)
        self.assertIn('Text("我的桌宠")', pets_page)
        pet_card = (source/'WorkspacePetInstanceCard.swift').read_text()
        self.assertIn('struct WorkspacePetInstanceCard: View', pet_card)
        self.assertIn('Text(instance.name)', pet_card)
        self.assertIn('Label("创建分身"', pet_card)
        self.assertIn('if instance.isClone', pet_card)
        self.assertIn('Label("删除实例"', pet_card)
        self.assertIn('.disabled(!instance.canDelete)', pet_card)
        self.assertIn('confirmDeleteManagedPet(instanceID: id)', (source/'Coordinator.swift').read_text())

    def test_workspace_canvas_and_cards_use_shared_theme_surfaces(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        character = ROOT/'apps/companion-macos/Sources/CharacterUI'
        palette = (character/'ManagementSurfacePalette.swift').read_text()
        self.assertIn('public static let canvas = surface("ManagementCanvas", light: .white', palette)
        self.assertIn('appearance.bestMatch(from: [.darkAqua, .aqua])', palette)
        for name in ['card', 'input', 'border']:
            self.assertIn(f'public static let {name} = surface(', palette)
        shell = (source/'WorkspaceShellView.swift').read_text()
        self.assertEqual(shell.count('Color(nsColor: WorkspacePalette.canvas)'), 3)
        self.assertNotIn('Color(nsColor: .windowBackgroundColor)', shell)
        self.assertIn('window.backgroundColor = WorkspacePalette.canvas', (source/'CompanionWorkspaceWindow.swift').read_text())
        for file in ['WorkspacePetsPageController.swift', 'ModelManagerWindow.swift',
                     'SpeechSettingsWindow.swift', 'WorkspaceActionPageController.swift']:
            self.assertIn('.background(Color(nsColor: WorkspacePalette.canvas))', (source/file).read_text(), file)
        self.assertIn('.background(CharacterUIStyle.canvas)', (character/'CharacterWorkspaceView.swift').read_text())
        card = (source/'WorkspacePetInstanceCard.swift').read_text()
        self.assertIn('Color(nsColor: WorkspacePalette.card)', card)
        self.assertIn('.background(Color(nsColor: WorkspacePalette.canvas))', card)
        self.assertIn('.strokeBorder(Color(nsColor: WorkspacePalette.border)', card)
        self.assertIn('Color(nsColor: WorkspacePalette.input)', card)

    def test_workspace_sidebar_groups_are_fixed_and_live_tabs_are_distinct(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        shell = (source/'WorkspaceShellView.swift').read_text()
        sections = (source/'WorkspaceSection.swift').read_text()
        speech = (source/'SpeechSettingsWindow.swift').read_text()
        self.assertIn('("梦境区", [.pets, .characterChat, .character, .characterMemories, .characterCapabilities])', shell)
        self.assertIn('("工作区", [.models, .speech, .live])', shell)
        self.assertIn('("系统区", [.advanced])', shell)
        self.assertIn('.frame(width: 200)', shell)
        self.assertNotIn('characterGoals', workspace)
        self.assertIn('case speech = "语音互动"', sections)
        self.assertIn('case live = "直播管理"', sections)
        self.assertIn('case advanced = "高级"', sections)
        self.assertIn('speechController.selectPage(.voice)', workspace)
        self.assertIn('speechController.selectPage(.live)', workspace)
        self.assertIn('private struct SpeechSettingsPage: View', speech)
        self.assertIn('private var voicePage: some View', speech)
        self.assertIn('private var livePage: some View', speech)
        self.assertNotIn('WorkspacePageHeading(', speech)
        self.assertIn('直播平台尚未接入', speech)
        self.assertIn('WorkspaceSectionCard(title:', speech)
        self.assertIn('Button("选择参考音频…", action: model.chooseReferenceAudio)', speech)
        model = (source/'ModelManagerWindow.swift').read_text()
        self.assertIn('struct ModelManagerPage: View', model)
        self.assertNotIn('WorkspacePageHeading(', model)
        self.assertIn('WorkspaceSectionCard(title: "凭证与费用")', model)
        self.assertIn('语音识别在本机完成；仅生成回复时', model)
        character = (source/'CharacterWindow.swift').read_text()
        self.assertIn('NSHostingController<CharacterWorkspaceView>', character)
        character_views = '\n'.join(path.read_text() for path in (ROOT/'apps/companion-macos/Sources/CharacterUI').glob('*.swift') if path.name.endswith('View.swift'))
        self.assertIn('CharacterChatView(model: model)', character_views)
        self.assertIn('CharacterIdentityView(model: model)', character_views)
        self.assertIn('CharacterMemoryView(model: model)', character_views)
        self.assertIn('CharacterCapabilitiesView(capabilities: capabilities)', character_views)
        identity = (ROOT/'apps/companion-macos/Sources/CharacterUI/CharacterIdentityView.swift').read_text()
        self.assertIn('.padding(.horizontal, 20)', identity)
        self.assertIn('.padding(.vertical, 12)', identity)

    def test_model_key_status_does_not_read_secret_or_prompt_on_page_open(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        model = (source/'ModelManagerWindow.swift').read_text()
        provider = (source/'ModelProvider.swift').read_text()
        self.assertIn('hasSavedKey = keyStore.hasValue()', model)
        apply = model.split('private func apply(', 1)[1].split('func providerChanged', 1)[0]
        self.assertNotIn('keyStore.read()', apply)
        self.assertIn('SecureField(', model)
        self.assertIn('NSHostingController(rootView: ModelManagerPage(model: self))', model)
        self.assertNotIn('NSStackView(', model)
        self.assertNotIn('NSTextField(', model)
        self.assertNotIn('NSButton(', model)
        self.assertIn('context.interactionNotAllowed = true', provider)
        self.assertIn('status == errSecSuccess || status == errSecInteractionNotAllowed', provider)

    def test_model_settings_keeps_system_effects_out_of_swiftui_view(self):
        model = (ROOT/'apps/companion-macos/Sources/DragonCompanion/ModelManagerWindow.swift').read_text()
        controller, page = model.split('private struct ModelManagerPage: View', 1)
        self.assertIn('final class ModelManagerWindow: NSViewController, ObservableObject', controller)
        self.assertIn('try store.save(next)', controller)
        self.assertIn('try keyStore.save(key)', controller)
        self.assertIn('keyStore.delete()', controller)
        self.assertIn('ModelProviderClient().complete(', controller)
        self.assertNotIn('ModelProviderStore(', page)
        self.assertNotIn('ModelAPIKeyStore(', page)
        self.assertNotIn('ModelProviderClient(', page)

    def test_workspace_retains_native_window_host_and_swiftui_feature_pages(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        workspace = (source/'CompanionWorkspaceWindow.swift').read_text()
        self.assertIn('final class CompanionWorkspaceWindow: NSWindowController', workspace)
        self.assertIn('window.titleVisibility = .hidden', workspace)
        self.assertIn('window.delegate = self', workspace)
        self.assertIn('.pets: WorkspacePetsPageController(actions: actions)', workspace)
        character = (source/'CharacterWindow.swift').read_text()
        self.assertIn('NSHostingController<CharacterWorkspaceView>', character)
        self.assertIn('applyCompactOverlayScrollbars(in: hostingController.view)', character)

    def test_management_pages_do_not_construct_appkit_layout_controls(self):
        source = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        page_files = (
            'WorkspaceShellView.swift', 'WorkspaceNavigation.swift', 'WorkspaceControls.swift',
            'WorkspacePetsPageController.swift', 'WorkspacePetInstanceCard.swift',
            'PetManagerWindow.swift', 'PetManagerSourceCard.swift', 'ModelManagerWindow.swift',
            'SpeechSettingsWindow.swift', 'WorkspaceActionPageController.swift',
        )
        forbidden = ('NSStackView(', 'NSTableView(', 'NSButton(', 'NSTextField(',
                     'NSBox(', 'NSVisualEffectView(')
        for name in page_files:
            content = (source/name).read_text()
            for constructor in forbidden:
                self.assertNotIn(constructor, content, f'{name} must keep page controls in SwiftUI')
        shell = (source/'WorkspaceShellView.swift').read_text()
        self.assertIn('NSViewControllerRepresentable', shell, 'the native bridge only hosts existing controllers')
        self.assertIn('NSHostingController(rootView: PetManagerPage(model: self))',
                      (source/'PetManagerWindow.swift').read_text())

    def test_data_folder_menu_matches_opened_directory(self):
        coordinator = (ROOT/'apps/companion-macos/Sources/DragonCompanion/Coordinator.swift').read_text()
        workspace = (ROOT/'apps/companion-macos/Sources/DragonCompanion/CompanionWorkspaceWindow.swift').read_text()
        self.assertIn('.init("打开数据文件夹", symbol: "folder", run: actions.openData)', workspace)
        self.assertIn('openData: { [weak self] in self?.openSettings() }', coordinator)
        self.assertIn('private func openSettings() { NSWorkspace.shared.open(runtime.state) }', coordinator)
        self.assertNotIn('打开配置文件夹', coordinator)

    def test_pet_manager_is_nested_and_uses_existing_helper(self):
        host = ROOT/'apps/companion-macos/Sources/DragonCompanion'
        coordinator = (host/'Coordinator.swift').read_text()
        rebuild = coordinator.split('private func rebuildMenu()', 1)[1].split('func menuNeedsUpdate', 1)[0]
        management = coordinator.split('private func petManagementMenu()', 1)[1].split('@objc private func showPet', 1)[0]
        self.assertNotIn('NSMenuItem(title: "桌宠管理…"', rebuild)
        self.assertIn('NSMenuItem(title: "桌宠管理…"', management)
        self.assertIn('self.addLocalPets(packages, completion: completion)', coordinator)
        window = (host/'PetManagerWindow.swift').read_text()
        self.assertNotIn('Button(action: model.selectAllVisible)', window)
        self.assertIn('model.selectSource(source.path)', window)
        self.assertIn('func addSelected()', window)
        self.assertIn('一次最多添加16只', window)
        self.assertIn('accessibilityLabel("关闭添加桌宠")', window)
        self.assertIn('func dismissManager()', window)
        self.assertIn('installOutsideClickMonitor()', window)
        self.assertIn('NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown])', window)
        self.assertIn('!sheet.frame.contains(point)', window)
        self.assertIn('event.window?.convertPoint(toScreen: event.locationInWindow)', window)
        self.assertIn('self.dismissManager()', window)
        self.assertIn('parent.endSheet(window, returnCode: .cancel)', window)
        self.assertIn('NSEvent.removeMonitor(outsideClickMonitor)', window)
        close_gate = window.split('func windowShouldClose(_ sender: NSWindow) -> Bool', 1)[1].split('func windowWillClose', 1)[0]
        self.assertIn('true', close_gate)
        self.assertNotIn('!busy', close_gate)
        self.assertIn('NSHostingController(rootView: PetManagerPage(model: self))', window)
        self.assertIn('Button(action: model.chooseRoots)', window)
        self.assertIn('Button(action: model.rescan)', window)
        self.assertNotIn('NSTableView', window)
        self.assertNotIn('NSStackView', window)
        row = (host/'PetManagerSourceCard.swift').read_text()
        self.assertIn('struct PetManagerSourceCard: View', row)
        self.assertIn('source.builtin ? "内置桌宠" : "v\\(source.version)"', row)
        self.assertNotIn('Image(systemName:', row)
        self.assertNotRegex(row, r'\bLabel\(')
        self.assertIn('Text("查看目录")', row)
        self.assertIn('.buttonStyle(WorkspaceActionButtonStyle(compact: true))', row)
        self.assertIn('Button(action: reveal)', row)
        self.assertNotIn('NSButton', row)
        card = (host/'WorkspacePetInstanceCard.swift').read_text()
        self.assertIn('struct WorkspacePetInstanceCard: View', card)
        builder = (ROOT/'scripts/build-pet-runtime.py').read_text()
        self.assertIn("'pet_sources.py'", builder)
        self.assertIn("from pet_sources import main as sources_main", builder)
        self.assertIn("'pet_sources'", builder)
        fingerprints = (ROOT/'scripts/pet-build-inputs.py').read_text()
        self.assertIn("'pet_sources.py'", fingerprints)
        tests = (ROOT/'scripts/test.sh').read_text()
        self.assertIn('scripts/test-pet-sources.py', tests)

    def test_old_app_name_is_removed_from_text_references(self):
        old_name = '桌边' + '小伙伴'
        for directory, folders, names in os.walk(ROOT):
            folders[:] = [name for name in folders if name not in {'.git', '.build', '.local', 'build'}]
            for name in names:
                path = Path(directory) / name
                if path.suffix in {'.md', '.swift', '.py', '.sh'}:
                    self.assertNotIn(old_name, path.read_text(errors='replace'), str(path))

    def test_sources_have_no_hardcoded_user_paths(self):
        sources = list((ROOT/'apps/companion-macos/Sources').rglob('*.swift'))
        self.assertTrue(sources, '未找到 Swift 源码，不能将空扫描计为通过')
        for file in sources:
            self.assertNotIn('/Users/ming/', file.read_text(), str(file))

    def test_local_media_hashes(self):
        manifest = ROOT/'resources/assets.local.json'
        if not manifest.exists(): self.skipTest('Import private media first')
        for asset in json.loads(manifest.read_text())['assets']:
            data = (ROOT/'resources'/asset['file']).read_bytes()
            self.assertEqual(len(data), asset['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), asset['sha256'])

    def test_shell_syntax(self):
        for script in (ROOT/'scripts').glob('*.sh'):
            subprocess.run(['/bin/bash','-n',str(script)],check=True)

    def test_license_scope_is_explicit(self):
        self.assertTrue((ROOT/'LICENSE').exists())
        self.assertIn('media', (ROOT/'THIRD_PARTY_NOTICES.md').read_text().lower())

    def test_poster_is_not_fake_generated(self):
        self.assertTrue((ROOT/'resources/poster/README.md').exists())
        brief = json.loads((ROOT/'theme/brief.json').read_text())
        self.assertEqual(brief['background']['source'], 'generated')
        self.assertEqual(brief['decorations']['density'], 'none')

if __name__ == '__main__': unittest.main(verbosity=2)
