# Anime Desktop Pets

[English](README.md) | [简体中文](README.zh.md)

An anime-style desktop-pet project for macOS. The current character is Longmei (龙妹) for Codex;
Claude, DeepSeek and Grok characters are planned, not yet integrated. The app runs alongside Codex
without modifying its application bundle or `app.asar`. It is an independent project, not an
official OpenAI product or plugin.

The app's Chinese UI name is **桌边小崽** (“Desk-side Cub”), with the line **让喜欢的角色，陪在桌边。**
The project name is Anime Desktop Pets. The built application is **`桌边小崽.app`**, including its macOS
display name. The bundle identifier, internal executable, configuration and data paths remain unchanged.

## Current Status

This is a local development prototype with **35 character animations** and multi-pet management.
Pet management is built into the host under **实例管理 → 桌宠管理…**. It discovers local pet directories and `.petpack` files, supports multiple selection, and registers new pets stopped. The standalone asset-library app has been removed; package tooling remains available for development. A separate helper provides the full pet experience; the native PNG backend
is a limited fallback. The enhanced helper can follow local Codex task lifecycle events and play work animations;
real desktop task following still awaits manual acceptance.
Real desktop behavior, focus, multi-display and long-duration resource use still need
manual acceptance. See the [roadmap](docs/roadmap.md) and [verification record](docs/实际验证记录.md).
The character workspace stores per-pet Markdown locally; the repository includes Chinese Longmei identity, pending-memory and draft-goal examples. Shutdown has bounded cleanup and an owner-PID guard for orphan helpers, while real menu-exit acceptance on the rebuilt app is still pending.
The startup animation is locally upscaled to 4K; its source backup and processing report remain private.
The repeatable workflow and its roughly 0.9 GiB model-process peak-memory measurement are documented in
the [4K upscaling guide](docs/开机动画4K超分.md). A standalone upscaler app is not implemented.

## Requirements

- Apple Silicon Mac running macOS 13 or newer; the current build is validated on local arm64 only.
- Xcode Command Line Tools with Swift 5.9 or newer, plus Python 3 for build and test scripts.
- A Codex desktop installation for Codex-specific coordination.
- Local media you are authorized to use. Fresh checkouts must prepare the private pet assets first.

## Build and Check

Run from the repository root. Follow the [local setup guide](docs/本地开发与使用指南.md) for media
import and the [build guide](docs/桌宠增强与性能构建.md) for the pinned upstream app, local Python
environment and animation assets before building.

```bash
python3 scripts/prepare-full-pet.py fetch
python3 scripts/build-pet-runtime.py build --source-revision 8e5466d9a438deb6cb43f460e7f5a9bdb9d7a578 --local-test-font .local/pet-build/local-fonts/上首软糖体.ttf
./scripts/build.sh
./scripts/test.sh
./scripts/petctl.sh --check
```

Enhanced local builds require the SSRuanTangTi helper asset and its pinned SHA-256. This font is authorized for this local test build only; do not commit or redistribute it. A missing font blocks publication before the existing usable app is replaced.

The default helper references local animation files and is not a portable release. Build and test
commands do not launch the pet or restart Codex. `--check` validates local configuration and assets;
it is not real desktop acceptance.

The host appears in the Dock and uses a dedicated transparent window-and-star mark in the menu bar.

To deliberately preview the full pet, run `./scripts/preview-full-pet.sh`. It may quit an existing
pet instance before switching modes. Do not run it when you need to preserve a currently active
instance. For Codex launch/watch modes and local configuration, see the
[local usage guide](docs/本地开发与使用指南.md).

## Features and Boundaries

