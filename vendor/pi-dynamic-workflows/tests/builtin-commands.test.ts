import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import { parseWorkflowScript } from "../src/workflow.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

/**
 * Fake manager that records startInBackground calls. The returned promise never
 * resolves — so any handler that (incorrectly) awaited it would hang its test,
 * which is exactly the #104 regression this guards against.
 */
function makeFakeManager() {
  const started: Array<{
    script: string;
    args: unknown;
    exec: { tools?: unknown[]; toolset?: string; source?: string };
  }> = [];
  const manager = {
    startInBackground(
      script: string,
      args?: unknown,
      exec: { tools?: unknown[]; toolset?: string; source?: string } = {},
    ) {
      started.push({ script, args, exec });
      return { runId: `run-test-${started.length}`, promise: new Promise(() => {}) };
    },
  } as unknown as WorkflowManager;
  return { manager, started };
}

test("registerBuiltinWorkflows registers all five built-in workflow commands", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  assert.equal(commands.length, 5);
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "adversarial-review",
    "code-review",
    "codebase-audit",
    "deep-research",
    "multi-perspective",
  ]);
});

test("registerBuiltinWorkflows is idempotent — skips already registered commands", () => {
  const { pi, commands } = makeCommandRegistryPi([
    "deep-research",
    "adversarial-review",
    "multi-perspective",
    "codebase-audit",
    "code-review",
  ]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  assert.equal(commands.length, 0, "should not re-register when already present");
});

test("registerBuiltinWorkflows registers only missing commands", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research", "adversarial-review"]);
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  assert.deepEqual(
    commands.map((c) => c.name).sort(),
    ["code-review", "codebase-audit", "multi-perspective"],
    "should only register the commands that aren't already present",
  );
});

test("registerBuiltinWorkflows deep-research handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  const deepResearchHandler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deepResearchHandler, "deep-research handler should exist");

  // Calling with empty args should warn and return early (before running any workflow)
  const { ctx, notified } = makeNotifyCtx();
  await deepResearchHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows adversarial-review handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  const advHandler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(advHandler, "adversarial-review handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await advHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows multi-perspective handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  const handler = commands.find((c) => c.name === "multi-perspective")?.handler;
  assert.ok(handler, "multi-perspective handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  await handler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("registerBuiltinWorkflows codebase-audit handler validates missing checks (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  const handler = commands.find((c) => c.name === "codebase-audit")?.handler;
  assert.ok(handler, "codebase-audit handler should exist");

  const { ctx, notified } = makeNotifyCtx();
  // scope but no checks → should warn and return early
  await handler("src/", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("built-in handlers start a background run and return immediately (#104)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager });
  const handler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  // The fake manager's promise never resolves — if the handler awaited the run
  // (the old inline behavior), this await would hang the test.
  await handler("audit the error paths", ctx);

  assert.equal(started.length, 1, "should start exactly one managed background run");
  assert.deepEqual(started[0].args, { task: "audit the error paths" });
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "info");
  assert.ok(notified[0].message.includes("run-test-1"), "start notice should include the run id");
  assert.ok(notified[0].message.includes("background"), "start notice should say it runs in the background");
});

test("deep-research passes its restricted web toolset tag to the built-in run", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager });
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx } = makeNotifyCtx();
  await handler("what is pi?", ctx);

  assert.equal(started.length, 1);
  assert.deepEqual(started[0].args, { question: "what is pi?" });
  assert.equal(started[0].exec.tools, undefined, "tools resolve only at the host composition root");
  // The persistable tag is what lets a resumed run re-resolve these tools.
  assert.equal(started[0].exec.toolset, "web-research");
  assert.equal(started[0].exec.source, "builtin");
});

test("startInBackground throwing synchronously surfaces as an error notify, not an unhandled throw", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const manager = {
    startInBackground() {
      throw new Error("lease unavailable");
    },
  } as unknown as WorkflowManager;
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager });
  const handler = commands.find((c) => c.name === "adversarial-review")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  await handler("some task", ctx);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "error");
  assert.ok(notified[0].message.includes("lease unavailable"));
});

test("registerBuiltinWorkflows creates handlers with expected structure", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });

  const deepResearchCmd = commands.find((c) => c.name === "deep-research");
  assert.ok(deepResearchCmd, "deep-research should be registered");
  assert.ok(deepResearchCmd.description?.includes("Research"), "should have research description");
  assert.equal(typeof deepResearchCmd.handler, "function");

  const advReviewCmd = commands.find((c) => c.name === "adversarial-review");
  assert.ok(advReviewCmd, "adversarial-review should be registered");
  assert.ok(
    advReviewCmd.description?.includes("Investigate") || advReviewCmd.description?.includes("Review"),
    "should contain Investigate",
  );
  assert.equal(typeof advReviewCmd.handler, "function");

  const codeReviewCmd = commands.find((c) => c.name === "code-review");
  assert.ok(codeReviewCmd, "code-review should be registered");
  assert.ok(codeReviewCmd.description?.includes("Multi-angle"), "should describe the multi-angle review");
  assert.equal(typeof codeReviewCmd.handler, "function");
});

// Built-in slash commands always run the audited registry script. Saved
// commands with the same reserved name are never registered (saved-commands).
test("deep-research slash command always runs the curated built-in", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager });
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx } = makeNotifyCtx();
  await handler("what is pi?", ctx);

  assert.equal(started.length, 1);
  const { meta } = parseWorkflowScript(started[0].script);
  assert.equal(meta.name, "deep_research");
});

// ─── Validation drift: registry errors reach the user as a notify, not a throw ─

test("multi-perspective handler notifies (not throws) for a whitespace-only topic", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  const handler = commands.find((c) => c.name === "multi-perspective")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  // A quoted whitespace-only topic passes the handler's own cheap `!topic`
  // check (non-empty length) but fails the registry's real validation.
  await assert.doesNotReject(() => handler('"  "', ctx));
  assert.equal(notified.length, 1, "should notify instead of throwing");
  assert.equal(notified[0].type, "warning");
  assert.match(notified[0].message, /topic/i);
});

test("codebase-audit handler notifies (not throws) for a whitespace-only check", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager: makeFakeManager().manager });
  const handler = commands.find((c) => c.name === "codebase-audit")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  // An empty quoted check token passes checks.length === 0 (length is 1) but
  // fails the registry's real validation.
  await assert.doesNotReject(() => handler('src ""', ctx));
  assert.equal(notified.length, 1, "should notify instead of throwing");
  assert.equal(notified[0].type, "warning");
  assert.match(notified[0].message, /checks/i);
});

// ─── Quote injection: quotes/apostrophes reach the generated script safely ─────

test("multi-perspective handler passes an apostrophe-laden perspective through without throwing", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager });
  const handler = commands.find((c) => c.name === "multi-perspective")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  await handler(`"climate policy" "user's view" "another's take"`, ctx);

  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "info", "should start successfully, not warn/error");
  assert.equal(started.length, 1);
  const { meta } = parseWorkflowScript(started[0].script);
  assert.equal(meta.name, "multi_perspective_analysis");
});

test("codebase-audit handler passes a quote-laden check through without throwing", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, { cwd: "/tmp", manager });
  const handler = commands.find((c) => c.name === "codebase-audit")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  await handler(`src/ "find TODO's"`, ctx);

  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "info");
  assert.equal(started.length, 1);
  const { meta } = parseWorkflowScript(started[0].script);
  assert.equal(meta.name, "codebase_audit");
});
