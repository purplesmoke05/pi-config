/**
 * Trust boundary for workflow scripts.
 *
 * Curated built-ins are part of the audited extension source. Every other
 * script is custom JavaScript and must be shown in full to a human before it
 * reaches the Node `vm` runtime. Node's `vm` module is an execution mechanism,
 * not a security sandbox, so this gate deliberately does not rely on keyword
 * or AST denylists.
 */

export type WorkflowInvocationSource = "builtin" | "saved" | "raw" | "resume";
export type WorkflowExecutionSource = "builtin" | "custom";

/** Evidence that the exact script text was approved by the human UI gate. */
export interface CustomWorkflowApproval {
  readonly script: string;
}

/** Module-private issuance registry. A structurally identical `{ script }`
 * object is not approval, and each real approval authorizes one execution. */
const issuedApprovals = new WeakMap<object, string>();

export interface WorkflowApprovalContext {
  hasUI?: boolean;
  ui?: {
    confirm?(title: string, message: string): Promise<boolean>;
  };
}

export interface CustomWorkflowApprovalRequest {
  source: Exclude<WorkflowInvocationSource, "builtin">;
  script: string;
  /** Human-readable identifier, such as a saved workflow name or run ID. */
  label?: string;
}

export class CustomWorkflowApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomWorkflowApprovalError";
  }
}

function sourceDescription(request: CustomWorkflowApprovalRequest): string {
  const label = request.label ? ` "${renderInlineForApproval(request.label, true)}"` : "";
  switch (request.source) {
    case "saved":
      return `saved workflow${label}`;
    case "resume":
      return `resumed workflow${label}`;
    case "raw":
      return `raw workflow${label}`;
  }
}

function visibleCodePoint(char: string): string {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return "";
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}

function mustEscapeForApproval(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  // Escape literal '<' so source text such as "<U+202E>" cannot render
  // identically to a real escaped U+202E control. LF is rendered structurally
  // by the line renderer; every other C0 control (including TAB), DEL, and C1
  // is made explicit.
  if (char === "<") return true;
  if ((codePoint <= 0x1f && codePoint !== 0x0a) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return true;
  }
  // Unicode format controls include bidi overrides/isolates, joiners,
  // zero-width spaces, BOM, and other non-printing layout controls. Also make
  // line/paragraph separators, lone surrogates, grapheme fillers, and variation
  // selectors explicit so the reviewed text is stable across renderers.
  if (/^[\p{Cf}\p{M}\p{Zl}\p{Zp}\p{Cs}]$/u.test(char)) return true;
  return (
    codePoint === 0x034f ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    codePoint === 0x3164 ||
    codePoint === 0xffa0 ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function renderInlineForApproval(text: string, escapeLineFeed = false): string {
  let rendered = "";
  for (const char of text) {
    rendered += (escapeLineFeed && char === "\n") || mustEscapeForApproval(char) ? visibleCodePoint(char) : char;
  }
  return rendered;
}

/**
 * Render every original code point inside a line-numbered quoted region.
 * Newlines become line boundaries; dangerous invisible/control code points
 * become reversible `<U+XXXX>` tokens. Fixed prefixes ensure script text can
 * never synthesize an unquoted delimiter line.
 */
export function renderWorkflowScriptForApproval(script: string): string {
  const lines = script.split("\n");
  const width = Math.max(4, String(lines.length).length);
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, "0")} | ${renderInlineForApproval(line)}`)
    .join("\n");
}

/**
 * Require an explicit human confirmation before executing custom workflow
 * JavaScript. Missing dialog support is a hard failure: print/JSON/headless
 * modes must never silently grant code-execution authority.
 */
export async function requireCustomWorkflowApproval(
  request: CustomWorkflowApprovalRequest,
  ctx: WorkflowApprovalContext | undefined,
): Promise<CustomWorkflowApproval> {
  // Snapshot every caller-controlled field before the first await. Otherwise a
  // mutable request could show one script in the dialog, change while confirm()
  // is pending, and receive approval for different text after it resolves.
  const source = request.source;
  const script = request.script;
  const label = request.label;
  const snapshot: CustomWorkflowApprovalRequest = Object.freeze({
    source,
    script,
    ...(label === undefined ? {} : { label }),
  });
  const ui = ctx?.hasUI === true ? ctx.ui : undefined;
  const confirm = ui?.confirm;
  if (typeof confirm !== "function") {
    throw new CustomWorkflowApprovalError(
      `Cannot run ${sourceDescription(snapshot)} without an interactive confirmation UI. ` +
        "Custom workflows are arbitrary Node.js code and are disabled in headless mode.",
    );
  }

  const message = [
    `You are about to run ${sourceDescription(snapshot)}.`,
    "",
    "Node's vm module is not a security sandbox. This script can execute arbitrary Node.js code",
    "with the same filesystem, process, network, and credential access as this Pi process.",
    "Review the complete script before approving:",
    "Each original line is prefixed below; <U+XXXX> denotes an escaped control, invisible, combining, or literal '<' code point.",
    "",
    "----- BEGIN COMPLETE WORKFLOW SCRIPT -----",
    renderWorkflowScriptForApproval(snapshot.script),
    "----- END COMPLETE WORKFLOW SCRIPT -----",
    "",
    "Run this custom code?",
  ].join("\n");

  const approved = await confirm.call(ui, "Run custom workflow code?", message);
  if (!approved) {
    throw new CustomWorkflowApprovalError(`${sourceDescription(snapshot)} was not approved; nothing was executed.`);
  }
  const approval = Object.freeze({ script: snapshot.script });
  issuedApprovals.set(approval, snapshot.script);
  return approval;
}

/** Consume a genuine one-shot approval for this exact script. */
export function consumeCustomWorkflowApproval(approval: CustomWorkflowApproval | undefined, script: string): boolean {
  if (!approval || typeof approval !== "object") return false;
  const approvedScript = issuedApprovals.get(approval);
  if (approvedScript === undefined) return false;
  issuedApprovals.delete(approval);
  return approvedScript === script && approval.script === script;
}
