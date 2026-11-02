# Anime Desktop Pets

[English](README.md) | [简体中文](README.zh.md)

An anime-style macOS desktop-pet collection for AI assistants. The current white dragon is the
Codex character; Claude, DeepSeek, and Grok characters are planned in the same art style. The
companion currently integrates with Codex only and runs without modifying its application bundle
or `app.asar`. This is not an official product or plugin for any of these platforms.

**GitHub description:** An anime-style macOS desktop-pet collection for AI assistants: a white dragon for Codex, with Claude, DeepSeek, and Grok characters planned in the same art style.

**GitHub topics:** `desktop-pet`, `anime`, `macos`, `codex`, `claude`, `deepseek`, `grok`

> **Status: local development prototype.** The default build packages the locally enhanced Bailong
> macOS pet as a separate helper, with 35 character animations. Helper `dragon.30` rotates through all
> idle and interaction differences; work differences play only for tasks or from their manual menu.
> Helper `dragon.22` requires both
> at least 24px of drag displacement and 280px/s release speed before a flick triggers a hop; gentle
> drags stay at the drop position. Drag pose decisions are sampled at most every 50ms. Version 0.6.10 shares a
> process-wide pixel-cache budget and decode gate across pet instances. Version 0.6.9 reuses one
> measured alpha-bound pose bridge throughout each transition, reducing per-frame pixel scans.
> Version 0.6.8 added complete autonomous action rotation on top of screen-scale
> gravity and damped edge rebounds after release, settling back into idle without an extra landing clip.
> Helper `dragon.25` also removes the legacy landing/tired-flight fallback from gentle release,
> uses a neutral pose for gentle/paused drags, and skips closing poses for drag/flick clips. Compact menus and
> popovers remain in place. The PNG fallback is explicit and is not the full animation player. Live
> following of existing Codex tasks, original poster generation, and an
> applied background are still not implemented; real desktop interaction requires manual acceptance.

### Drag/release visual continuity (dragon.30)

Returning from a drag or completed movement to default idle now uses a **280ms eased crossfade**, starting only when the idle frame is ready. The visible composed pose is retained while decoding; a new drag interrupts from that visible composite. Drag-related transitions keep the selected display size and existing per-clip calibration: no temporary zoom is inferred from a tail, wing or feather's alpha bounds. Natural pose silhouettes still differ; this is not generated in-between animation. Other transitions retain 160ms, Reduce Motion bypasses fades, and the shared pixel budgets are unchanged.

## App identity and pet character

The App's friendly Chinese UI name is **桌边小伙伴**, with the line **让喜欢的角色，陪在桌边。**
(“Let your favorite characters keep you company at your desk.”). The project name, App bundle name,
identifiers and configuration paths are unchanged.

The **Companion Star Window** icon now uses a pearl-white rim, a luminous cyan/blue-to-lavender/pink
and pale-peach background, a violet-gray window and a milky-white star. This second draft borrows
only the user-provided screenshot's color relationship, not its camera-lens motif. It remains
separate from the dragon character and awaits visual approval. Both drafts were drawn offline
from original vector geometry; no paid image-generation request has been made.

See the [editable assets, UI copy and export instructions](resources/branding/README.md) and the
[white-dragon appearance notes and reconstruction prompts](docs/白龙外观观察与提示词.md).
The prompts describe sampled WebP frames; they do not recover the original prompt or grant
rights to the third-party character. Packaging changes only the host icon, not the pet helper icon.

## Codex quota bubble

**Right-click → 查看 Codex 额度** opens the compact quota bubble beside the pet, with remaining quota bars and reset times.

Pet size is limited to 50%–150% of the 256px reference size. Manual autonomous-action entries are one-shot commands; they remain available when scheduled activity is off, while Reduce Motion and active interactions still take priority.
It follows the reference project's quota-bubble pattern. Pet-owned chat/history was removed because it duplicates Codex conversations without sharing or continuing the same session; see the [PRD](docs/prd.md). No standalone wide window or local conversation UI is shipped.
Quota refresh uses the existing read-only Codex CLI adapter and runs only when explicitly requested from the menu or by double-clicking the pet.

