# pi-config

Personal customizations for the [pi coding agent](https://pi.dev/): extensions, prompt templates, and reviewed provider integrations, packaged as a [pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

Smoke-tested with runtime `pi` 0.80.2. Development typecheck uses `@earendil-works/pi-coding-agent` 0.80.2.

## Install

```bash
pi install git:github.com/purplesmoke05/pi-config
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/purplehaze/Projects/pi-config"]
}
```

## What's inside

| Path | Type | What it does |
|------|------|--------------|
| `extensions/copilot-instructions/` | extension | Loads GitHub Copilot context files when present: `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, and `.github/skills/*/SKILL.md` |
| `extensions/copilot-usage/` | extension | Shows outgoing input-token estimates and provider-reported token/list-price credit usage, only while the `github-copilot` provider is selected |
| `extensions/autonomy-scaffold/` | extension | Appends a system-prompt discipline block that keeps weak-autonomy models on task (don't stop before the work is verifiable; investigate with your own tools before asking). Disabled by default; enable with `PI_AUTONOMY_SCAFFOLD_ENABLE=1` |
| `extensions/providers/` | extension | Registers the Command Code model provider |
| `extensions/copy-code/` | extension | `/copy-code` copies a fenced code block from the last answer to the clipboard as raw text, without the gutter indent that mouse-selecting pi's rendered output picks up |
| `vendor/pi-rtk-optimizer/` | vendored extension | RTK command rewriting and tool output compaction for `bash`, `read`, and `grep` |
| `vendor/pi-ollama-cloud-provider/` | vendored extension | Reviewed copy of `pi-ollama-cloud-provider@0.3.0`, registered as `ollama-cloud` |
| `vendor/pi-notify-agent/` | vendored extension | Reviewed copy of `pi-notify-agent@0.1.2`; cross-platform desktop notification + sound on `agent_end`, with `/notify-test` and `/notify-status` |
| `agent-sops/` | Agent SOPs | Recurring maintenance procedures for this repo as [Agent SOPs](https://github.com/strands-agents/agent-sop), served to Claude Code via `.mcp.json` |
| `prompts/` | prompt templates | Empty for now |

## GitHub Copilot Context

Pi already loads `AGENTS.md` and `CLAUDE.md` as native context files. This package additionally mirrors GitHub Copilot repository instructions by appending `.github/copilot-instructions.md` and `.github/instructions/**/*.instructions.md` when they exist. It also exposes `.github/skills/*/SKILL.md` through Pi's native skills loader, so skill bodies stay on-demand instead of always-on. Disable the instruction loader with `PI_COPILOT_INSTRUCTIONS_DISABLE=1`, or the skills bridge with `PI_COPILOT_SKILLS_DISABLE=1`.

## GitHub Copilot Usage

`extensions/copilot-usage/` is active only when the current model's provider is exactly `github-copilot`. It adds a compact `Copilot` status through `ctx.ui.setStatus()`, so it composes with the built-in footer and `pi-powerline-footer` instead of replacing either one. Switching to another provider clears both the status and its detailed report.

The status separates values with different confidence levels:

- While idle, `next-base ≈…` estimates the system prompt, active tool schemas, and current context. It is a preflight baseline for the next call; text still sitting unsent in the editor is not part of Pi's extension context yet.
- Once a prompt has been submitted and Pi reaches the HTTP boundary, `sending ≈…` estimates the final provider payload using a conservative heuristic: ASCII characters divided by four, non-ASCII code points multiplied by two, and 1,200 tokens per image, with Pi's own context estimate as a floor. Pi has no provider tokenizer at this hook, so this is deliberately marked as an estimate; image cost remains model/resolution dependent and base64 bytes are not counted as text.
- After a response, branch totals use the token buckets reported by the provider and stored in Pi: uncached input, cache reads, cache writes, and output.
- `≈… cr` is a local gross list-price estimate (`1 AI credit = $0.01`). It uses the cost Pi stored with each response and applies known GitHub long-context tiers from the pricing snapshot linked in the report. It is not GitHub's authoritative net bill.

Use the runtime command for history and official reconciliation:

```text
/copilot-usage                    current UTC month across all Pi sessions
/copilot-usage 2026-07            a specific UTC month
/copilot-usage official           current month plus GitHub account billing
/copilot-usage official 2026-07   specific month plus GitHub account billing
/copilot-usage clear              hide the detailed report
```

The local monthly scan counts every recorded Copilot assistant message in the valid session files returned by Pi's session index, including calls on abandoned in-file branches, while removing identical entries copied into forked/cloned session files. Session content is processed locally only; the report exposes usage totals, not prompts or responses. Long-context adjustments use the dated pricing snapshot shown in the report only for calls from the AI Credits transition date onward; older calls retain Pi's stored historical cost.

Pi 0.80.2 does not persist the provider, tokens, or cost of its internal LLM calls for automatic/manual compaction and tree branch summaries. When those entries are present, this extension does not pretend they were free: it marks local credits as `+?`, reports how many internal calls are unattributed, and leaves GitHub's official account report as the authoritative total. Recovering those historical tokens exactly requires an upstream Pi session-format/event change.

The extension does **not** read `auth.json`, GitHub tokens, `hosts.yml`, or environment credential values. Network access occurs only after the explicit `official` command, which invokes `gh api` with fixed argument arrays and lets GitHub CLI handle its own authentication. The report prints the `gh` login because that account is not guaranteed to be the same account used by Pi's Copilot OAuth. The official user billing endpoint is account-wide (not Pi-only) and can require a classic PAT plus suitable billing access; organization- or enterprise-managed seats may require their corresponding admin endpoint instead. Grandfathered premium-request plans are not silently converted into AI Credits.

Disable all tracking and display with `PI_COPILOT_USAGE_DISABLE=1` (also accepts `true` or `yes`). The `/copilot-usage` command remains registered so it can report that the extension is disabled.

## Autonomy Scaffold

Weak-autonomy models tend to fail in two ways: they stop early (declaring the task done, or asking the user for permission before the work is verifiable), and they ask the user for things they could look up themselves. `extensions/autonomy-scaffold/` appends a short discipline block to the system prompt on every agent start, telling the model to stay on task until the result is verified and to investigate with its own tools (`ls`, `find`, `grep`, `read`, `bash`) before asking.

The block is idempotent (guarded by `<autonomy_scaffold>` markers) and is **disabled by default**. Enable it at pi launch via environment variable (typically set in your Nix/sops env, alongside provider keys):

```bash
# Enable for all models
export PI_AUTONOMY_SCAFFOLD_ENABLE=1
```

When enabled, the scaffold applies to every model unless `PI_AUTONOMY_SCAFFOLD_ONLY` narrows it to a comma-separated list, matched as case-insensitive substrings against model id and provider:

```bash
# Enable only for weak-autonomy models
export PI_AUTONOMY_SCAFFOLD_ENABLE=1
export PI_AUTONOMY_SCAFFOLD_ONLY=glm,qwen-coder,llama,deepseek
```

`PI_AUTONOMY_SCAFFOLD_ONLY` on its own does nothing -- `PI_AUTONOMY_SCAFFOLD_ENABLE=1` is the master switch. Use `/autonomy-scaffold` inside pi to check whether the scaffold is active for the current model.

## Providers

This package registers two providers:

- `commandcode`: discovers models from Command Code's Provider API and uses `CMD_API_KEY` by default. `COMMAND_CODE_API_KEY` and `COMMANDCODE_API_KEY` are also accepted.
- `ollama-cloud`: connects directly to Ollama Cloud at `https://ollama.com/v1` using `OLLAMA_CLOUD_API_KEY` or pi auth storage. It does not require or assume a local Ollama server.

Set `CMD_ZDR=1` to send Command Code's zero-data-retention header. `opencode` / `opencode-go` are already built into pi; set `OPENCODE_API_KEY` for those.

If none of the provider API keys are configured, pi will report no available models. That is expected; this package does not fall back to local Ollama.

Local Ollama is intentionally not auto-registered here. If local Ollama is needed later, use a separate explicit provider or Ollama's own pi integration so `localhost:11434` is never assumed by this package.

## copy-code

pi renders fenced code blocks with a per-line prefix (`codeBlockIndent`, default 2 spaces) plus a 1-space `paddingX` left margin, both baked into the line as literal characters. Mouse-selecting a code block in the terminal therefore copies that leading whitespace on every line, so pasted code comes in shifted right. pi's own `/copy` avoids this by copying pre-render text, but it copies the entire last assistant message — not a single block.

`extensions/copy-code/` keeps the latest assistant text (captured on `message_end`) and copies just the requested fenced block to the clipboard as raw text, with no gutter and with the code's own inner indentation preserved.

```
/copy-code         copy the LAST code block
/copy-code 2       copy the Nth block (1-based)
/copy-code all     copy every block, concatenated as fenced markdown
/copy-code list    show a numbered list of blocks (no copy)
/cc                alias for /copy-code
```

Disable the extension with `PI_COPY_CODE_DISABLE=1`. No network access, no filesystem writes; the only subprocess is pi's own `copyToClipboard` (xclip/xsel/wl-copy/pbcopy/clip or OSC 52).

## RTK Optimizer Vendor Notes

`pi-rtk-optimizer@0.8.3` is vendored under `vendor/pi-rtk-optimizer/` instead of installed as an npm dependency because its published peer dependency range stops at pi 0.79, while this package is smoke-tested with pi 0.80.2.

Review notes:

- Upstream source is pinned to commit `78b8f8a08e5564072eb73e2fa9f183c9f03d2625`.
- Compatibility audit: the public extension/TUI type declarations used by this extension are unchanged between `@earendil-works/pi-coding-agent`/`pi-tui` 0.79.10 and 0.80.2. The vendored `package.json` peer range is patched locally to include 0.80.
- Network/process targets are local shell commands only: `which`/`where`, `rtk --version`, and `rtk rewrite`.
- Runtime config is stored under `~/.pi/agent/extensions/pi-rtk-optimizer/config.json` (or the active `PI_CODING_AGENT_DIR` equivalent).
- Local default patch enables read compaction, minimal source filtering, smart truncation, and exact skill-read preservation so the full RTK output pipeline is active by default while keeping skill files exact.
- The `/rtk` command can inspect, toggle, reset, and verify the optimizer at runtime.

## Ollama Cloud Vendor Notes

`pi-ollama-cloud-provider@0.3.0` is vendored under `vendor/pi-ollama-cloud-provider/` instead of installed with `pi install npm:...`.

Review notes:

- npm tarball had no runtime dependencies and no install scripts.
- npm `gitHead` matched the upstream tag/HEAD commit `ea57d52ebac23dc550abc5c653462ed9ea101df1`.
- Network targets are `https://ollama.com` and `https://models.dev/api.json`.
- Cache writes are under `~/.pi/agent/cache/ollama-cloud/`.
- Local compatibility patches keep it working with runtime `pi` 0.79.1 and move Ollama developer-role compatibility to model-level config.
- **Reasoning effort control patch:** the vendored copy now reads models.dev `reasoning_options` and builds a per-model `thinkingLevelMap` + `compat.supportsReasoningEffort: true` for `type: "effort"` models. GLM-5.2 (`["high","max"]`) thus exposes a real `high`/`xhigh` picker and sends `reasoning_effort` to ollama.com, instead of pi showing an ineffective `off`..`high` range that never reached the API. Toggle-only reasoning models (GLM-4.7/5.1) keep legacy behavior. Set `PI_OLLAMA_CLOUD_NO_EFFORT=1` to disable. Cache entries now persist `effortValues` so offline discovery preserves the map.

Use `/ollama-cloud` inside pi for refresh/status/cache inspection.

## pi-notify-agent Vendor Notes

`pi-notify-agent@0.1.2` is vendored under `vendor/pi-notify-agent/` instead of installed with `pi install npm:...` so it could be security-reviewed before granting it process-launch access, and so its `import type` specifiers resolve against this package's `@earendil-works/pi-*` runtime fork rather than the upstream `@mariozechner/pi-*` scope.

Review notes:

- Upstream source is pinned to commit `b3e040d10bc0290d931c5188f49457abcc3d64d0` (verified: the npm tarball `gitHead` matches the upstream `main` HEAD, so the published package matches its public source).
- No runtime `dependencies`; only `peerDependencies` on pi packages. No npm install scripts.
- No network access: no `fetch`/`http`/`https`/`net`/`undici`/websocket usage anywhere in the source.
- No filesystem writes: only `existsSync` reads of three fixed freedesktop sound paths. The extension stores no config or cache of its own; all settings live in pi's native flag system.
- Process execution is limited to local notification/sound utilities via `execFile` with argument arrays (no shell, errors swallowed so notifications never break the agent): `which`/`where`, `powershell.exe`, `osascript`, `notify-send`, `rundll32.exe`, `canberra-gtk-play`, `paplay`, `afplay`. Falls back to terminal escape sequences (Kitty `OSC 99`, otherwise `OSC 777`) and `BEL` when no desktop session is present.
- User-controlled text (the last assistant message preview) is escaped before reaching a shell-adjacent interface: PowerShell single-quote context (`psQuote`), AppleScript double-quote context (`appleScriptQuote`), or `notify-send` via argument array. No injection surface found.
- Local patches (this repo only): `import type` specifiers and `peerDependencies` migrated from `@mariozechner/pi-*` to `@earendil-works/pi-*` so the vendored sources typecheck and load under this package's pi runtime. `assets` dropped from `files` since the preview image is not vendored. Additionally, macOS sound is patched to play a distinct system sound per outcome via `afplay` (`Glass` on success, `Basso` on error) instead of the single `osascript beep`, so failures are audible — upstream's README explicitly invites this edit. Override the sound names with `PI_NOTIFY_SUCCESS_SOUND` / `PI_NOTIFY_ERROR_SOUND` (any name in `/System/Library/Sounds/`, e.g. `Hero`, `Submarine`, `Funk`); missing sound falls back to `beep`. Linux/Windows unchanged.

Runtime commands: `/notify-test` (or `/notify-test error`) emits a sample notification, `/notify-status` shows the active flags. Flags: `--notify-min-ms`, `--notify-success`, `--notify-error`, `--notify-sound`, `--notify-attention` (all `on`/`off`, default threshold 3000ms). macOS sound names: `PI_NOTIFY_SUCCESS_SOUND` / `PI_NOTIFY_ERROR_SOUND` (default `Glass` / `Basso`).

## Agent SOPs

`agent-sops/` holds the recurring maintenance procedures of this repo in the [Agent SOP format](https://github.com/strands-agents/agent-sop) (`.sop.md`, RFC 2119 constraints). Each SOP was distilled from the git history, including the failure modes hit along the way:

| SOP | Procedure |
|-----|-----------|
| `add-pi-extension` | Add a new extension under `extensions/` following repo conventions (kill-switch env vars, `/command` inspection, deliberate-failure verification) |
| `vendor-pi-extension` | Review and vendor a third-party pi extension (source pinning, gitHead check, network/write-path audit, documented patches) |
| `bump-pi-baseline` | Track a new pi runtime version (devDeps bump, vendored type-surface audit, patch re-evaluation, runtime re-verification) |

### Using them from Claude Code

Three pieces are committed to this repo, so teammates get everything after approving on first open:

1. **`.claude/skills/`** holds Agent Skills generated from the local SOPs (via `strands-agents-sops skills`), so Claude Code picks them up as project skills with no extra install — including autonomous selection when a task matches. Regenerate after editing any SOP with `npm run sops:skills`.
2. **`.claude/settings.json`** enables the official `agent-sops@agent-sop` plugin from the `strands-agents/agent-sop` marketplace. It provides the `agent-sop-author` skill for writing/updating SOPs, its `validate-sop.sh` format validator, and the upstream built-in SOPs (`code-assist`, `pdd`, ...) as skills.
3. **`.mcp.json`** additionally serves the same SOPs as MCP prompts via `uvx` (requires [uv](https://docs.astral.sh/uv/)): `/project-sops:add-pi-extension` etc. This reads `agent-sops/*.sop.md` live, which is handy while iterating on an SOP before regenerating skills. Optional — decline the server approval if uv is not available.

Other MCP-capable tools (Kiro, Cursor, etc.) can point the same server command at this directory; see the upstream README for per-tool syntax.

### Authoring and validation

Create or edit SOPs with the `agent-sop-author` skill (ask Claude Code to "create an SOP for ..."). Every change must pass the official validator shipped with the plugin, then be regenerated into skills:

```bash
bash ~/.claude/plugins/cache/agent-sop/agent-sops/*/skills/agent-sop-author/validate-sop.sh agent-sops/<name>.sop.md
npm run sops:skills
```

(Invoke the validator via `bash`; the script's `/bin/bash` shebang does not resolve on NixOS.)

The `agent-sops/*.sop.md` files are the single source of truth; `.claude/skills/` is generated output and only local SOPs are copied there — upstream built-ins stay out to avoid duplicating the plugin's skills.

## Develop

Extensions are TypeScript, loaded by pi via jiti — no build step. To try one without installing:

```bash
pi -e ./extensions/nix-verify/index.ts
```

Editor types and typecheck:

```bash
npm install
npm run typecheck
```

To work against a local checkout instead of the pinned git ref, point settings at the directory:

```json
{
  "packages": ["/path/to/pi-config"]
}
```

## Layout rules

- `extensions/`: one directory per extension with an `index.ts` entry point; single `.ts` files also load.
- `prompts/`: `.md` prompt templates.
- No secrets in this repository. API keys and machine-specific settings live outside (managed separately via Nix/sops).

## License

MIT
