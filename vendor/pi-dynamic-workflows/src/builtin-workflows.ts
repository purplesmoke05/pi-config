/**
 * Shared registry of the 5 curated built-in workflow patterns
 * (`deep-research`, `adversarial-review`, `code-review`, `multi-perspective`,
 * `codebase-audit`).
 *
 * This is the single place that turns a pattern's name + caller-supplied args
 * into a runnable script (and, where a pattern needs it, an exec context such
 * as web tools). Both entry points a model or user can reach a built-in
 * through — the `/deep-research`-style slash commands (builtin-commands.ts)
 * and the `workflow` tool's `name` input (workflow-tool.ts) — resolve through
 * this one registry, so the two paths can never drift apart and the
 * per-pattern generator scripts are written exactly once.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
import { generateCodeReviewWorkflow } from "./code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowInvocationSource } from "./workflow-trust.js";

/** Default perspective set used when a caller gives fewer than two. */
export const DEFAULT_MULTI_PERSPECTIVES: readonly string[] = [
  "technical",
  "product",
  "security",
  "user experience",
  "maintainability",
];

declare const BUILTIN_WORKFLOW_AUTHORIZATION_BRAND: unique symbol;

/** Opaque, one-shot evidence issued only by one of the five registry entries. */
export interface BuiltinWorkflowAuthorization {
  readonly [BUILTIN_WORKFLOW_AUTHORIZATION_BRAND]: true;
}

export interface AuthorizedBuiltinWorkflow {
  readonly name: string;
  readonly script: string;
  readonly args: unknown;
  readonly tools?: ToolDefinition[];
  readonly toolset?: string;
}

const issuedBuiltinAuthorizations = new WeakMap<object, AuthorizedBuiltinWorkflow>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function authorizeBuiltinWorkflow(
  name: string,
  args: unknown,
  invocation: Omit<BuiltinWorkflowInvocation, "args" | "authorization">,
): BuiltinWorkflowInvocation {
  const boundArgs = deepFreeze(structuredClone(args));
  const authorization = Object.freeze({}) as BuiltinWorkflowAuthorization;
  issuedBuiltinAuthorizations.set(
    authorization,
    Object.freeze({
      name,
      script: invocation.script,
      args: boundArgs,
      tools: invocation.tools,
      toolset: invocation.toolset,
    }),
  );
  return { ...invocation, args: boundArgs, authorization };
}

/** Consume genuine one-shot built-in provenance bound to this exact script. */
export function consumeBuiltinWorkflowAuthorization(
  authorization: BuiltinWorkflowAuthorization | undefined,
  script: string,
): AuthorizedBuiltinWorkflow | undefined {
  if (!authorization || typeof authorization !== "object") return undefined;
  const issued = issuedBuiltinAuthorizations.get(authorization);
  if (!issued) return undefined;
  issuedBuiltinAuthorizations.delete(authorization);
  return issued.script === script ? issued : undefined;
}

/** A resolved, ready-to-run script plus its immutable inputs, provenance, and
 * exec context (if any). */
export interface BuiltinWorkflowInvocation {
  script: string;
  args: unknown;
  authorization: BuiltinWorkflowAuthorization;
  tools?: ToolDefinition[];
  toolset?: string;
}

/** A named top-level invocation with its trust source made explicit. */
export type ResolvedWorkflowInvocation =
  | (BuiltinWorkflowInvocation & { name: string; source: Extract<WorkflowInvocationSource, "builtin"> })
  | {
      name: string;
      source: Extract<WorkflowInvocationSource, "saved">;
      script: string;
    };

export interface BuiltinWorkflowDescriptor {
  /** Also the slash-command name (without the leading `/`). */
  name: string;
  description: string;
  /** Build the script (and exec context) for one invocation; throws on invalid `args`. */
  resolve(cwd: string, args: unknown): BuiltinWorkflowInvocation;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function requireNonEmptyString(value: unknown, argName: string, patternName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Built-in workflow "${patternName}" requires args.${argName} to be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, argName: string, patternName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim())) {
    throw new Error(
      `Built-in workflow "${patternName}" requires args.${argName} to be a non-empty array of non-empty strings.`,
    );
  }
  return value;
}

