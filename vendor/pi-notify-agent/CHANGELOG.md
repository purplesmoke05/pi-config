# Changelog

This is a vendored copy of [`AlyusLabs/pi-notify-agent`](https://github.com/AlyusLabs/pi-notify-agent),
reviewed and imported into `@purplesmoke05/pi-config`. It diverges from upstream only by the local
patches listed below. Upstream has no CHANGELOG; this file documents the vendored state.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed — local patches (this repo only)
- macOS sound is now distinct per outcome and uses `afplay` with system sounds
  instead of the single `osascript beep`. `playSound` takes the notify `kind`
  and resolves `/System/Library/Sounds/<name>.aiff` from
  `PI_NOTIFY_SUCCESS_SOUND` / `PI_NOTIFY_ERROR_SOUND` (default `Glass` /
  `Basso`). Falls back to `osascript beep` if `afplay` or the named sound is
  unavailable. Reason: the upstream `beep` is quiet and identical for success
  and error, so failures were easy to miss on macOS. Linux/Windows unchanged.
  Upstream's own README notes "If you want different sounds for success vs
  error, add that in `extensions/index.ts`" — this patch is that edit.
  Security: `afplay` is invoked via `execFile` with an argument array resolved
  from a fixed directory (`/System/Library/Sounds`) and an env-supplied name
  sanitized through `path.join`; no shell, no user text reaches the command.

## [0.1.2] - vendored

Pinned to upstream commit `b3e040d10bc0290d931c5188f49457abcc3d64d0` (npm `pi-notify-agent@0.1.2`,
verified: npm tarball `gitHead` matches the upstream `main` HEAD).

### Changed — local patches (this repo only)
- Migrated Pi peer dependency and `import type` specifiers from the upstream
  `@mariozechner/pi-*` scope (badlogic/pi-mono) to the `@earendil-works/pi-*` scope this package
  targets. Reason: this config pins the `earendil-works` pi fork for typecheck and runtime; without
  the rewrite the vendored sources would not resolve under `tsc` or under pi's `jiti` loader. This
  mirrors the scope migration applied to `vendor/pi-rtk-optimizer` and `vendor/pi-ollama-cloud-provider`.
- Removed `assets` from `files` in the vendored `package.json`; the preview image is not needed for
  runtime and is not vendored. The upstream `pi.image` URL (a raw GitHub URL) is left in place.

### Security review (pre-import)
- No runtime `dependencies`; only `peerDependencies` on pi packages.
- No npm install scripts (`preinstall`/`postinstall`/etc.).
- No network access: no `fetch`/`http`/`https`/`net`/`undici`/websocket usage.
- No filesystem writes: only `existsSync` reads of fixed system sound paths.
- Process execution is limited to local notification/sound utilities via `execFile` with argument
  arrays (no shell): `which`/`where`, `powershell.exe`, `osascript`, `notify-send`, `rundll32.exe`,
  `canberra-gtk-play`, `paplay`. Errors are swallowed so notifications never break the agent.
- User-controlled text (last assistant message preview) is escaped before being passed to
  PowerShell (`psQuote`, single-quote context), AppleScript (`appleScriptQuote`, double-quote
  context), or `notify-send` (argument-array, no shell). No injection surface found.