## Autonomous activity (0.5.1)

- Every 12–24 seconds of eligible idle time, the pet silently rotates through the complete idle and interaction pool; short movement remains a separate autonomous branch.
- All 15 interaction and 6 idle clips are in the daily rotation. Work clips are reserved for active tasks or their manual menu; they do not appear during idle scheduling.
- The enhanced helper uses left/right walk, run and fly clips. Position changes only between each clip’s movement start/stop times; the pet stays at the bounded endpoint during the closing poses. A 25-action compatibility catalog in the enhanced code retains the older hop/dash presets; the unmodified upstream app is separate.
- Gentle dragging uses the default neutral pose; clear motion selects directional walk/run/fly with 50ms decision throttling and hysteresis. While held, only the active movement segment loops (no standing preparation or tired closing poses); an 80ms stop returns to neutral at the next pose update.
- A flick requires at least 24 logical pixels of displacement and 280px/s in the latest 150ms, including any pause before release. Gentle, slow, short, or held-then-released drags stay exactly at the drop position and return directly to default idle—never the legacy landing/tired-flight clip, including when movement or Reduce Motion disables effects. A deliberate flick retains screen-bounded gravity/rebounds; each deliberate release randomly chooses directional running (chasing the feather) or flight. The selected active movement segment loops on the same presentation clock until the bounce settles, then returns directly to default idle; no tired closing pose or full entrance transition is replayed per loop. Independent 50/50 draws may repeat (run, run, fly is valid); there is no preference menu. Helper `dragon.30` uses four derived 384px release-only loops with a 60ms local seam bridge, follows wall rebounds using a mirrored draw without restarting media, scales height/damping with flick strength, and replaces the high-screen timeout snap with a smooth floor finish. Source animations remain unchanged; the 48MiB/8MiB shared pixel budgets are unchanged. Gentle release still never triggers a bounce. The older three-hop trajectory remains only for a 25-action compatibility catalog.
- Helper `dragon.26` keeps a deliberate throw alive independently of animation completion, including floating-point end-of-clip boundaries. It settles at the bottom of the current screen’s available work area (above the Dock when reserved), not at the drag origin or release height. Work-area floor changes are re-evaluated; gentle release still stays where dropped.
- Helper `dragon.27` gives release-spring movement its own monotonic clock on the existing 16ms tick. Short WebP stalls and 160ms pose blends hold the old picture without freezing the throw; each physics update is capped at 50ms, with no backlog catch-up. Ordinary autonomous/manual movement remains synchronized to decoded frames. No new timer, full-animation preload, or pixel-budget increase is introduced.
- **Right-click → 自主活动** offers scheduled-animation and movement switches plus a preview action. Disabling scheduled actions still permits drag-release movement; disabling movement stops both movement types.
- Dragging, tasks, open menus/dialogs, hidden state and Reduce Motion take priority. Autonomous playback never initiates quota reads, chat, sounds or speech bubbles.

The motion layer reuses the original artwork; it does not generate new character frames or detect other application windows as physical platforms. Actual desktop feel and focus behavior still require manual acceptance.

## Ten extra animations (integrated)

The [extra-animation guide](docs/扩展动作素材与运行时接入.md) covers local extraction, lossless WebP conversion and the verified build-time overlay. The enhanced helper now includes 6 idle + 15 interaction + 5 work + 3 special + 6 movement actions. Use **待机差分动画** for the new idle clips, or **自主活动 → 走路 / 跑步 / 飞行** for movement previews. Scheduled action selection rotates through the complete idle/interaction pool (work clips are excluded); the manual “表演一套动作” command cannot be diverted into movement. Pose transitions stabilize the visible character bounds during the 160ms bridge and return to the target’s native pose at the endpoint. Rendering uses per-frame WebP durations; ordinary movement freezes with unavailable frames, while release-spring physics advances independently with the previous pose held during short stalls. This is a short blend, not generated in-between character poses; desktop acceptance is still pending.

## Pet asset library

