# Local patch inventory

Baseline: `@quintinshaw/pi-dynamic-workflows@3.5.0`, upstream tag `v3.5.0`,
commit `356ea76836d04bcd2e9cbc09b289d5f18f732c65`.

## Provenance and source-only packaging

- Pinned the npm tarball by SHA-1, SHA-512 integrity, and tarball SHA-256 in
  `package.json`. npm registry signature and SLSA provenance metadata were
  verified; the published executable sources, skills, README, LICENSE, and
  package metadata are byte-identical to the tagged commit.
- Preserved the upstream README, contributing guide, and package lock as
  `UPSTREAM-*` evidence. The upstream lock records the reviewed dependency
  graph but is not used for installation; the repository root lock is the
  runtime authority.
- Did not vendor upstream `AGENTS.md`, because placing repository instructions
  inside this workspace would affect the auditing agent rather than the
  extension runtime.
- Omitted upstream `dist/` and remote README media. Pi loads the reviewed
  TypeScript entry directly, so a second generated implementation would create
  stale executable authority. Removed package exports and publishing metadata
  that referred to the absent build, and made the retained `build` check
  type-only so standard tests cannot recreate an unreviewed `dist/` tree.
- Marked the local package private and pinned its runtime packages exactly to
  `acorn@8.16.0` and `typebox@1.2.8`. Pi development packages and test tooling
  are exact local versions rather than `latest` ranges.
- Removed active-runtime imports of the unhashed metadata `package.json`.
  Runtime versioning uses the manifest-covered `src/version.ts`; the release
  gate still compares that reviewed constant with package metadata.

## Custom-code trust boundary

- Treat raw, saved, and resumed workflow scripts as arbitrary same-user Node.js
  code. Node `vm` is retained as the language runtime but is not represented as
  a security sandbox; workflow code can escape it and reach host capabilities.
- Centralized a fail-closed confirmation that displays the complete script and
  explicitly states its arbitrary Node.js authority. Built-in curated workflows
  do not prompt. Custom execution without a confirmation-capable UI is rejected.
- Snapshot confirmation inputs before the first asynchronous UI wait and render
  control, bidi, zero-width, combining, tab, line-feed-in-label, and literal
  escape-like text unambiguously. Approval evidence is module-private, opaque,
  exact-script-bound, and one-shot; structurally forged objects and replay fail.
- Require equivalent opaque one-shot registry provenance for built-ins. A
  caller-provided `source: "builtin"` value is never authority, including in
  compatibility mode. Start, cold resume, and navigator restart bind the
  registry-derived script, immutable args, tools/toolset, and built-in name;
  persisted display metadata is re-parsed from the authorized script.
- Applied the same decision to the workflow tool, saved slash commands,
  `/workflows` execution and restart paths, workflow-control resume, and resumed
  persisted custom runs. UI-less automatic resume is disabled for custom code.
- Reject all in-script `workflow(...)` nesting in the hardened manager because a
  saved, computed, or argument-supplied child script is absent from the parent's
  exact-script approval. Child logic must be written directly in the approved
  parent script; the provider-visible schema and authoring skills state the same
  rule so generated workflows do not target a blocked capability.
- Made built-in names authoritative over saved names and refused registration of
  a saved slash command that collides with a built-in. Repository/user state can
  no longer shadow `/deep-research` or `/code-review`.
- Changed keyword arming to default off. It remains an explicit user setting;
  standing effort mode and direct commands are unaffected.

## Network and subagent authority

- Removed native/global `fetch` fallback from dynamic web tools. The extension
  composition root injects the reviewed `pi-smart-fetch` public HTTP boundary,
  with bounded body size and deadline, textual MIME policy, redirect re-checks,
  pinned public DNS resolution, and private/special-network rejection.
- Pinned the complete four-file sibling HTTP import closure (`constants.ts`,
  `types.ts`, `safe-http.ts`, and `public-http.ts`) by SHA-256 in the vendor
  metadata and policy test rather than trusting import path strings alone.
- Restricted `/deep-research` to a named web-only toolset. It does not receive
  coding, filesystem, or shell tools. Unknown persisted toolsets fail explicitly
  instead of widening to the default coding tools.
- Revalidate search-result URLs through the shared public URL policy. Pi
  cancellation propagates instead of being converted into a successful result.

## Filesystem, project trust, and process boundaries

- Removed all migration reads and writes under repository-local
  `.pi/workflows/{runs,saved}`. Project-scoped state now lives only under the
  user's workflow home in a stable cwd-derived namespace.
- Centralized safe run IDs: 1–128 ASCII letters, digits, dots, underscores, or
  hyphens, beginning with an alphanumeric. All load/save/delete/lease paths and
  directory listings validate both the filename and embedded run ID.
- Set workflow state directories to mode `0700` and JSON, temporary, backup,
  lock, and log files to `0600`, including correction when an existing artifact
  is next touched. Permission failures remain visible.
- Load project-owned `.pi/agents` only when Pi marks the project trusted. Even
  then, realpath and symlink containment prevent definitions from escaping the
  trusted project root; untrusted project definitions cannot shadow user agents.
- Worktree isolation now fails closed when Git setup is unavailable or
  conflicting. It never silently executes in the shared checkout, and an
  explicitly restricted toolset remains restricted inside the worktree.
- Hardened `/code-review` revision ranges against Git option injection: a range
  beginning with `-` is rejected and `git diff` uses `--end-of-options` plus a
  terminating pathspec separator.
- Removed broad startup-recovery error swallowing so corrupted or unsafe state
  fails visibly rather than masquerading as a successful recovery.

## Residual authority

Approval is an authority decision, not sandboxing. Once approved, custom
workflow code can access files, environment values, processes, and network
interfaces available to the current operating-system user, including through
Node internals not exposed as Pi tools. Only approve scripts whose complete text
you trust, and disable this extension where that authority is inappropriate.

The installed Pi entrypoint always enables the hardened `WorkflowManager`
policy. Upstream-compatible low-level `runWorkflow` exports and a non-enforcing
manager mode remain in the source distribution for tests and non-host embedders;
they can execute custom or nested code without this UI approval boundary and
must not be treated as the installed extension's security contract. Workflow
state has owner-only permissions but is not a cryptographically authenticated
or tamper-evident audit log. A same-user process can alter persisted arguments,
journal results/store deltas, and budget metadata; cold resume may consume those
values after structural validation. Treat persisted state as an operational
cache, not as trusted audit evidence.
