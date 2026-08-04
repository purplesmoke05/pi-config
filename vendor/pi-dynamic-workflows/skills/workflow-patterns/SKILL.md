---
name: workflow-patterns
description: Argument shapes for the 5 built-in workflow patterns — deep-research, adversarial-review, code-review, multi-perspective, codebase-audit — runnable via the `workflow` tool's `name` input, without slash-command syntax. Use for requests like "research X", "fact-check/adversarially review this", "review this diff/PR", "analyze from multiple perspectives", or "audit the codebase for Y". Not for authoring a new workflow script — see workflow-authoring.
metadata:
  version: "3.5.0"
---

# Built-in workflow patterns

pi-dynamic-workflows ships 5 curated, tested workflow patterns. Each is also a
slash command (`/deep-research`, `/adversarial-review`, `/code-review`,
`/multi-perspective`, `/codebase-audit`), but they are equally reachable from
the `workflow` tool directly: call it with `name` set to the pattern name
below and `args` matching its shape, instead of writing an equivalent script
from scratch. Prefer this over authoring a new script whenever the request
fits one of these shapes — the curated version is already reviewed and tested.

The five built-in names are reserved. A project or user saved workflow cannot
shadow them; the curated built-in always takes precedence on both the tool and
slash-command paths.

These 5 names are reachable only at the `workflow` tool's top-level `name`
input. The audited host disables every in-script `workflow(...)` nested call
because child code is outside the parent approval. Put custom child logic in the
same approved script, and use the top-level `name` input for a curated built-in.

## Patterns

| `name` | When to reach for it | `args` |
| --- | --- | --- |
| `deep-research` | Research a question across the web with cross-checked sources | `{ question: string, angles?: number, minSupport?: number }` — `angles` (default 4) is the number of distinct search queries; `minSupport` (default 2) is the minimum distinct sources required for a claim to survive cross-checking |
| `adversarial-review` | Investigate a task/claim, then cross-check each finding with skeptical reviewers | `{ task: string, reviewers?: number, threshold?: number }` |
| `code-review` | Multi-angle review of a diff (correctness, reuse, simplification, efficiency, altitude) | `{ diff: string, diffSource?: string }` — get `diff` yourself first (e.g. `git diff`, `gh pr diff <n>`); this path does not fetch it for you |
| `multi-perspective` | Analyze a topic from several independent perspectives in parallel, then synthesize | `{ topic: string, perspectives?: string[] }` — omit or give fewer than 2 to use the default set (technical, product, security, user experience, maintainability) |
| `codebase-audit` | Run parallel checks against a codebase scope, then cross-validate and report | `{ scope: string, checks: string[] }` |

## Example

```json
{ "name": "deep-research", "args": { "question": "What are the tradeoffs of X vs Y?" } }
```

This is a `workflow` tool call, not a script — omit `script` entirely. The run
starts in the background exactly like the slash-command form; `background`,
`maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget`
all still apply.

## Writing a new workflow instead

If the request doesn't fit one of these 5 shapes, author a script with
`script` as usual — see the workflow-authoring skill.