The existing white-dragon assets are already available in this project; no additional download is needed.
The new [pet-library CLI](docs/宠物库与素材包.md) audits all 35 animations without copying the roughly 1.25GiB
of media. It also validates and atomically imports data-only `.petpack` archives into an explicitly chosen
library, with path/link/size/hash/full-frame checks and rollback on failure. Imported packages are **not activated**.

```bash
.local/pet-build/venv/bin/python scripts/pet-library.py audit-bailong \
  --report .local/pet-library/bailong-catalog-new.json
.local/pet-build/venv/bin/python scripts/pet-library.py \
  --library .local/pet-library/test-library list
```

The 0.6.10 / `dragon.30` app includes multi-pet windows, a **Pet Manager** menu entry,
same-package clones and per-instance settings. When the PySide6 build runtime is available, the app build
bundles the graphical library as a separate helper app, exposed as **Open Pet Asset Library** in the menu.
It imports `.petpack` files, validates package details and previews animations. The default library is
`~/Library/Application Support/DragonCodexCompanion/PetLibrary`. Import does not activate a package;
stopped instances can select an exact installed package version through the library. Deletion checks all instance references, including stopped instances. Running pets must be stopped before switching. Closing the
library does not affect running pets. See the [library guide](docs/宠物库与素材包.md) and [roadmap](docs/roadmap.md).

The current priority is to finish the Codex white-dragon workflow before adding other characters.
Version 0.6.10 shares a 48 MiB QImage cache, an 8 MiB QPixmap cache and one active decode slot across
pet players in the Qt controller process. Helper build 24 passes 81 runtime regressions and 14 frozen self-checks; gentle releases do not hop. Real desktop rotation, drag smoothness and long-running resource acceptance remain pending.
These are pixel-cache budgets, not a total RAM limit. Generated upstream sources use
`.local/pet-build/generated-source/`; retained runtime artwork stays in `.local/pet-build/source/outputs/`.

## Features and boundaries

| Area | Available now | Not yet delivered |
| --- | --- | --- |
| Startup | Process observation, stable-window detection, video overlay, skip/fade/timeout cleanup | Guaranteed flash-free first frame; manual desktop acceptance |
| Pet | Enhanced helper: 35 animations, adaptive text, background decoding and macOS-style menus; native fallback available | Live state following of existing Codex tasks; desktop integration acceptance |
| Control | Menu bar, multi-pet manager, typed local Unix-socket commands | A graphical configuration studio |
| Poster and theme | Art brief, disabled provider template, optional theme helper | Image requests, generated artwork, applied background |
| Installation | Explicit install/uninstall scripts | Verified login integration and a public release |

## Requirements

- Apple Silicon Mac with macOS 13 or newer. The build has only been checked on the local arm64 machine.
- Xcode / Command Line Tools with Swift 5.9 or newer; Python 3 for build and checking scripts.
- The official Codex desktop client with bundle identifier `com.openai.codex`.
- Local media you are authorized to use. No model API key is needed to run the prototype.

The native host has no third-party Swift package dependencies. No Node.js or separately
installed Python GUI runtime is needed: the full upstream helper bundles its own Python/Qt.
The optional theme helper has separate dependencies.

## Quick start

Run these commands from the repository root. On the current development machine:

```bash
cd /Users/ming/Documents/coding/desktop-app/anime-desktop-pets
```

### 1. Import local development assets

The existing development checkout already has imported media. On a fresh checkout, supply
local files you are authorized to use. The selected source filename is `startup.mp4`, not `start-up.mp4`.

```bash
python3 scripts/import-local-assets.py \
  --video /absolute/path/to/startup.mp4 \
  --pet-preview /absolute/path/to/preview.png
```

The importer copies files into ignored local resource folders and records SHA-256 provenance.
It does not modify the original repositories. Replacing different existing files requires `--overwrite`.

### 2. Build and check

```bash
# One-time explicit network download, pinned release + SHA-256 verification (~701 MiB).
python3 scripts/prepare-full-pet.py fetch

# Prepare the local Python 3.12 environment and 10 extra clips (see the extra-animation guide), then build the helper.
# See docs/桌宠增强与性能构建.md for the pinned dependencies and source path.
python3 scripts/build-pet-runtime.py build
./scripts/build.sh
./scripts/test.sh
./scripts/dragonctl.sh --check
```

