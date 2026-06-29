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
| `extensions/providers/` | extension | Registers the Command Code model provider |
| `vendor/pi-rtk-optimizer/` | vendored extension | RTK command rewriting and tool output compaction for `bash`, `read`, and `grep` |
| `vendor/pi-ollama-cloud-provider/` | vendored extension | Reviewed copy of `pi-ollama-cloud-provider@0.3.0`, registered as `ollama-cloud` |
| `prompts/` | prompt templates | Empty for now |

## GitHub Copilot Context

Pi already loads `AGENTS.md` and `CLAUDE.md` as native context files. This package additionally mirrors GitHub Copilot repository instructions by appending `.github/copilot-instructions.md` and `.github/instructions/**/*.instructions.md` when they exist. It also exposes `.github/skills/*/SKILL.md` through Pi's native skills loader, so skill bodies stay on-demand instead of always-on. Disable the instruction loader with `PI_COPILOT_INSTRUCTIONS_DISABLE=1`, or the skills bridge with `PI_COPILOT_SKILLS_DISABLE=1`.

## Providers

This package registers two providers:

- `commandcode`: discovers models from Command Code's Provider API and uses `CMD_API_KEY` by default. `COMMAND_CODE_API_KEY` and `COMMANDCODE_API_KEY` are also accepted.
- `ollama-cloud`: connects directly to Ollama Cloud at `https://ollama.com/v1` using `OLLAMA_CLOUD_API_KEY` or pi auth storage. It does not require or assume a local Ollama server.

Set `CMD_ZDR=1` to send Command Code's zero-data-retention header. `opencode` / `opencode-go` are already built into pi; set `OPENCODE_API_KEY` for those.

If none of the provider API keys are configured, pi will report no available models. That is expected; this package does not fall back to local Ollama.

Local Ollama is intentionally not auto-registered here. If local Ollama is needed later, use a separate explicit provider or Ollama's own pi integration so `localhost:11434` is never assumed by this package.

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
