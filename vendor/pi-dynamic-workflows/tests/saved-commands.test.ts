import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { renderWorkflowScriptForApproval } from "../src/workflow-trust.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

async function load() {
  return import("../src/saved-commands.js");
}

const nonExecutingManager = {
  startInBackground() {
    throw new Error("test manager must not execute");
  },
} as unknown as WorkflowManager;

describe("parseCommandArgs", () => {
  it("parses key=value pairs", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar count=42");
    assert.equal(result.foo, "bar");
    assert.equal(result.count, "42");
  });

  it("collects positional args into _", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello world");
    assert.equal(result._, "hello world");
  });

  it("handles mixed positional and key=value", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("task=test hello world");
    assert.equal(result.task, "test");
    assert.equal(result._, "hello world");
  });

  it("sets _raw to the trimmed input", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("  foo=bar  ");
    assert.equal(result._raw, "foo=bar");
  });

  it("returns empty when input is empty", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("");
    assert.equal(result._, "");
    assert.equal(result._raw, "");
  });

  it("fills parameter defaults for missing keys", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar", { foo: {}, limit: { default: 10 }, label: { default: "test" } });
    assert.equal(result.foo, "bar");
    assert.equal(result.limit, 10);
    assert.equal(result.label, "test");
  });

  it("does NOT override explicit values with defaults", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("limit=5", { limit: { default: 10 } });
    assert.equal(result.limit, "5");
  });

  it("handles value-only token as positional", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello key=value world");
    assert.equal(result._, "hello world");
    assert.equal(result.key, "value");
  });

  it("handles URLs as positional arguments", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("https://example.com");
    assert.equal(result._, "https://example.com");
  });
});

describe("registerSavedWorkflow", () => {
  it("registers a command with the workflow name", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = {
      name: "test-workflow",
      script: "export const meta = { name: 't', description: 't' };",
      description: "A test",
    };

    registerSavedWorkflow(pi, wf, nonExecutingManager);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "test-workflow");
  });

  it("is idempotent — second registration is skipped", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi(["test-workflow"]);
    const wf = { name: "test-workflow", script: "export const meta = { name: 't', description: 't' };" };

    registerSavedWorkflow(pi, wf, nonExecutingManager);
    assert.equal(commands.length, 0, "should not re-register when already present");
  });

  it("registers multiple saved workflows", async () => {
    const { registerAllSavedWorkflows } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const storage = {
      list: () => [
        { name: "wf1", script: "export..." },
        { name: "wf2", script: "export..." },
      ],
    };

    registerAllSavedWorkflows(pi, storage as never, nonExecutingManager);
    assert.deepEqual(
      commands.map((c) => c.name),
      ["wf1", "wf2"],
    );
  });

  it("does not register a saved workflow under a reserved built-in name", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();

    registerSavedWorkflow(
      pi,
      {
        name: "deep-research",
        script: "export const meta = { name: 'shadow', description: 'shadow' };",
      },
      nonExecutingManager,
    );

    assert.equal(commands.length, 0, "saved workflow must not shadow the curated built-in command");
  });

  it("runs through WorkflowManager when provided — without blocking or duplicating delivery (#104)", async () => {
    const { registerSavedWorkflow } = await load();
    let startedBackground = false;
    const manager = {
      startInBackground: (_script: string, _args: unknown) => {
        startedBackground = true;
        // Never resolves: if the handler awaited the run (the old blocking
        // behavior), this test would hang instead of passing.
        return { runId: "test-run", promise: new Promise(() => {}) };
      },
    };

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = { name: "run-via-manager", script: "export..." };
    registerSavedWorkflow(pi, wf, manager as never);

    const { ctx, notified, confirmed } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(startedBackground, true, "should use startInBackground when manager provided");
    assert.equal(confirmed.length, 1, "saved code must require one explicit confirmation");
    assert.match(confirmed[0].message, /arbitrary Node\.js code/i);
    assert.ok(
      confirmed[0].message.includes(renderWorkflowScriptForApproval(wf.script)),
      "confirmation must show the complete quoted script",
    );
    // Result delivery for managed background runs is installResultDelivery's job;
    // the handler sending its own copy too was the double-delivery bug.
    assert.equal(sent.length, 0, "handler must not send its own result message on the manager path");
    assert.equal(notified.length, 1);
    assert.equal(notified[0].type, "info");
    assert.ok(notified[0].message.includes("test-run"), "start notice should include the run id");
  });

  it("does not execute when the user rejects the saved script", async () => {
    const { registerSavedWorkflow } = await load();
    let started = false;
    const manager = {
      startInBackground: () => {
        started = true;
        return { runId: "unexpected", promise: Promise.resolve() };
      },
    };
    const script = "export const meta = { name: 'reject_me', description: 'reject' };\nreturn 1;";
    const { pi, commands } = makeCommandRegistryPi();
    registerSavedWorkflow(pi, { name: "reject-me", script }, manager as never);

    const { ctx, confirmed, notified } = makeNotifyCtx({ confirmResult: false });
    await commands[0].handler("", ctx);

    assert.equal(started, false);
    assert.equal(confirmed.length, 1);
    assert.ok(confirmed[0].message.includes(renderWorkflowScriptForApproval(script)));
    assert.match(notified[0]?.message ?? "", /not approved/i);
  });

  it("fails closed without a confirmation UI", async () => {
    const { registerSavedWorkflow } = await load();
    let started = false;
    const manager = {
      startInBackground: () => {
        started = true;
        return { runId: "unexpected", promise: Promise.resolve() };
      },
    };
    const { pi, commands } = makeCommandRegistryPi();
    registerSavedWorkflow(
      pi,
      { name: "headless", script: "export const meta = { name: 'h', description: 'h' };" },
      manager as never,
    );

    const { ctx, notified } = makeNotifyCtx({ hasUI: false });
    await commands[0].handler("", ctx);

    assert.equal(started, false);
    assert.match(notified[0]?.message ?? "", /headless|confirmation UI/i);
  });

  it("binds the approved script and parsed args to the required manager boundary", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();
    const starts: Array<{ script: string; args: unknown; exec: unknown }> = [];
    const manager = {
      startInBackground: (script: string, args: unknown, exec: unknown) => {
        starts.push({ script, args, exec });
        return { runId: "managed-run", promise: Promise.resolve() };
      },
    };
    const wf = {
      name: "managed-only",
      script: "export const meta = { name: 't', description: 't' };\nreturn { report: 'done' };",
    };
    registerSavedWorkflow(pi, wf, manager as never);

    const { ctx } = makeNotifyCtx();
    await commands[0].handler("childScript=hidden positional", ctx);

    assert.equal(starts.length, 1);
    assert.equal(starts[0].script, wf.script);
    assert.deepEqual(starts[0].args, {
      childScript: "hidden",
      _: "positional",
      _raw: "childScript=hidden positional",
    });
    assert.equal((starts[0].exec as { source?: string }).source, "custom");
    assert.equal((starts[0].exec as { approval?: { script?: string } }).approval?.script, wf.script);
    assert.equal(sent.length, 0, "installResultDelivery remains the sole completion path");
  });

  it("a deleted workflow's lingering command notifies and does not run", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    const wf = { name: "gone", script: "export const meta = { name: 't', description: 't' };\nreturn 1;" };
    // exists() reports the workflow has been deleted from storage.
    registerSavedWorkflow(pi, wf, nonExecutingManager, () => false);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(sent.length, 0, "a deleted workflow should not run or deliver a result");
    assert.equal(notified.length, 1, "the user should be told the command is stale");
    assert.match(notified[0].message, /deleted/i);
  });
});