Output: `build/Dragon Codex Companion.app`, locally ad-hoc signed and not notarized.

A local drag-to-install image is available as of 2026-11-02:
`build/Anime Desktop Pets-0.6.10-arm64-local.dmg` (about 114 MiB).
Open it and drag the App to Applications. Quit a running copy from its menu first; Codex need not quit.
This build targets the current Mac and still references this checkout's
`.local/pet-build/source/outputs/白龙桌宠素材`; keep the checkout and assets in place.
It is not a portable or redistribution-cleared release. Manual installation does not register a login
service; the optional login-service installer below is not needed for drag-and-drop installation.

Fetching only downloads and verifies the helper; it does not run it. Build/check/test do not
launch/restart Codex, install a login service, apply a theme, or call an image provider.
A successful check is not proof of visual or keyboard-focus correctness.

The enhanced helper build is slim by default and references the local animation directory
`.local/pet-build/source/outputs/白龙桌宠素材` instead of embedding roughly 1.25 GiB of WebP assets.
Override the path with `DRAGON_PET_ASSETS_DIR=/absolute/path ./scripts/build.sh`. This path is stored in
the generated local build configuration and is not portable to another Mac. Use
`python3 scripts/build-pet-runtime.py build --bundle-assets` for a self-contained helper. Successful
builds remove unused archived app versions; `python3 scripts/clean-builds.py --dry-run` previews manual cleanup.

### 3. Preview without restarting Codex

```bash
./scripts/dragonctl.sh --preview-animation
```

**This command stays in the foreground, even after the video ends.** Quit through the menu bar,
or send the following command from a **second terminal tab** at the repository root:

```bash
./scripts/dragonctl.sh --quit
```

After the first companion instance has exited, preview the pet:

```bash
./scripts/dragonctl.sh --preview-pet
```

Only one companion instance may run at a time. Quit it before switching startup modes.
The full pet provides actual idle/click/drag/landing animations and its own action menus.
The native fallback supports image dragging and speech; only that fallback's breathing effect
is disabled by system Reduce Motion when created.

For the full build, a manual convenience entry point validates the 25/35-action catalog, quits the old
companion, waits for cleanup, and then previews the pet without launching/restarting Codex:

```bash
./scripts/preview-full-pet.sh
```

It refuses a static fallback configuration rather than presenting it as the full pet.

### 4. Run alongside Codex

After quitting any preview instance, choose one mode:

```bash
# Start or reuse Codex. This is also the default when opening the built .app.
./scripts/dragonctl.sh --launch
```

Or:

```bash
# Observe subsequent Codex launches; do not restart the existing client.
./scripts/dragonctl.sh --watch
```

Both are foreground modes. Use another terminal tab or the menu bar for controls.
If Codex is already running, the companion shows the pet **without replaying the startup video**.
A genuine cold-start acceptance test requires the user to deliberately quit and relaunch Codex.
Closing a Codex window is not the same as terminating its process.

| Command | Purpose |
| --- | --- |
| `--status` | Inspect the companion state |
| `--show` / `--hide` | Show or hide the pet |
| `--dismiss` | End pet display for the current Codex session |
| `--pause` / `--resume` | Pause or resume companion coordination |
| `--quit` | Quit the companion, not Codex |

Pass one command to `./scripts/dragonctl.sh`. Esc, Command+., and the skip button dismiss the movie.
Timeouts and playback failures clean up the overlay rather than blocking Codex.
The observer waits for a real client window, so it cannot guarantee a flash-free first frame.

## Configuration and local data

The complete template is `config/companion.example.json`. Optional user configuration and
runtime data live in:

```text
~/Library/Application Support/DragonCodexCompanion/
  companion.json
  pet-position.json
  companion.log
  control.sock
  instance.lock
```

Copy and edit the **complete** template if needed, then restart the companion, not Codex.
Relative media paths resolve against the resource root. `DRAGON_DATA_DIR` isolates local state;
`DRAGON_RESOURCE_DIR` overrides the resource root.

