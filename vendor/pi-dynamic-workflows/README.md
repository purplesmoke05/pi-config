# pi-dynamic-workflows (reviewed vendor copy)

This directory contains the locally reviewed and hardened copy of
`@quintinshaw/pi-dynamic-workflows@3.5.0` used by this repository. The immutable
upstream documentation is preserved in [UPSTREAM-README.md](UPSTREAM-README.md).
See [NOTICE](NOTICE) for provenance and [SOURCE-PATCHES.md](SOURCE-PATCHES.md)
for the local security and packaging changes.

The extension is loaded from `extensions/workflow.ts`; Pi discovers the two
skills below `skills/`. It is not published or installed independently from
this directory.

## Security boundary

Built-in workflows are curated local code. Raw, saved, and resumed custom
workflow scripts are different: they execute with arbitrary Node.js authority
as the current user. Node's `vm` API is not a security sandbox. Interactive
execution therefore requires an explicit confirmation that shows the complete
script. The displayed request is snapshotted before the confirmation awaits,
dangerous invisible/control text is rendered visibly, and the resulting opaque
approval is valid for exactly one execution of that script. Execution without a
confirmation-capable UI fails closed. Curated built-ins similarly require an
opaque one-shot registry authorization: a caller-supplied source label or
persisted script is not provenance. Cold resume and UI restart re-derive the
current registry script and execution context before execution.

In-script `workflow(...)` nesting is disabled at the installed extension's
hardened `WorkflowManager` boundary because a
saved, computed, or argument-supplied child script is absent from the parent
approval. Write the child logic directly in the approved parent script instead.
The source distribution retains the upstream low-level `runWorkflow` API and a
non-enforcing manager mode for compatibility and tests. Pi does not load those
as its extension boundary; they are neither an approval layer nor a sandbox and
must not be used as a substitute for `extensions/workflow.ts`.

Web-research workflows receive only the reviewed bounded public-HTTP tools.
Repository-owned agent definitions are excluded unless Pi marks the project as
trusted, and worktree isolation fails instead of falling back to the shared
checkout. State is stored under the user workflow home rather than a
repository-owned `.pi/workflows` directory. Run and saved-workflow directories
are forced to mode `0700`; their JSON, temporary, backup, lease, and log files
are forced to mode `0600`. Existing artifacts are hardened when next touched,
and a permission-hardening or log-write failure is reported rather than hidden.
The state store is protected by owner-only filesystem permissions but is not a
cryptographically authenticated audit log; persisted built-in inputs remain
validated user data, while executable script/provenance and displayed metadata
are re-derived at the manager boundary. A same-user process can alter persisted
arguments, journal results/store deltas, and budget metadata that cold resume
may consume after structural validation. Treat persisted state as an
operational cache rather than trusted audit evidence.

## Supported workflow capabilities

The following table is generated from the executable capability contract. See
the [workflow authoring guide](docs/workflow-authoring.md) for constraints and
examples.

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional; default: derived from phase and call count)<br>`phase`: string (optional; default: current phase)<br>`schema`: plain JSON Schema (optional)<br>`model`: string (optional)<br>`tier`: string (optional)<br>`isolation`: "worktree" (optional)<br>`agentType`: string (optional)<br>`timeoutMs`: number \| null (optional; default: run timeout; null disables)<br>`retries`: number (optional; default: run retry count) |
| parallel | runtime-global | `parallel(thunks) => Promise<Array<unknown \| null>>` | — |
| pipeline | runtime-global | `pipeline(items, ...stages) => Promise<Array<unknown \| null>>` | — |
| verify | runtime-global | `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>` | `reviewers`: number (optional; default: 2)<br>`threshold`: number (optional; default: 0.5)<br>`lens`: string \| string[] (optional) |
| judgePanel | runtime-global | `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } \| undefined>` | `judges`: number (optional; default: 3)<br>`rubric`: string (optional; default: "overall quality and correctness") |
| loopUntilDry | runtime-global | `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>` | `round`: (roundIndex: number) => unknown[] \| Promise<unknown[]> (required)<br>`key`: (item: unknown) => string (optional; default: JSON.stringify)<br>`consecutiveEmpty`: number (optional; default: 2)<br>`maxRounds`: number (optional; default: 50) |
| completenessCheck | runtime-global | `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>` | — |
| retry | runtime-global | `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>` | `attempts`: number (optional; default: 3)<br>`until`: (result: unknown) => boolean (optional; default: accept first result when omitted) |
| gate | runtime-global | `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>` | `attempts`: number (optional; default: 3) |
| checkpoint | runtime-global | `checkpoint(prompt, options?) => Promise<unknown>` | `default`: unknown (optional; default: true when no UI and omitted)<br>`headless`: "default" \| "abort" (optional; default: "default")<br>`kind`: "confirm" \| "input" \| "select" (optional; default: "confirm")<br>`choices`: string[] (optional)<br>`timeoutMs`: number (optional) |
| log | runtime-global | `log(message) => void` | — |
| phase | runtime-global | `phase(title, options?) => void` | `budget`: number (optional) |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| budget | runtime-global | `budget: { total, spent(), remaining() }` | — |
| script | workflow-tool-input | `script?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: unknown` | — |
| background | workflow-tool-input | `background?: boolean = true` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = configured value or 0` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = configured default or unbounded` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number = configured default or unlimited` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