- The 4K startup video and Codex launch run together. New client windows are sized to the 16:9 video when Accessibility is granted; the host retries a late AX window and performs a final size pass when the animation ends. Without Accessibility, the video fills the actual client frame (edge cropping, no letterboxing), but that fallback does not resize Codex. A nearly opaque nonactivating cover and a Chromium occlusion switch keep rendering progressing. When the startup video ends, the cover is released and Codex's own loading UI is allowed to continue; Codex exposes no content-readiness API. Existing processes are neither resized nor replayed.
- Local speech input settings can select an available microphone and run a four-second input-level check using an AVFoundation capture session bound to that device. Capture uses explicit 48 kHz Float32 mono buffers on a dedicated queue; diagnostics distinguish system sample callbacks from PCM conversion and file writing without recording audio or device identifiers. See the [local speech design](docs/直播语音桌宠方案.md).
- **实例管理 → 桌宠管理…** discovers local manifest directories and `.petpack` files, supports multi-select, and registers new pets stopped; no standalone asset-library app is required.
- Instance labels show **龙妹 · 运行中** without an auto-restore suffix. Existing IDs and auto-restore preferences stay compatible.
- Full animated Longmei pet and multi-instance management. The status menu manages lifecycle; per-pet menus handle interaction and animation previews. See the [menu contract](docs/菜单功能与交互边界.md).
- The status-menu **互动气泡语音** toggle controls local TTS for visible pet bubbles. While a menu or dialog is open, only the latest bubble is retained and spoken after the interaction ends. Once the cue is sent, the bubble stays visible for a bounded text-length estimate of the TTS duration (3–30 seconds) rather than a single fixed timeout; the current one-way cue channel does not yet provide an exact playback-complete callback. Deliberate generated voice replies remain a separate proactive behavior and are not controlled by this toggle. Toggling the preference does not make a network request.
- The standalone `apps/live-runtime/` module currently provides offline JSONL live-message normalization, deduplication, rate limiting, a bounded queue, and an opt-in `--announce` speech handoff with cooldown/latest-wins limits. It is not connected to Bilibili or Douyin, does not read credentials, open an audio device, or send chat messages; platform adapters will remain separate from the pet helper and speech runtime.
- In the current local test build, pet message bubbles use the bundled SSRuanTangTi (Shangshou Soft Candy) font and center copy horizontally and vertically; the font is authorized for this local test build only and must not be redistributed. Quota cards use a custom refresh control and constrain long provider labels.
- When Longmei is visibly idle, she occasionally shows a short authored greeting above herself. Greetings pause during work, dragging, menus, or nearby pointer interaction. Recent user interaction lengthens the autonomous-action interval, favors calmer idle clips, and postpones the next greeting; quiet periods retain shuffled interaction/idle rotation. The behavior respects the autonomous-activity and Reduce Motion settings.
- User data lives under `~/Library/Application Support/AnimeDesktopPets/`, separate from built-in animation resources (though imported pet packages are stored there). The first new-version run migrates the legacy `DragonCodexCompanion` folder and leaves a compatibility symlink; ambiguous dual folders are never merged automatically.
- Full 35-action evaluation leaves production assets unchanged: actual Qt premultiplied-pixel checks reject pre-scaled WebP replacement. Raw premultiplied-frame compression is exact at 256/512px, but both full payloads would total about 1.87 GiB; only bounded, on-demand caching remains under evaluation, with no desktop CPU/RSS improvement claim. Read-only tooling and scope are in the [performance notes](docs/桌宠增强与性能构建.md) and [verification record](docs/实际验证记录.md).
- The enhanced Longmei can create its first same-package clone from the host status menu without a pre-existing registry. The confirmed handoff moves the host-owned pet from its single-pet controller to one multi-pet helper; a new clone starts stopped and is not auto-restored until explicitly started. The instance menu reports confirmed helper status and can delete stopped clones without removing their assets or state directories. Unchanged helper status polls do not trigger redundant menu refreshes or diagnostic writes. Clones share read-only animation assets and keep independent position, size and activity preferences. At most three pets, including the original, may run at once.
- Startup presentation and coordination run in the macOS host; animation and interaction run in a
  separate Python/PySide6 helper.
- Release flick physics continues while the context menu is open; starting another left drag deliberately interrupts and resets the prior motion.
- A release flick's run/fly pose follows the spring physics, then holds for a separate 2 seconds before returning to idle. This short pose hold does not use or reset the 20–34-second autonomous action schedule; task following, disabling autonomous activity, and Reduce Motion can still interrupt it.
- A deliberate drag-release flick continues during task following; task state still blocks background autonomous movement.
- A local script can upscale the startup video from 1080p to 4K while keeping 24 fps and the original AAC audio. See the [4K workflow](docs/开机动画4K超分.md); desktop playback still needs manual acceptance.
- Quota queries require an explicit user action. Official Codex accounts can show the 5-hour/weekly subscription usage windows; TiMi CC uses a matching, enabled CC Switch usage configuration to show a provider USD balance, with source and query time aligned on the card footer. See [quota details](docs/额度气泡说明.md).
- Local task following reads bounded rollout records in memory, retains lifecycle state only, and never saves or displays chat contents.
  It plays one opening per newly observed task turn, then rotates work animations with short authored work-difference bubbles. It does not read task titles or identify the foreground chat. See [task following](docs/Codex任务跟随.md).