The source template retains the native fallback. The default build produces an external-backend
template pointing to `../Helpers/BailongPet.app`, resolved relative to the companion resource root.
The default build copies the locally adapted helper with its own signature and provenance marker.
The original downloaded app is preserved. `--full-pet` explicitly selects that unchanged upstream
build; `--native-pet` selects the static fallback. See [runtime details](docs/桌宠增强与性能构建.md).
An existing user `companion.json` takes precedence. If it explicitly selects native, change the
complete config or back it up and remove it to use the bundled default. Never discard custom settings silently.

The helper owns its animation and interaction features. The companion coordinates startup,
show/hide and local status; it never force-terminates a helper that might be running a task.
See the [full-pet integration guide](docs/完整桌宠接入说明.md) for lifecycle and privacy boundaries.

## Optional login installation

First finish manual acceptance. The following commands only print a plan:

```bash
./scripts/install.sh
./scripts/uninstall.sh
```

Only when deliberately requested, add `--confirm` to install/load or uninstall this project's
LaunchAgent. Installation uses `~/Applications/Dragon Codex Companion.app` and
`~/Library/LaunchAgents/local.dragon.codex-companion.watch.plist`.
Known conflicting legacy watchers cause installation to stop. Uninstall preserves user settings
and the official Codex client, and moves this project's installed app to Trash.

## Poster and theme plan

The requested provider model is exactly `gpt-image-2.5`. Its base URL, authentication, supported
schema, output formats, and first paid request must be confirmed before implementing calls.
The current provider template is disabled. Keep credentials in an ignored local `.env` or the
OS keychain, never in Git or asset metadata.

The art direction is “月白龙姬 · 紫雾工作室”: an original white/lavender dragon girl at the right
edge of a quiet midnight-plum workspace. See the [poster brief](docs/海报设计说明.md).
No original artwork has been generated. A video still or the existing PNG is not original generated art.

The optional `scripts/theme.sh` delegates to a separately installed `codex-theme-studio` tool.
It uses version-sensitive runtime CSS via loopback CDP, **not an official plugin API**.
Compilation requires reviewed artwork; apply/restore require `--confirm`. An existing client
without CDP is never silently restarted. Automatic `themeEnabled` remains rejected until validation.

## Repository structure and Monorepo direction

This is now a lightweight Monorepo: the Swift host and Python/PySide6 pet runtime live under
`apps/`. Shared packages and Studio remain future additions:

```text
apps/companion-macos/        # SwiftPM native host, DragonCore and core tests
apps/pet-runtime/            # Python/PySide6 playback, multi-pet, IPC and library logic
resources/                  # App branding, local video, pet and future poster assets
config/                     # Configuration templates
scripts/                    # Build, test and operational entry points
integrations/bailong/        # Pinned upstream metadata, notices and patches
docs/                       # Chinese product and engineering documentation
```

The layout does not require introducing npm tooling. An optional studio, shared Swift packages,
and cross-language contracts can be added later when they have real consumers.
See [architecture](docs/架构与设计决策.md) and [roadmap](docs/roadmap.md).

## Validation snapshot (2026-11-02)

The current host is **0.6.10 / build 19**, with enhanced helper **build 24 / `dragon.30`** and
35 actions. Both have been rebuilt from the relocated Monorepo sources. Animation files remain
external to the default helper; the host now embeds its own App icon, separate from pet artwork.
The helper input fingerprints match the current sources, deep ad-hoc signature verification
passes, and `dragonctl --check` reports `ok=true` without launching a normal pet session.

The executed suite includes 83 Swift tests, 10 project checks, 5 App-icon export checks,
8 build-input/staging checks, 13 acquisition/source checks, 15 extra-asset checks, 41 library
checks, 5 offscreen library-UI checks, 120 runtime checks, 9 real-pet adapter checks, 37 controller
checks, 21 IPC checks and isolated control integration. These suites were rerun before the Git
baseline commit with no skipped suites. The existing `dragon.30` build previously passed its
18-check frozen isolated self-test; this Git/documentation pass did not rebuild the apps or rerun
that frozen self-test. “Real-pet adapter” means offscreen tests of the real adapter
code with synthetic fixtures, not desktop acceptance.

