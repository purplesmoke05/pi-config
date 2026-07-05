# Bump Pi Baseline

## Overview

This SOP guides updating the dev/test baseline of pi-config after the runtime pi version changes (typically after a dotnix derivation bump). It encodes the procedure from the 0.79.10 → 0.80.2 bump: bump devDependencies, audit vendored extensions for type-surface drift, re-evaluate whether local patches are still needed, re-verify patched runtime behavior, and update the documented baseline. Run it on every pi release this package should track.

## Parameters

- **target_version** (required): The pi runtime version to track (e.g. "0.80.2"). devDependencies `@earendil-works/pi-coding-agent` and `pi-tui` are bumped to this version.

**Constraints for parameter acquisition:**
- If all required parameters are already provided, You MUST proceed to the Steps
- If any required parameters are missing, You MUST ask for them before proceeding
- When asking for parameters, You MUST request all parameters in a single prompt
- When asking for parameters, You MUST use the exact parameter names as defined

## Steps

### 1. Bump devDependencies

Update the pinned development baseline.

**Constraints:**
- You MUST bump `@earendil-works/pi-coding-agent` and `pi-tui` in `package.json` to target_version and run `npm install`
- You MUST confirm the actual runtime pi version matches target_version (e.g. `pi --version`), because typechecking against a version the runtime does not use verifies nothing

### 2. Audit Vendored Extensions

Check every vendored copy against the new type surface.

**Constraints:**
- You MUST verify, for each extension under `vendor/`, whether the public extension/TUI type declarations it uses changed between the old and new pi versions (the 0.80.2 bump recorded: unchanged between 0.79.10 and 0.80.2 for rtk-optimizer)
- You MUST update vendored `package.json` peer ranges that exclude target_version, because upstream ranges lag behind pi releases and an excluded range breaks loading

### 3. Re-evaluate Local Patches

Check whether each local patch is still needed.

**Constraints:**
- You MUST re-test the condition each local patch works around, because upstream may have absorbed the fix — at 0.80.2, pi-ai started exporting `./compat`, so the pi-web-access local patch was removed rather than carried forward
- You MUST remove patches whose upstream condition is fixed, because stale patches accumulate merge burden and can mask upstream behavior changes
- You SHOULD record removed patches in the commit message so the history explains why they disappeared

### 4. Re-verify

Run the static and runtime gates.

**Constraints:**
- You MUST run `npm run typecheck` across the package including `vendor/**`
- You MUST re-verify patched runtime behavior, not just types, because type compatibility does not prove behavior survived the bump (the ollama-cloud effort-control patch was re-verified via its runtime `thinkingLevelMap` check at 0.80.2)
- You SHOULD smoke-test the runtime commands of affected extensions (`/rtk`, `/ollama-cloud`, `/nix-verify`)

### 5. Update Documentation

Record the new baseline.

**Constraints:**
- You MUST update the "Smoke-tested with runtime `pi` X / Development typecheck uses ... X" line in `README.md` to target_version
- You SHOULD summarize what was re-verified in the commit message, following the format of commit 8669250 ("Bump dev/test baseline to pi 0.80.2")

## Examples

### Example: Tracking a new pi release

**Input:**
- target_version: "0.80.2"

**Expected Behavior:**
Agent bumps `pi-coding-agent`/`pi-tui` devDeps from 0.79.10 to 0.80.2, confirms the rtk-optimizer type surface is unchanged, discovers pi-ai now exports `./compat` and removes the obsolete pi-web-access patch, re-runs typecheck and the ollama-cloud `thinkingLevelMap` runtime check, then updates the README baseline line and writes a commit message summarizing what was re-verified.

## Troubleshooting

### Typecheck breaks inside vendor/ after the bump
The new pi version changed a public type surface a vendored extension uses. Diff the relevant declaration files between versions to scope the change, then patch the vendored copy minimally and document the patch per the `vendor-pi-extension` SOP.

### Runtime pi and devDependency versions drift apart
If the Nix-managed runtime pi is bumped without this SOP running (or vice versa), extensions may typecheck against APIs the runtime lacks. Treat the README baseline line as the source of truth and re-run this SOP end to end for the runtime's actual version.
