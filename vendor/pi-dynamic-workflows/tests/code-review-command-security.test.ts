import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodeReviewDiffCommand, registerBuiltinWorkflows } from "../src/builtin-commands.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

function makeFakeManager() {
  let starts = 0;
  const manager = {
    startInBackground() {
      starts++;
      return { runId: `run-${starts}`, promise: new Promise(() => {}) };
    },
  } as unknown as WorkflowManager;
  return { manager, starts: () => starts };
}

test("code-review terminates git option parsing around a revision range", () => {
  assert.deepEqual(buildCodeReviewDiffCommand("main..feature"), {
    command: "git",
    args: ["diff", "--end-of-options", "main..feature", "--"],
    diffSource: "git diff main..feature",
  });
});

test("code-review rejects option-shaped revision ranges before they can create or truncate files", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-dw-code-review-option-"));
  const proofPath = join(temp, "proof..");
  const injection = `--output=${proofPath}`;
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, starts } = makeFakeManager();

  try {
    registerBuiltinWorkflows(pi, { cwd: temp, manager });
    const handler = commands.find((command) => command.name === "code-review")?.handler;
    assert.ok(handler);

    const first = makeNotifyCtx();
    await handler(injection, first.ctx);
    assert.equal(existsSync(proofPath), false, "option injection must not create the requested output file");
    assert.equal(first.notified[0]?.type, "error");
    assert.match(first.notified[0]?.message ?? "", /revision range must not start/i);

    writeFileSync(proofPath, "sentinel", "utf8");
    const second = makeNotifyCtx();
    await handler(injection, second.ctx);
    assert.equal(readFileSync(proofPath, "utf8"), "sentinel", "option injection must not truncate an existing file");
    assert.equal(starts(), 0, "a rejected diff target must not start a workflow");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