The original 25 clips were previously audited across 2,529 frames and the ten extra clips across
1,897 frames. This round sampled 12 clips for character-description prompts; it is not a new
full-frame artwork audit. No pet-owned chat/history UI is shipped. These checks do not replace
real desktop, multi-screen/Space/focus, long-duration CPU/RSS, third-party package playback or
installation acceptance. See the [verification record](docs/实际验证记录.md) for exact scope.

## Development and Git commits

Use `<type>(<scope>): <Chinese imperative summary>` for commit titles. Keep the type and scope
in English and the summary and body in Chinese, preserving technical identifiers as needed.
Each commit should have one logical purpose; include its related tests and documentation,
and report only checks actually run, including failures, skips and unverified desktop behavior.
For example: `docs(workflow): 记录 Git 提交与验证规范`.

Run `./scripts/test.sh` for the project suite and `./scripts/test-multi-pet.sh` for the independent
multi-pet suite when the prepared runtime is available. Missing dependencies or skipped suites
must not be reported as full validation. Documentation-only edits need link/status consistency
and diff checks, not an app rebuild or launch. Review the staged diff before committing; keep
local assets, credentials and build outputs ignored. Commits do not authorize a remote push.
See [repository instructions](AGENTS.md) and the [Git workflow guide](docs/Git提交与协作规范.md).

## Documentation

Engineering and product documents are maintained in Chinese; this README is the English entry point.

- [中文文档导航](docs/文档索引.md)
- [产品需求文档（PRD）](docs/prd.md)
- [开发路线图](docs/roadmap.md)
- [完整动画桌宠接入](docs/完整桌宠接入说明.md)
- [架构与设计决策](docs/架构与设计决策.md)
- [测试与人工验收](docs/测试与人工验收.md)
- [桌宠增强与性能](docs/桌宠增强与性能构建.md)
- [实际验证记录](docs/实际验证记录.md)
- [海报设计说明](docs/海报设计说明.md)

## License and third-party materials

The root [MIT license](LICENSE) covers this project's original source, not third-party video,
character art, music, trademarks, or separately installed tools. Imported media is ignored by Git,
but the local built app contains it: **do not redistribute that app until media rights are cleared**.
The same restriction applies to the newly bundled third-party helper and its animation assets.
Read [third-party notices](THIRD_PARTY_NOTICES.md) and the provenance records in `licenses/`.

### Compact card UI (0.3.1)

The pet context menu now uses 12px card corners, 23px rows, rounded hover highlights, aligned vector
checkmarks and outline chevrons. Width follows the longest label. Popovers fit short text and shrink
when progress becomes shorter; long content scrolls within a bounded body. These are custom Qt card
surfaces, not AppKit menus or system blur materials. See [UI details](docs/桌宠增强与性能构建.md).

## Multi-pet lifecycle core (MP1c)

The instance model and Qt lifecycle controller support isolated settings, local stop/restart,
startup/cleanup timeout handling, a single-controller lock and same-package clones. The Pet Manager menu
can create clones, start/stop instances and set their sizes. Clones share read-only media but keep separate
state directories and preferences. Real desktop, multi-display and long-running resource acceptance is
still pending. Run `./scripts/test-multi-pet.sh` for the separate offline suite (independent Swift scratch
directory and synthetic offscreen Qt animations). See [integration boundaries](docs/多宠实例模型与生命周期.md).

## Multi-pet control channel (development only)

A typed Swift client now talks to the Qt instance controller over a permission-restricted local socket:
status, individual/batch start, local/all stop, preference updates, same-package cloning and graceful shutdown. The development
CLI is `scripts/pet-instances.py`; it only connects to an existing, explicitly selected profile and never
cold-starts another controller. Delivery without confirmation is reported as uncertain, not retried.
[Protocol and limits](docs/多宠本地控制协议.md). Cross-process tests use synthetic adapters and do not
replace real desktop acceptance. Run `./scripts/test-multi-pet.sh`.