- The app does not persist full voice-chat history or present its bubbles as Codex conversation history. User-managed character identity and confirmed memories are stored separately on the Mac and are not sent online by default. Quota queries remain explicit user actions.
- Voice chat uses local Qwen3-ASR transcription and a user-configured OpenAI-compatible online model for replies. The status menu's **模型管理** supports OpenAI, DeepSeek, and custom relay Base URLs/model names; API Keys are stored in macOS Keychain, while recognized text is sent to the selected provider. Official Codex subscription login is not an API key; Codex/Grok models can be used through a relay that exposes a compatible chat-completions endpoint. Weather lookup uses Open-Meteo when the configured endpoint supports tool calls. Provider charges are separate and controlled by the provider; connection tests may incur a small charge. Local reference-voice TTS remains optional; its output stream stays warm between consecutive turns to reduce repeated device initialization and first-sentence stalls. Runtime and model weights remain checkout-only. See the [live voice pet design](docs/直播语音桌宠方案.md).
- The macOS-only app includes user-controlled persona, local memory and manual goal tracking, isolated by pet instance and stored as readable Markdown. Local recall uses conservative keyword matching; online requests include only relevant memories explicitly allowed for sharing. An explicit voice request to remember ordinary low-risk content may be auto-saved locally, duplicates are skipped, conflicts/sensitive details require review, and detected credentials are rejected. This is not a general background agent or automatic goal executor. See the [digital character and local memory design](docs/数字个体与本地记忆方案.md).
- Poster generation and automatic theme application are not enabled.

Implementation and package details are maintained in the [technical documentation](docs/文档索引.md),
not duplicated here.

Preview old build cleanup with `python3 scripts/clean-builds.py --dry-run` or
`bash scripts/clean-builds.sh --dry-run`. Use Python for the `.py` entry point.
For explicit storage recovery, preview with `python3 scripts/clean-builds.py --caches --dry-run`,
then remove `--dry-run`. This adds allowlisted compiler/PyInstaller intermediates, an owned generated
source staging tree and a redundant helper packaging directory; it preserves build products, source assets,
environments, downloads and verification evidence. Busy paths are skipped; an active compiler or failed
open-file check aborts cleanup.
Normal builds do not opt into cache removal; the next build recreates removed caches.

## Validation

Run `./scripts/test.sh` for the project suite. Run `./scripts/test-multi-pet.sh` for the separate
multi-pet and IPC suite when the prepared runtime is available. A skipped suite is not a full pass.
Automated and offscreen tests do not replace real desktop acceptance. The
[verification record](docs/实际验证记录.md) lists exact coverage and outstanding checks.

The prepared PySide6 environment can generate network-isolated UI snapshots with
`scripts/preview-pet-ui.py`; see the [local guide](docs/本地开发与使用指南.md).
Offscreen previews use Fusion (including an override of inherited Qt style settings),
not native macOS styling; this does not change the desktop application's appearance.
The project suite includes preview, refresh-button and repeated pet-stop lifecycle regression tests.
Bubble screen lookup uses application-level APIs to avoid a locally reproduced PySide6 6.9.2
return-parent ownership issue; stopped adapters explicitly dispose of independent bubble windows.

## Documentation

- [Local development, usage, configuration and installation](docs/本地开发与使用指南.md)
- [Architecture](docs/架构与设计决策.md) and [runtime build/performance](docs/桌宠增强与性能构建.md)
- [Roadmap](docs/roadmap.md) and [version verification records](docs/实际验证记录.md)
- [Full documentation index (Chinese)](docs/文档索引.md)
- [Git workflow](docs/Git提交与协作规范.md)

## License

The root [MIT license](LICENSE) covers this project's original source only. It does not grant rights
to third-party character art, animation, video, music or trademarks. Do not redistribute a build
containing third-party media until its licensing permits it. See
[third-party notices](THIRD_PARTY_NOTICES.md) and [`licenses/`](licenses/).
