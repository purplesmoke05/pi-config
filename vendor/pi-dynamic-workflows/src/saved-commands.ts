/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findBuiltinWorkflow } from "./builtin-workflows.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
import { requireCustomWorkflowApproval } from "./workflow-trust.js";

function isRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

/**
 * Parse a command argument string into an `args` object for the script.
 * Supports `key=value` tokens; everything else collects into `_` (and `_raw`).
 * Declared parameter defaults fill in missing keys.
 */
export function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else positional.push(tok);
  }
  out._ = positional.join(" ");
  out._raw = raw.trim();
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/** Register one saved workflow as a `/<name>` command (idempotent).
 * Every saved command runs through the host WorkflowManager so the exact-script
 * approval, nested-script rejection, persistence, and background delivery
 * policies have one authoritative execution boundary.
 *
 * Pi has no `unregisterCommand`, so a command cannot be removed mid-session
 * after its workflow is deleted (it is correctly gone on next launch, since
 * registerAllSavedWorkflows only registers what's in storage). The optional
 * `exists` predicate lets the handler detect that case at invocation time and
 * tell the user to reload rather than silently re-running a deleted workflow. */
export function registerSavedWorkflow(
  pi: ExtensionAPI,
  wf: SavedWorkflow,
  manager: WorkflowManager,
  exists?: () => boolean,
): void {
  // Built-in names are reserved independently of registration order. This is
  // also important for embedders that register saved commands before built-ins.
  if (findBuiltinWorkflow(wf.name)) return;
  if (isRegistered(pi, wf.name)) return;
  pi.registerCommand(wf.name, {
    description: wf.description || `Saved workflow: ${wf.name}`,
    async handler(args: string, ctx: ExtensionCommandContext) {
      if (exists && !exists()) {
        ctx.ui.notify(`/${wf.name} was deleted — reload the session to remove this command.`, "warning");
        return;
      }
      try {
        const approval = await requireCustomWorkflowApproval(
          { source: "saved", label: wf.name, script: wf.script },
          ctx,
        );
        // The handler returns immediately (awaiting the promise here would block
        // the whole session, #104). installResultDelivery owns completion output,
        // so the command must not send a second result itself.
        const { runId } = manager.startInBackground(wf.script, parseCommandArgs(args, wf.parameters), {
          source: "custom",
          approval,
        });
        ctx.ui.notify(
          `/${wf.name} running in the background (${runId}) — watch the task panel or /workflows; the result is posted here when it finishes.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`/${wf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}

/** Register every saved workflow found in storage through the shared manager. */
export function registerAllSavedWorkflows(pi: ExtensionAPI, storage: WorkflowStorage, manager: WorkflowManager): void {
  for (const wf of storage.list()) {
    registerSavedWorkflow(pi, wf, manager, () => storage.list().some((w) => w.name === wf.name));
  }
}
