# Local patch inventory

Baseline: `earendil-works/pi`, commit
`542683b29ab2865976dddb006b4d70cffe315e25`, path
`packages/coding-agent/examples/extensions/plan-mode` (2026-06-21).

`SOURCE.sha256` pins the byte-identical upstream files. Two small local
changes are applied to `index.ts` for this repository's runtime. `utils.ts`
and `README.md` are unmodified.

## 1. Remove the non-existent `questionnaire` tool from plan mode's tool set

Upstream `PLAN_MODE_TOOLS` lists `questionnaire`. The pi runtimes this package
is tested against (0.83.0) do not register such a tool; `setActiveToolsByName`
silently ignores unknown names, so the entry was a no-op that still polluted
the intended active-tool set. The active plan-mode tool set is now
`read`, `bash`, `grep`, `find`, `ls`. The `ask_user_question` tool provided by
the vendored `rpiv-ask-user-question` extension is preserved automatically
because it is not in the plan-mode disabled set.

## 2. Fix the plan-mode system-prompt reference to the ask tool

Upstream context instructs the agent to "Ask clarifying questions using the
questionnaire tool". That tool does not exist in this runtime; the instruction
now names the actual ask tool available in this repository
(`ask_user_question`, conditionally). The upstream "brave-search skill" web
research hint was dropped because no such skill is shipped here; the agent
only acts on skills present in its own capability list, so this is a
documentation fix, not a behavior gate.

## Compatibility notes (no code change)

- `Ctrl+Alt+P` (`Key.ctrlAlt("p")`) is the toggle shortcut; it does not
  collide with any other vendored extension binding.
- `--plan` starts pi already in plan mode; pi documents extension-registered
  flags such as this in its CLI help.
- `registerShortcut("ctrl+alt+p", ...)` is not blocked by pi's reserved
  keybinding set (`app.*` and TUI globals), and plan mode is not
  `app.model.cycleForward` (Ctrl+P), which this repository leaves unassigned
  via `~/.pi/agent/keybindings.json`.
