# pi-config

Personal customizations for the [pi coding agent](https://pi.dev/): extensions, prompt templates, and reviewed provider integrations, packaged as a [pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

Smoke-tested with runtime `pi` 0.83.0. The reproducible development typecheck and policy-test baseline uses `@earendil-works/pi-coding-agent` 0.80.10.

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
| `vendor/pi-extension-workbook/` | vendored extension + skill | Audited copy of `@firstpick/pi-extension-workbook@0.1.4`; bounded XLSX/XLSM inspection, reading, rendering, editing, diffing, and validation with `/workbook-doctor` |
| `vendor/pi-smart-fetch/` | vendored extension | Hardened source copy of `pi-smart-fetch@0.3.17`; public-network-only `web_fetch` / `batch_web_fetch` with pinned DNS, bounded bodies and no hidden extractor requests |
| `vendor/pi-smart-web-search/` | vendored extension | Hardened source copy of `pi-smart-web-search@0.4.0`; fixed-endpoint DuckDuckGo search with public-link filtering and explicit untrusted-data boundaries |
| `vendor/rpiv-ask-user-question/` | vendored extension | Audited copy of `@juicesharp/rpiv-ask-user-question@2.3.1`; structured multi-question overlays with reviewed local config and external-editor bridges |
| `vendor/context-mode/` | vendored extension + skills | Modified, audited `context-mode@1.0.169`; local MCP execution/index/search with update/install paths removed and strict child-process boundaries |
| `vendor/pi-dynamic-workflows/` | vendored extension + skills | Modified, audited `@quintinshaw/pi-dynamic-workflows@3.5.0`; explicitly approved JavaScript orchestration, resumable subagents, fail-closed worktrees, and restricted web research |
| `vendor/pi-powerline-footer/` | vendored extension | Reviewed copy of `pi-powerline-footer@0.6.1`; powerline-style status bar with configurable status-item placement |
| `vendor/pi-tool-display/` | vendored extension | Reviewed copy of `pi-tool-display@0.5.0`; compact tool-call rendering, diff visualization, and output truncation, with the upstream postinstall hook removed |
| `agent-sops/` | Agent SOPs | Recurring maintenance procedures for this repo as [Agent SOPs](https://github.com/strands-agents/agent-sop), served to Claude Code via `.mcp.json` |
| `prompts/` | prompt templates | Empty for now |

## GitHub Copilot Context

Pi already loads `AGENTS.md` and `CLAUDE.md` as native context files. This package additionally mirrors GitHub Copilot repository instructions. `.github/copilot-instructions.md` is snapshotted at session start and remains in the system prompt. Files under `.github/instructions/**/*.instructions.md` are kept out of the system prompt until their `applyTo` glob matches an initial `@file` attachment or a later `read`, `edit`, or `write` path. A matching file is injected once as user context and then remains in the conversation; Pi displays a compact `Copilot instructions activated` row with the matched instruction filenames without rendering the instruction body. This preserves the stable system-prompt prefix used by provider prompt caching. Quoted comma-separated `applyTo` values and YAML lists are supported. Instructions without `applyTo` remain inactive.

The extension also exposes `.github/skills/*/SKILL.md` through Pi's native skills loader, so skill bodies stay on-demand instead of always-on. Disable the instruction loader with `PI_COPILOT_INSTRUCTIONS_DISABLE=1`, or the skills bridge with `PI_COPILOT_SKILLS_DISABLE=1`.

## GitHub Copilot Usage

`extensions/copilot-usage/` is active only when the current model's provider is exactly `github-copilot`. It adds a compact `Copilot` status through `ctx.ui.setStatus()`, so it composes with the built-in footer and `pi-powerline-footer` instead of replacing either one. Switching to another provider clears the status, detailed report, and first-request context widget.

For a new conversation, the first Copilot provider request shows a temporary widget with local token estimates for the observed request payload, system prompt, tool schemas, remaining conversation/framing payload, and each unique detected file path; repeated blocks with the same source and path are aggregated. The system line separates base/other text, native automatic context (`AGENTS.md` and `CLAUDE.md`), repository-wide GitHub Copilot instruction context, and the available-skills catalog; `applyTo`-activated instruction files are listed too, but their tokens remain in `rest` because they are user context rather than system content. Tool schemas are outside the system prompt and remain a separate value. Per-file estimates include the detected text tag and wrapper actually sent. Image bytes use the request-level 1,200-token heuristic and remain in `rest` because Pi exposes no path-to-image provenance. Overflow files are folded into a count plus token subtotal so both automatic context and prompt files remain visible within Pi's ten logical lines.

Every preflight and per-file value is marked `≈`: Pi exposes no provider tokenizer or component-level usage, so the widget uses the same conservative text heuristic described below rather than presenting characters as exact tokens. Normal turns use Pi's structured native context metadata; custom turns without that event fall back to tag scanning. Pi flattens `@file` inputs into `<file name="…">` text and exposes no structured origin metadata to extensions, so prompt-file and fallback detection are heuristic rather than provenance guarantees; manually authored identical markup, literal matching closing tags inside file content, and an image marker whose bytes were omitted are inherently ambiguous. File lines escape terminal control characters and middle-truncate the path so the full line stays within 80 terminal columns while retaining the filename suffix. The widget remains through the first agent run and is cleared when the next user message starts, including queued steer/follow-up messages. Skill bodies are not included because Pi loads them on demand; only the skills catalog in the system prompt is counted. Resumed conversations that already contain an assistant response do not show the widget again.

The status separates values with different confidence levels:

- While idle, `next base≈… tok` estimates the system prompt, active tool schemas, and current context. It is a preflight baseline for the next call; text still sitting unsent in the editor is not part of Pi's extension context yet.
- Once a prompt has been submitted and Pi reaches the HTTP boundary, `sending≈… tok` estimates the final provider payload using a conservative heuristic: ASCII characters divided by four, non-ASCII code points multiplied by two, and 1,200 tokens per image, with Pi's own context estimate as a floor. Pi has no provider tokenizer at this hook, so this is deliberately marked as an estimate; image cost remains model/resolution dependent and base64 bytes are not counted as text.
- `branch ≈… cr, … in/… out tok` is cumulative for the active branch. Input combines uncached input, cache reads, and cache writes reported across Copilot calls; repeated conversation history is therefore counted again on later calls. Output is the provider's token count for AI-generated text, reasoning, and tool calls, not a character count. Tool execution results become input on a later call instead of output.
- The branch credit value is a local gross list-price estimate (`1 AI credit = $0.01`). It uses the cost Pi stored with each response and applies known GitHub long-context tiers from the pricing snapshot linked in the report. It is not GitHub's authoritative net bill. Credit appears before the cumulative token totals so narrow terminals retain the cost signal first.

Pi's built-in footer remains separate: its `↑` is session-wide uncached input, `R`/`W` are cache buckets, and `↓` is session-wide output. The Copilot status avoids those arrows because its active-branch scope and combined input buckets are different.

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

## Workbook Extension Vendor Notes

`@firstpick/pi-extension-workbook@0.1.4` is vendored under `vendor/pi-extension-workbook/` instead of being installed as an opaque npm package because it can read and mutate arbitrary workbook paths and therefore requires source and dependency review before it is loaded with this package.

Review notes:

- The npm tarball is pinned by SHA-1 `bf061fadd84091a71ce13a9d998098582aa583ef` and SHA-512 `DCx8f6keARW19Zpm/C+1k2edzDPYH4LnzqupJzOJdppW4MDYs/qIkZIIaslNMIa1CfbMG9ma4aEoy8KSoZRB6g==`. All 46 published files match upstream commit `f14082164d2f8ac22c67daa873a10ff3a22c5092` byte-for-byte. npm records the preceding commit `04f11b44c4d37c64ab8741a9092bba3780b255d9` as `gitHead`; the only package difference between those commits is the `0.1.3` to `0.1.4` version string.
- The upstream lockfile no longer installs reproducibly: its integrity for `@firstpick/pi-utils@0.2.4` differs from the current registry tarball and `npm ci` fails with `EINTEGRITY`. The vendored copy therefore removes that dependency and keeps the small required path, atomic-write, hashing, CRC-32, sync, and bounded process helpers locally. This also avoids loading the utility package's unrelated HTTP, shell, UI, and other exports. Remaining runtime dependencies are pinned exactly to `@xmldom/xmldom@0.9.10` and `fflate@0.8.3`; both are dependency-free at runtime and have no consumer install scripts.
- No runtime network target exists. OOXML namespace URLs are identifiers only, external workbook relationships and hyperlinks are inventoried but never followed, and external data is never refreshed.
- The six registered workbook tools launch no subprocesses. On Windows only, explicit `/workbook-doctor` inspection runs `powershell.exe` with a fixed registry lookup to detect Excel. A disabled feasibility worker can launch `powershell.exe`, Excel COM, and `taskkill.exe`, but it is not selected or exposed by any registered workbook tool; native Excel mutation remains disabled after upstream no-op fidelity failures.
- Input reads are the requested `.xlsx`/`.xlsm`, baseline, and diff paths. Normal edits default to a sibling `<name>.pi-edited.<ext>` file; explicit in-place edits create `<name>.pi-recovery-<timestamp>.<ext>`. Caller-selected output and render directories are honored. Atomic commits briefly create `.pi-sibling-*` and `.tmp` files beside the destination and remove them in `finally`. Other temporary writes use the OS temp directory under `pi-workbook-transaction-*`, `pi-workbook-preview-cache/ooxml-safe-bitmap-v2/`, `pi-workbook-results/<uuid>/`, `.pi-workbook-doctor-*`, and, only for the disabled native worker, `pi-workbook-native-worker-*`. Doctor probes, transaction staging, and native-worker staging are removed; preview cache pruning is bounded to 256 files / 512 MiB, while truncated JSON result artifacts remain until OS temp cleanup.
- The enabled `ooxml-safe` engine rejects path-traversing, encrypted, ZIP64, oversized, over-compressed, DTD/entity-bearing, and relationship-escaping packages. Edits are dry-run by default, require a current SHA-256 to commit, use Pi's destination mutation queue plus durable atomic writes, and validate protected active-content parts after saving. Macros are never parsed, executed, or modified.
- Local safety patch: signed-VBA workbooks are read-only for edits. Upstream includes a pinned BSD-2-Clause signed-VBA fixture and a `PASS_PACKAGE_ONLY` result showing its protected parts remain unchanged, but the same report records controlled Excel UI validation as `SKIP` because it requires interactive Windows. Until an edited signed workbook passes that repair-dialog check, inspect/read/render/diff/validate remain available, but `workbook_edit` fails closed when a VBA signature part is detected.
- Runtime requires Node.js 24 or newer. Use `/workbook-doctor` for dependency, backend, runtime-file, and temp-directory status. Registered tools are `workbook_inspect`, `workbook_read`, `workbook_render`, `workbook_edit`, `workbook_diff`, and `workbook_validate`; the bundled `workbook-editor` skill enforces inspect → read/render → dry-run → hash-guarded commit → validate/diff verification.

## Smart Web Search and Fetch Vendor Notes

`pi-smart-web-search@0.4.0` and its required companion `pi-smart-fetch@0.3.17` are vendored together because both accept untrusted network data, and a plain npm install would neither preserve the reviewed dependency graph nor carry the local SSRF, resource-limit, and credential-boundary patches below.

Review notes:

- Search is pinned to upstream commit `41e061a28e42fba8a8440c2541c1f92f6342456c` and npm SHA-512 `ND08rQytHq5jbacg7g1NNKn5iHsgAYUEOclzNzIQWiRaV7Z4uaXWLbLMu7WslUhrIhT1mJVn373x+GpV73LWxA==`. npm `gitHead` and provenance identify that commit; the published executable sources, README, and LICENSE are byte-identical to it. The published `package.json` differs only because its documented publish workflow removes `prepare: husky`.
- Fetch is pinned to upstream commit `b01116124971de44f16a4477e34c06ba2ab1d0bf` and npm SHA-512 `RgU1hNF4AHdUZcRHbXQ1TfSLWheFCJixzmiTEJEm+Ug4vKxdn6Rb1BRmkZpbuzDDTnkiRJ/KXIxm7zA0NEUBIg==`. npm `gitHead` and provenance identify that commit; all eight project sources embedded in the published source map are byte-identical to the vendored source baseline.
- Runtime imports are exact root pins `typebox@1.2.8`, `defuddle@0.19.2`, and `linkedom@0.18.13`; every transitive artifact is integrity-pinned by `package-lock.json`. None has a consumer install hook. `typebox` was moved from a floating dev/peer-only declaration to the exact production pin because both extensions import it at runtime. Upstream's `wreq-js` native dependency is intentionally not installed: its provenance was valid, but it would execute a non-reproducibly-built platform `.node` file at import time and its resolver cannot pin a reviewed DNS answer to the native connection.
- Supply-chain verification reports registry signatures for all 283 installed packages and provenance attestations for 68. The added production graph has no consumer install script. The root `minimatch@10.2.5` is overridden to fixed `brace-expansion@5.0.9`, and `npm audit --omit=dev` reports zero vulnerabilities. The full development audit still reports `brace-expansion@5.0.6` and `protobufjs@7.6.4` inside `@earendil-works/pi-coding-agent@0.80.10`'s published shrinkwrap, which root overrides cannot replace; neither belongs to the smart web or dynamic-workflows production graph.
- Search network access is limited to `https://html.duckduckgo.com/html/`. Redirects are followed manually only when HTTPS origin and path remain that fixed endpoint, the response body is capped at 1 MiB, and a 12-second operation deadline is enforced around waiting, DNS validation, redirects, and body reading. HTML above 50,000 elements or 256 nesting levels is rejected before parsing; search previews are then built directly from at most ten known DuckDuckGo result nodes instead of passing hostile search markup through Defuddle. Pi's cancellation signal is propagated. Search-result URLs are canonicalized and must resolve entirely to public addresses before they are returned.
- Fetch accepts arbitrary public `http:` / `https:` destinations. The local transport rejects credentials in URLs and loopback, private, link-local, CGNAT, documentation, benchmark, multicast, reserved, Azure WireServer, and IPv4-mapped IPv6 addresses. It validates every DNS answer and pins one validated address into the actual Node HTTP/TLS connection; each request uses a non-pooled socket so a process-global keep-alive connection cannot bypass that lookup. Every HTTP, meta-refresh, and alternate-document hop is revalidated under one operation deadline. Once a cross-origin hop removes `Authorization`, `Cookie`, and `Proxy-Authorization`, later hops cannot restore them. Arbitrary proxies are disabled because they would bypass the connection policy.
- Local resource limits are 5 MiB for textual responses, 50 MiB for files, 50,000 HTML elements, 256 HTML nesting levels, 10 requests per batch, and concurrency 4. `Content-Length` and actual streamed bytes are both checked; cancellation or overflow removes partial files. Downloads are written only below Pi's trusted agent directory at `cache/pi-smart-fetch/downloads/` with directory mode `0700`, exclusive file creation, and file mode `0600`; a filename collision is retried without consuming the response body, and completed downloads remain until manually removed. Global and project Pi settings are read for bounded presentation/fetch defaults, but a project cannot redirect the download directory or raise the hard ceilings.
- Fetch-side Defuddle runs in a terminable worker with async/site-specific network extractors disabled, so synchronous extractor work cannot outlive the operation deadline and a fetched page cannot trigger surprise requests to X/Twitter, Reddit, YouTube, Bilibili, or other extractor APIs. Search no longer invokes Defuddle. No subprocess, dynamic code download, `eval`, or page JavaScript execution exists in either extension.
- Search previews, titles, links, queries, errors, and fetched pages remain untrusted content. The search renderer removes terminal controls, neutralizes every unvalidated Markdown/autolink form, quotes structural fields, filters unsafe links, and surrounds search output with a visible untrusted-data boundary; fetched text also has terminal controls removed before Pi renders it. The shared tool guideline tells the model to ignore instructions found in fetched pages. These measures reduce accidental prompt following but are not a mathematical prompt-injection defense; secrets must never be placed in search queries or fetch headers.
- Local compatibility tradeoff: replacing upstream `wreq-js` with Node's standard HTTP/TLS stack removes browser TLS fingerprint impersonation. This materially reduces native supply-chain and DNS-rebinding risk, but some anti-bot-protected pages may reject `web_fetch`; the extension fails explicitly rather than falling back to an unreviewed browser or downloader. Runtime requires Node.js 24.18.0 or newer.

## Ask User Question Vendor Notes

`@juicesharp/rpiv-ask-user-question@2.3.1` is vendored under `vendor/rpiv-ask-user-question/` so the interactive overlay, configuration reads, and external-editor process launch remain reviewable instead of changing under a floating package install.

Review notes:

- The npm tarball is pinned to upstream commit `75823a68024a0a649cc28087976074be791ca554`, SHA-1 `6b82f3be3fd1ab72d487ccb78dd26397f68e079c`, and SHA-512 `2FeQ3U3GXLNKBU7BBC2wVdBmoBb7Asb7DIJLw5o2ZsHgRttIHEaZD8kLRCIVAUpmQEsC2xywiEaplvZNqWgZgg==`. All 56 published files match that commit, and the npm registry signature was verified.
- The only runtime package import is the root exact pin `typebox@1.2.8`; no install hook, runtime package discovery, download, update check, or network target exists.
- The extension reads optional JSON guidance and collapse-key settings from the XDG config location (normally `~/.config/rpiv-ask-user-question/config.json`) and never writes configuration. Invalid data is ignored in favor of reviewed defaults.
- An external process is launched only when the user explicitly opens a custom answer in `$VISUAL` or `$EDITOR`. The answer is staged in an OS-temp `rpiv-ask-user-question-*` directory, the configured editor runs, and the directory is removed when the editor closes. POSIX uses an argv array without a shell; Windows retains Pi's editor-command behavior.
- Local patches inline the small read-only `rpiv-config` subset, remove optional dynamic `rpiv-i18n` discovery in favor of the bundled canonical English strings, and adapt editor lookup to Pi 0.80.2. This keeps every executable dependency inside the reviewed graph.
- The registered model tool is `ask_user_question`. Local tests pass 6/6, the pinned upstream suite passes 584/584, and the vendored source passes the repository typecheck.

## Context Mode Vendor Notes

`context-mode@1.0.169` is vendored under `vendor/context-mode/` as a modified Elastic License 2.0 work. `NOTICE` prominently identifies the local changes; `source/` contains the exact patched TypeScript and the active Pi/server artifacts are rebuilt from it.

Review notes:

- Upstream is pinned to tag `v1.0.169` and commit `589d8214d56740a28b5f7bf63167743d586b0b40`, with npm SHA-1 `d5aa9acc648ed420c5dd32ee5f15aa5608f09fea` and SHA-512 `94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ==`. npm metadata has no `gitHead`; 352 of 354 clean-build published files match, while the top-level server and CLI bundles vary with the build toolchain. The published bundles are therefore not trusted as source: the committed server and Pi adapter are rebuilt from the tagged source, pinned `bun.lock`, and documented local patch set, with SHA-256 values recorded in the vendored manifest.
- Runtime imports are exact root pins `@mixmark-io/domino@2.2.0`, `turndown@7.2.4`, and `turndown-plugin-gfm@1.0.2`. Node 24's built-in `node:sqlite` with FTS5 is used, so the native `better-sqlite3` package and its install script are not added.
- Runtime version discovery, hourly npm registry access, self-update, automatic installation, Claude plugin-cache symlink repair, and implicit age-based deletion of persistent session/content databases are removed. `ctx_upgrade`, `ctx_insight`, and `ctx_purge` remain unregistered and their skills are not shipped.
- Every active child-process boundary—runtime/`git` probes, the MCP server, compilers, cleanup utilities, and `ctx_execute` children—uses one sanitizer that removes credential-like values, authenticated proxies, `NODE_OPTIONS`, dynamic-loader injection, language startup hooks, compiler substitution, and shell/Git command hooks. `PWD` and `OLDPWD` are deliberately retained. This protects environment values only; HOME files, argv, same-UID process state, and explicitly supplied code remain accessible.
- `ctx_fetch_and_index` is network-active only on an explicit tool call. Pi forces `CTX_FETCH_STRICT=1`; every target and redirect is limited to HTTP(S), loopback/private/link-local/multicast/reserved targets are rejected during preflight and connect-time DNS, proxy variables are removed, redirects are capped at five, and response text is capped at 50 MiB.
- Automatic writes are limited to context-mode-owned SQLite/session/stat files plus process-scoped temp scripts, readiness sentinels, fetch output, and atomic-write staging. Persistent databases are not deleted by a timer. Dead-PID temp SQLite files and the current process's temporary files are still cleaned up. `ctx_index` reads caller-selected paths, `ctx_search` can refresh a previously indexed file, and the enabled executor can read/write any path available to the current Unix/Windows user.
- `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` are not an OS sandbox: model-selected code can launch subprocesses, access the public network, and inspect the user's filesystem. The environment boundary reduces accidental credential inheritance but does not make untrusted code safe. Disable this extension when that authority is inappropriate.
- The curated tool set is `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_fetch_and_index`, `ctx_index`, `ctx_search`, `ctx_stats`, and `ctx_doctor`. The modified upstream suite passes 4,702/4,702 runnable tests with 41 platform/optional skips, and the committed-artifact smoke verifies hashes, lazy bridge startup, exact tool registration, secret stripping, and private-network rejection.

## Dynamic Workflows Vendor Notes

`@quintinshaw/pi-dynamic-workflows@3.5.0` is vendored under `vendor/pi-dynamic-workflows/` because its workflow language executes model- or user-authored JavaScript, launches subagents and Git worktrees, persists scripts and prompts, and can grant network or filesystem tools. Loading it as a floating npm package would make that authority change outside this repository's review boundary.

Review notes:

- Upstream is pinned to tag `v3.5.0` and commit/npm `gitHead` `356ea76836d04bcd2e9cbc09b289d5f18f732c65`. The npm tarball is pinned by SHA-1 `668750d4053e5f446da810139000c916c623d472`, SHA-512 `B/uq11yAxDECfEVL4D/bmO84+Hf/+RrdNEB2z6bnpzkh5yF2zTZiIhuHtZ/Dh2a7EO95xBrjeCPsm220NnFnXg==`, and tarball SHA-256 `b6c248aae5b09dc6d74cdb84367000da7e314cfa101c582a67b35f781cddb42c`. Registry signature and SLSA provenance are present and verified; the published executable source, skills, README, LICENSE, and package metadata match the tag byte-for-byte.
- Runtime packages are exact root pins `acorn@8.16.0` and `typebox@1.2.8`; the four Pi packages used for reproducible development and policy tests are exact `0.80.10`. The system `pi` 0.83.0 loader was also checked against the exact dynamic-workflows command/tool surface. The active implementation is TypeScript source loaded by Pi. Upstream `dist/` is intentionally absent so a stale generated second implementation cannot bypass reviewed patches; the upstream lock is retained as evidence, while the root lock is authoritative.
- Raw, saved, and resumed custom workflows execute only after a confirmation bound to the exact complete script snapshot and identifying it as arbitrary Node.js code. Approval and built-in provenance are opaque one-shot capabilities, so forged objects, replay, mutable-request swaps, and caller-supplied `source: "builtin"` labels do not grant authority. Built-ins are re-derived from the curated registry on start, resume, and UI restart and do not prompt; persisted script, display metadata, or toolset labels are not trusted as provenance. Headless and automatic custom-code resumes fail closed, built-in names cannot be shadowed by saved state, and keyword arming defaults off. In-script `workflow(...)` nesting is disabled because saved, computed, or argument-supplied child code is absent from the parent approval; child logic must be written directly in the approved parent script.
- This confirmation is not sandboxing. After approval, custom workflow code has the same-user Node.js authority to read files and environment values, launch processes, and use network interfaces, including through Node internals outside Pi's tool hooks. Node `vm` is explicitly treated only as a language runtime. Approve only complete scripts you trust; disable the extension where that authority is inappropriate.
- `/deep-research` receives only bounded web search/fetch tools injected through the vendored `pi-smart-fetch` public-network boundary. It receives no coding, filesystem, or shell tools; unknown persisted toolsets fail rather than widening authority. Search and fetch enforce deadlines, byte and MIME limits, redirect revalidation, pinned public DNS, and private/special-network rejection.
- Project `.pi/agents` load only after Pi marks the repository trusted and remain realpath-contained without symlinks. Requested worktree isolation fails instead of falling back to the shared checkout. `/code-review` rejects option-shaped revision ranges and uses Git's end-of-options delimiter.
- State no longer reads or writes repository-local `.pi/workflows`. Project namespaces live under `~/.pi/workflows/`, run IDs are filename-safe and cross-checked against JSON, state directories use `0700`, and scripts/prompts/results/logs/locks use `0600`. Corrupt startup recovery and permission failures remain visible. State is not tamper-evident: a same-user process can alter persisted arguments, journal results/store deltas, and budget metadata consumed by cold resume, so it is an operational cache rather than trusted audit evidence.
- The installed extension always enables the hardened manager boundary. The retained low-level `runWorkflow` API and non-enforcing manager mode exist only for upstream compatibility/tests and are not an approval or sandbox boundary; do not invoke them as a substitute for the installed Pi extension.
- The extension registers `workflow` and `workflow_control`, plus `/deep-research`, `/code-review`, `/codebase-audit`, `/multi-perspective`, `/adversarial-review`, `/workflows`, `/workflows-models`, `/workflows-trigger`, `/workflows-progress`, `/effort`, and `/ultracode`. Provenance, local patches, file manifests, and residual authority are recorded in the vendored `NOTICE`, `SOURCE-PATCHES.md`, and policy test.

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
- No filesystem writes: only `existsSync` reads of the bundled completion sound and three fixed freedesktop fallback paths. The extension stores no config or cache of its own; all settings live in pi's native flag system.
- Process execution is limited to local notification/sound utilities via `execFile` with argument arrays (no shell, errors swallowed so notifications never break the agent): `which`/`where`, `powershell.exe`, `osascript`, `notify-send`, `rundll32.exe`, `pw-play`, `canberra-gtk-play`, `paplay`, `afplay`. Falls back to terminal escape sequences (Kitty `OSC 99`, otherwise `OSC 777`) and `BEL` when no desktop session is present.
- User-controlled text (the last assistant message preview) is escaped before reaching a shell-adjacent interface: PowerShell single-quote context (`psQuote`), AppleScript double-quote context (`appleScriptQuote`), or `notify-send` via argument array. No injection surface found.
- Local patches (this repo only): `import type` specifiers and `peerDependencies` migrated from `@mariozechner/pi-*` to `@earendil-works/pi-*` so the vendored sources typecheck and load under this package's pi runtime. The upstream preview image remains unvendored; `assets` now packages this repo's original completion chime. Linux success notifications prefer that chime through `pw-play` or `paplay`, then retain the upstream fallbacks. Additionally, macOS sound is patched to play a distinct system sound per outcome via `afplay` (`Glass` on success, `Basso` on error) instead of the single `osascript beep`, so failures are audible — upstream's README explicitly invites this edit. Override the sound names with `PI_NOTIFY_SUCCESS_SOUND` / `PI_NOTIFY_ERROR_SOUND` (any name in `/System/Library/Sounds/`, e.g. `Hero`, `Submarine`, `Funk`); missing sound falls back to `beep`. Windows is unchanged.

Runtime commands: `/notify-test` (or `/notify-test error`) emits a sample notification, `/notify-status` shows the active flags. Flags: `--notify-min-ms`, `--notify-success`, `--notify-error`, `--notify-sound`, `--notify-attention` (all `on`/`off`, default threshold 3000ms). Linux success uses `assets/complete.wav`; macOS sound names remain configurable through `PI_NOTIFY_SUCCESS_SOUND` / `PI_NOTIFY_ERROR_SOUND` (default `Glass` / `Basso`).

## Powerline Footer Vendor Notes

`pi-powerline-footer@0.6.1` is vendored under `vendor/pi-powerline-footer/` so the footer extension that replaces pi's built-in status bar stays under this package's review boundary instead of changing under a floating npm install.

Review notes:

- Upstream is pinned to tag `v0.6.1` / commit `3bdc81eb58bcbf6778cb36434642c735b06f0b1b`; the npm registry `gitHead` matches the tag, and the installed source matches the tag (the npm package omits only `banner.png`, `package-lock.json`, and `tests/`).
- No runtime `dependencies`; only `peerDependencies` on pi packages. No npm install scripts.
- No network access: no `fetch`/`http`/`https`/`net`/websocket usage anywhere in the source.
- Process execution is limited to a local `git` spawn for branch/dirty status (`git-status.ts`). Filesystem reads: `~/.pi/agent/settings.json`, theme files, shell history. Filesystem writes: working-vibes cache and stash history under `~/.pi/agent/powerline-footer/`, plus settings writes for preset selection.
- Local patches (this repo only): `peerDependencies` widened to `*` (upstream range stops at pi 0.76); the `complete` import moved to `@earendil-works/pi-ai/compat` (no longer exported from the main entry); type-drift fixes for the current pi baseline — `KeyId`-typed keybindings, the `AutocompleteProvider` interface (async `getSuggestions`), private `Editor` methods (`cancelAutocomplete`, `undo`), the removed `getThinkingLevel` on `ExtensionContext` (degrades to `null`), and a `PowerlineConfig` default that now includes `segmentOptions`.
- Runtime: replaces the built-in footer. `powerline.customItems` in `~/.pi/agent/settings.json` places any extension status key (e.g. `copilot-credit`) at `left`/`right`/`secondary`; `hideWhenMissing` hides it when the key is unset.

## Tool Display Vendor Notes

`pi-tool-display@0.5.0` is vendored under `vendor/pi-tool-display/` because its published package ships a `postinstall` hook that executes a script when installed under `/.pi/agent/extensions/` — an arbitrary-code-execution surface at install time that this package's review boundary should not inherit.

Review notes:

- Upstream is pinned to tag `v0.5.0` / commit `91cef7580078371f8dc49a8607222807ad6a424d`; the npm registry `gitHead` matches the tag, and the installed source matches the tag modulo whitespace (tabs vs spaces) and the excluded `.npmignore`/`package-lock.json`.
- No runtime `dependencies`; only `peerDependencies` on pi packages.
- **Upstream `postinstall` removed**: it ran `../../scripts/patch-vulnerable-deps.mjs` when the install path contained `/.pi/agent/extensions/`. That script is not shipped by the package, so the hook was inert in practice, but it is still a latent code-execution surface; the vendored copy deletes it.
- No network access: no `fetch`/`http`/`https`/`net`/websocket usage anywhere in the source. No subprocess spawns.
- Filesystem: reads config and pending-diff preview files; writes debug logs and config under the pi agent directory.
- Local patches (this repo only): `postinstall` removed; `peerDependencies` widened to `*`; the unused compiled `tool-display-api-consumer.js`/`.d.ts` and its `exports` entry removed; type-drift fixes for the current pi baseline (optional `renderCall`/`context` signatures, `context.cwd` null-safety, `this` typing in the user-message-box renderer).

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
