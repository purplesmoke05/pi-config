# Vendor Pi Extension

## Overview

This SOP guides reviewing and vendoring a third-party pi extension under `vendor/` instead of installing it from npm. It encodes the review procedure used for `pi-rtk-optimizer@0.8.3` and `pi-ollama-cloud-provider@0.3.0`: source-integrity pinning, a supply-chain audit, minimal documented local patches, typecheck wiring, and README vendor notes. Use it whenever a third-party extension needs to run inside this package.

## Parameters

- **package_name** (required): The npm package or extension name to vendor (e.g. "pi-rtk-optimizer").
- **upstream_source** (required): Upstream location(s) — npm package name/version and/or git repository URL.
- **vendor_reason** (required): Why vendoring is needed instead of `pi install npm:...` (e.g. "published peer dependency range stops at pi 0.79 while this package targets 0.80.2", or "security review required before granting it tool access").

**Constraints for parameter acquisition:**
- If all required parameters are already provided, You MUST proceed to the Steps
- If any required parameters are missing, You MUST ask for them before proceeding
- When asking for parameters, You MUST request all parameters in a single prompt
- When asking for parameters, You MUST use the exact parameter names as defined

## Steps

### 1. Confirm Vendoring Is Warranted

Validate the vendor_reason against the alternatives.

**Constraints:**
- You MUST confirm plain installation is insufficient (peer range incompatibility, needed local patches, or review requirement) and record the reason, because vendored copies carry an ongoing maintenance cost on every pi baseline bump
- You SHOULD prefer `pi install npm:...` when no patches or review gates are needed, because unvendored packages update themselves

### 2. Verify Source Integrity

Pin exactly what code is being reviewed.

**Constraints:**
- You MUST pin and record the upstream commit hash the vendored copy corresponds to (rtk-optimizer is pinned to `78b8f8a0...`)
- If vendoring from an npm tarball, You MUST verify the tarball's `gitHead` matches the upstream repository's tag/HEAD commit, because a tarball that does not match its public source is a supply-chain red flag (this was checked for `pi-ollama-cloud-provider`: gitHead matched `ea57d52e...`)

### 3. Audit the Code

Review what the extension can reach.

**Constraints:**
- You MUST check the package for runtime dependencies and npm install scripts, because install scripts execute arbitrary code at install time (`pi-ollama-cloud-provider` passed: none of either)
- You MUST enumerate every network and process target and record them (rtk-optimizer: local `which`/`where`, `rtk --version`, `rtk rewrite` only; ollama-cloud: `https://ollama.com` and `https://models.dev/api.json`)
- You MUST document all filesystem write locations such as config and cache paths (e.g. `~/.pi/agent/extensions/<name>/config.json`, `~/.pi/agent/cache/<name>/`)

### 4. Apply Minimal Local Patches

Adapt the vendored copy to this package.

**Constraints:**
- You MUST patch the vendored `package.json` peer range when it excludes the current pi baseline, because upstream ranges lag behind pi releases (this is what forced vendoring rtk-optimizer in the first place)
- You MUST document every local patch and the user-visible problem it fixes, because undocumented patches get silently lost on re-vendoring (e.g. the ollama-cloud effort-control patch exists because pi showed an ineffective `off`..`high` reasoning picker that never reached the API)
- You SHOULD keep patches minimal and behind escape hatches (e.g. `PI_OLLAMA_CLOUD_NO_EFFORT=1`) so upstream behavior stays reachable

### 5. Wire Into the Package

Register the vendored extension.

**Constraints:**
- You MUST add the vendored entry point to `package.json` so pi loads it
- You MUST ensure `vendor/**/*.ts` is included in the tsconfig typecheck scope, because vendored code that escapes typecheck breaks silently on baseline bumps
- You MUST add any new peer/dev dependencies the vendored code needs (e.g. `pi-tui`)

### 6. Document Vendor Notes

Write the review results into the README.

**Constraints:**
- You MUST add a "Vendor Notes" section to `README.md` covering: pinned upstream commit, audit results (deps/install scripts), network and process targets, filesystem write locations, and every local patch with its reason
- You SHOULD document the runtime inspection command if the extension provides one (`/rtk`, `/ollama-cloud`)

### 7. Verify

Prove the vendored copy works on the current baseline.

**Constraints:**
- You MUST run `npm run typecheck` with the vendored sources included
- You MUST verify patched behavior at runtime, not only at the type level (the effort-control patch was verified by checking the built `thinkingLevelMap` at runtime)
- You SHOULD exercise the extension's runtime command as a smoke test

## Examples

### Example: Vendoring a provider extension

**Input:**
- package_name: "pi-ollama-cloud-provider"
- upstream_source: "npm pi-ollama-cloud-provider@0.3.0, github.com/<owner>/pi-ollama-cloud-provider"
- vendor_reason: "Review required before wiring a network-facing provider; local compatibility patches needed for the current pi runtime"

**Expected Behavior:**
Agent verifies the npm tarball gitHead matches the upstream tag, finds no runtime deps or install scripts, records network targets (`ollama.com`, `models.dev`) and cache paths, applies documented compat patches with an escape-hatch env var, includes the sources in typecheck, writes README vendor notes, and verifies at runtime via `/ollama-cloud`.

## Troubleshooting

### npm tarball gitHead does not match upstream
Stop and investigate before vendoring: diff the tarball contents against the upstream tag. If the difference is unexplained, do not vendor the package and report the mismatch to the user, because this is the primary supply-chain signal this SOP exists to catch.

### Typecheck fails only in vendored sources after a pi bump
The upstream types drifted from the pinned copy. Re-run the compatibility audit from the `bump-pi-baseline` SOP: diff the public extension/TUI type declarations between the two pi versions before patching vendored code.
