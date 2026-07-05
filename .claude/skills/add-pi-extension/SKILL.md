---
name: add-pi-extension
description: This SOP guides adding a new TypeScript extension to the pi-config package, following the conventions established by the existing extensions (`nix-verify`, `copilot-instructions`, `autonomy-scaffold`, `providers`): one directory per extension, environment-variable kill switches, a runtime inspection command, typecheck as the only static gate, and end-to-end verification driven by a deliberate failure case. Use it whenever a new extension is added to `extensions/`.
---

# Add Pi Extension

## Overview

This SOP guides adding a new TypeScript extension to the pi-config package, following the conventions established by the existing extensions (`nix-verify`, `copilot-instructions`, `autonomy-scaffold`, `providers`): one directory per extension, environment-variable kill switches, a runtime inspection command, typecheck as the only static gate, and end-to-end verification driven by a deliberate failure case. Use it whenever a new extension is added to `extensions/`.

## Parameters

- **extension_name** (required): Kebab-case name of the extension. Becomes the directory `extensions/<extension_name>/` and the prefix for its environment variables and slash command.
- **extension_purpose** (required): One-paragraph description of what the extension hooks into and what behavior it adds (e.g. "runs Nix checkers on every .nix edit and feeds STOP diagnostics back to the agent").
- **activation_policy** (optional, default: "opt-out"): "opt-out" means the extension is active by default and disabled with `PI_<NAME>_DISABLE=1` (like `copilot-instructions`, `nix-verify`). "opt-in" means it is inactive by default and enabled with `PI_<NAME>_ENABLE=1` (like `autonomy-scaffold`).

**Constraints for parameter acquisition:**
- If all required parameters are already provided, You MUST proceed to the Steps
- If any required parameters are missing, You MUST ask for them before proceeding
- When asking for parameters, You MUST request all parameters in a single prompt
- When asking for parameters, You MUST use the exact parameter names as defined

## Steps

### 1. Survey Prior Art

Check whether the capability already exists before writing new code, and pick the closest existing pattern to mirror.

**Constraints:**
- You MUST search existing pi extensions (this repo's `extensions/` and `vendor/`, plus published pi extensions) for the capability first, because `nix-verify` was only written after confirming no existing pi extension analyzes `.nix` files
- You MUST read at least one existing extension in `extensions/` before writing code so that structure, naming, and logging conventions carry over
- You SHOULD identify one extension as the structural template and note it in the commit message (e.g. `nix-verify` mirrors pi-lens's verification-loop pattern)

### 2. Scaffold the Extension

Create the extension directory and entry point.

**Constraints:**
- You MUST create `extensions/<extension_name>/index.ts` as the entry point, because pi loads one directory per extension with an `index.ts` entry (single `.ts` files also load, but the directory form is the repo convention)
- You MUST NOT add a build step or compiled artifacts, because pi loads TypeScript directly via jiti and the repo has no build pipeline

### 3. Implement Repo Conventions

Wire in the kill switch, runtime command, and safety guards that every extension in this repo carries.

**Constraints:**
- You MUST implement the kill switch matching activation_policy: `PI_<NAME>_DISABLE=1` for opt-out extensions, `PI_<NAME>_ENABLE=1` for opt-in extensions
- If you add a narrowing variable (like `PI_AUTONOMY_SCAFFOLD_ONLY`), You MUST keep the master enable switch authoritative and document that the narrowing variable alone does nothing, because a filter variable that silently activates a feature is confusing to operators
- If the extension modifies the system prompt, You MUST guard the injected block with markers (e.g. `<autonomy_scaffold>`) so the modification is idempotent, because the hook runs on every agent start and the block would otherwise duplicate
- If the extension runs checks on file edits, You MUST keep the per-edit hook fast (parse/format level) and put slower whole-project checks behind an on-demand command flag, because `nix flake check`-style evaluation is too slow for every edit (`nix-verify` keeps `--flake` on demand for this reason)
- You SHOULD register a `/<extension_name>` command that reports runtime status, matching `/nix-verify`, `/rtk`, `/ollama-cloud`, and `/autonomy-scaffold`

### 4. Typecheck

Run the static gate.

**Constraints:**
- You MUST run `npm install` (first time) and `npm run typecheck` and fix all errors, because with no build step the typecheck is the only static verification before runtime

### 5. Verify End-to-End with a Deliberate Failure

Load the extension in pi and prove the behavior fires, not merely that nothing errors.

**Constraints:**
- You MUST load the extension with `pi -e ./extensions/<extension_name>/index.ts` and exercise its trigger
- You MUST verify using a deliberately induced failure case (e.g. `nix-verify` was proven with an intentional Nix syntax error and later with a deliberately mis-formatted file, observing blocking STOP diagnostics both times)
- You MUST confirm the check actually fired rather than concluding success from silence, because the `nix-verify` format check silently no-op'd in repos whose formatter is only reachable via `nix fmt` — absence of a diagnostic is not proof the check ran
- You SHOULD also verify the kill-switch environment variable actually disables or enables the extension

### 6. Document

Record the extension in the README.

**Constraints:**
- You MUST add a row to the "What's inside" table in `README.md` and, for non-trivial extensions, a dedicated section documenting every environment variable
- You MUST NOT commit secrets or machine-specific settings, because API keys and host settings live outside this repository (managed via Nix/sops)

## Examples

### Example: Verification-loop extension

**Input:**
- extension_name: "nix-verify"
- extension_purpose: "On every edit/write of a .nix file, run available Nix checkers and feed blocking STOP diagnostics back to the agent"
- activation_policy: "opt-out"

**Expected Behavior:**
Agent surveys existing pi extensions, finds no .nix analyzer, mirrors the pi-lens verification-loop pattern, implements `PI_NIX_VERIFY_DISABLE=1` and `/nix-verify`, keeps `nix flake check --no-build` behind `/nix-verify --flake`, typechecks, then proves the loop by introducing a deliberate Nix syntax error and watching the agent self-correct from the diagnostics alone. Finally adds the README table row and section.

## Troubleshooting

### The check never fires during verification
Confirm the underlying tool is actually on PATH and the code path is reached; the historical failure mode here was a format check that silently no-op'd when the formatter was only available via `nix fmt`. Add a fallback (as `nix-verify` did with `nix fmt -- --check`) or a diagnostic log line, then re-verify with the deliberate failure case.

### Typecheck fails on pi APIs
The devDependency baseline (`@earendil-works/pi-coding-agent`, `pi-tui`) may be older than the runtime pi you are targeting. Follow the `bump-pi-baseline` SOP instead of loosening types locally.
