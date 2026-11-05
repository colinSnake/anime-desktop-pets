# Anime Desktop Pets

[English](README.md) | [简体中文](README.zh.md)

An anime-style desktop-pet project for macOS. The current character is a white dragon for Codex;
Claude, DeepSeek and Grok characters are planned, not yet integrated. The app runs alongside Codex
without modifying its application bundle or `app.asar`. It is an independent project, not an
official OpenAI product or plugin.

The app's Chinese UI name is **桌边小崽** (“Desk-side Cub”), with the line **让喜欢的角色，陪在桌边。**
The project name is Anime Desktop Pets. The built application is **`桌边小崽.app`**, including its macOS
display name. The bundle identifier, internal executable, configuration and data paths remain unchanged.

## Current Status

This is a local development prototype with **35 character animations**, multi-pet management and
a local asset library. A separate helper provides the full pet experience; the native PNG backend
is a limited fallback. The enhanced helper can follow local Codex task lifecycle events and play work animations;
real desktop task following still awaits manual acceptance.
Real desktop behavior, focus, multi-display and long-duration resource use still need
manual acceptance. See the [roadmap](docs/roadmap.md) and [verification record](docs/实际验证记录.md).
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
python3 scripts/build-pet-runtime.py build
./scripts/build.sh
./scripts/test.sh
./scripts/dragonctl.sh --check
```

The default helper references local animation files and is not a portable release. Build and test
commands do not launch the pet or restart Codex. `--check` validates local configuration and assets;
it is not real desktop acceptance.

To deliberately preview the full pet, run `./scripts/preview-full-pet.sh`. It may quit an existing
pet instance before switching modes. Do not run it when you need to preserve a currently active
instance. For Codex launch/watch modes and local configuration, see the
[local usage guide](docs/本地开发与使用指南.md).

## Features and Boundaries

- The 4K startup video and Codex launch run together. New client windows are sized to the 16:9 video when Accessibility is granted; otherwise the video fills the actual client frame (edge cropping, no letterboxing). A nearly opaque nonactivating cover and a Chromium occlusion switch keep rendering progressing. When the startup video ends, the cover is released and Codex's own loading UI is allowed to continue; Codex exposes no content-readiness API. Existing processes are neither resized nor replayed.
- Full animated white-dragon pet, multi-instance management and a local pet asset library. The status menu manages lifecycle; per-pet menus handle interaction and animation previews. See the [menu contract](docs/菜单功能与交互边界.md).
- Full 35-action evaluation leaves production assets unchanged: actual Qt premultiplied-pixel checks reject pre-scaled WebP replacement. Raw premultiplied-frame compression is exact at 256/512px, but both full payloads would total about 1.87 GiB; only bounded, on-demand caching remains under evaluation, with no desktop CPU/RSS improvement claim. Read-only tooling and scope are in the [performance notes](docs/桌宠增强与性能构建.md) and [verification record](docs/实际验证记录.md).
- The enhanced white dragon can create its first same-package clone from the host status menu without a pre-existing registry. The confirmed handoff moves the host-owned pet from its single-pet controller to one multi-pet helper; a new clone starts stopped and is not auto-restored until explicitly started. The instance menu reports confirmed helper status and can delete stopped clones without removing their assets or state directories. Unchanged helper status polls do not trigger redundant menu refreshes or diagnostic writes. Clones share read-only animation assets and keep independent position, size and activity preferences. At most three pets, including the original, may run at once.
- Startup presentation and coordination run in the macOS host; animation and interaction run in a
  separate Python/PySide6 helper.
- Release flick physics continues while the context menu is open; starting another left drag deliberately interrupts and resets the prior motion.
- A deliberate drag-release flick continues during task following; task state still blocks background autonomous movement.
- A local script can upscale the startup video from 1080p to 4K while keeping 24 fps and the original AAC audio. See the [4K workflow](docs/开机动画4K超分.md); desktop playback still needs manual acceptance.
- Quota queries require an explicit user action. Official accounts show subscription windows; TiMi CC uses a matching, enabled CC Switch usage configuration to show provider balance. See [quota details](docs/额度气泡说明.md).
- Local task following reads bounded rollout records in memory, retains lifecycle state only, and never saves or displays chat contents.
  It plays one opening per newly observed task turn, then rotates work animations with short authored work-difference bubbles. It does not read task titles or identify the foreground chat. See [task following](docs/Codex任务跟随.md).
- The app does not provide its own chat/history. Quota queries remain explicit user actions.
- Poster generation and automatic theme application are not enabled.

Implementation and package details are maintained in the [technical documentation](docs/文档索引.md),
not duplicated here.

Preview old build cleanup with `python3 scripts/clean-builds.py --dry-run` or
`bash scripts/clean-builds.sh --dry-run`. Use Python for the `.py` entry point.
For explicit storage recovery, preview with `python3 scripts/clean-builds.py --caches --dry-run`,
then remove `--dry-run`. This only adds allowlisted compiler/PyInstaller intermediates and a redundant
helper packaging directory; it preserves build products, source assets, environments, downloads and
verification evidence. Busy paths are skipped; an active compiler or failed open-file check aborts cleanup.
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