/** The 5 curated built-in workflow patterns, keyed by their stable name. */
export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflowDescriptor[] = [
  {
    name: "deep-research",
    description: "Research a question across the web with cross-checked sources. args: { question: string }.",
    resolve(_cwd, args) {
      requireNonEmptyString(asRecord(args).question, "question", "deep-research");
      return authorizeBuiltinWorkflow("deep-research", args, {
        script: generateDeepResearchWorkflow(),
        // The manager resolves this tag through the host-injected audited
        // public-network runtime. Do not construct tools here: a resumed run
        // must cross the same boundary, and research agents must not inherit
        // coding/filesystem tools for hostile web content.
        toolset: "web-research",
      });
    },
  },
  {
    name: "adversarial-review",
    description:
      "Investigate a task, then cross-check each finding with skeptical reviewers. args: { task: string, reviewers?: number, threshold?: number }.",
    resolve(_cwd, args) {
      requireNonEmptyString(asRecord(args).task, "task", "adversarial-review");
      return authorizeBuiltinWorkflow("adversarial-review", args, { script: generateAdversarialReviewWorkflow() });
    },
  },
  {
    name: "code-review",
    description:
      "Multi-angle parallel code review: 7 specialized finders (correctness, reuse, simplification, efficiency, altitude) + verify pass → ranked findings. args: { diff: string, diffSource?: string }.",
    resolve(_cwd, args) {
      // Truncation past MAX_DIFF_CHARS already happens inside the generated
      // script at runtime (see code-review.ts); a caller invoking by name is
      // responsible for supplying `diff` (e.g. by running `git diff` itself),
      // unlike the /code-review slash command, which fetches it automatically.
      requireNonEmptyString(asRecord(args).diff, "diff", "code-review");
      return authorizeBuiltinWorkflow("code-review", args, { script: generateCodeReviewWorkflow() });
    },
  },
  {
    name: "multi-perspective",
    description:
      "Analyze a topic from several independent perspectives in parallel, then synthesize. args: { topic: string, perspectives?: string[] }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      const topic = requireNonEmptyString(record.topic, "topic", "multi-perspective");
      const perspectives =
        Array.isArray(record.perspectives) && record.perspectives.length >= 2
          ? requireStringArray(record.perspectives, "perspectives", "multi-perspective")
          : [...DEFAULT_MULTI_PERSPECTIVES];
      return authorizeBuiltinWorkflow("multi-perspective", args, {
        script: generateMultiPerspectiveWorkflow(topic, perspectives),
      });
    },
  },
  {
    name: "codebase-audit",
    description:
      "Run parallel checks against a codebase scope, then cross-validate and report. args: { scope: string, checks: string[] }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      const scope = requireNonEmptyString(record.scope, "scope", "codebase-audit");
      const checks = requireStringArray(record.checks, "checks", "codebase-audit");
      return authorizeBuiltinWorkflow("codebase-audit", args, {
        script: generateCodebaseAuditWorkflow(scope, checks),
      });
    },
  },
];

/** Stable list of built-in workflow pattern names, in registry order. */
export const BUILTIN_WORKFLOW_NAMES: readonly string[] = BUILTIN_WORKFLOWS.map((w) => w.name);

export function findBuiltinWorkflow(name: string): BuiltinWorkflowDescriptor | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.name === name);
}

/**
 * Resolve a name to a runnable invocation. Curated built-ins are reserved and
 * always win; a project/user saved file with the same name cannot shadow them.
 * The returned source is the single trust decision consumed by callers: only
 * `builtin` may execute without a custom-code confirmation.
 */
export function resolveWorkflowInvocation(
  name: string,
  args: unknown,
  ctx: { storage: WorkflowStorage; cwd: string },
): ResolvedWorkflowInvocation | undefined {
  const builtin = findBuiltinWorkflow(name);
  if (builtin) return { ...builtin.resolve(ctx.cwd, args), name, source: "builtin" };
  const saved = ctx.storage.load(name);
  if (saved) return { name, source: "saved", script: saved.script };
  return undefined;
}
