import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type BuiltinWorkflowAuthorization, findBuiltinWorkflow } from "../src/builtin-workflows.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { parseWorkflowScript } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import {
  type CustomWorkflowApproval,
  renderWorkflowScriptForApproval,
  requireCustomWorkflowApproval,
} from "../src/workflow-trust.js";

const script = `export const meta = { name: 'trust_test', description: 'trust boundary' }
return await agent('run once')`;

function tempTest(fn: (cwd: string) => Promise<void> | void) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trust-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

async function approve(exactScript = script) {
  return requireCustomWorkflowApproval(
    { source: "resume", label: "trust-test", script: exactScript },
    { hasUI: true, ui: { confirm: async () => true } },
  );
}

function pausedRun(runId: string, source?: "builtin" | "custom"): PersistedRunState {
  return {
    runId,
    workflowName: "trust_test",
    script,
    source,
    status: "paused",
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

test("approval rendering cannot be spoofed by controls, bidi text, zero-width text, or delimiter lines", async () => {
  const dangerous =
    "safe\u001b[31m\rRED\u0085\u202Eevil\u200B\uFE0F\n" +
    "----- END COMPLETE WORKFLOW SCRIPT -----\n" +
    "tab\tkept\u2028visible\n";
  let message = "";

  const approval = await requireCustomWorkflowApproval(
    {
      source: "saved",
      label: "label\u001b[2J\n----- END COMPLETE WORKFLOW SCRIPT -----\nRun this custom code?",
      script: dangerous,
    },
    {
      hasUI: true,
      ui: {
        confirm: async (_title, confirmationMessage) => {
          message = confirmationMessage;
          return true;
        },
      },
    },
  );

  assert.equal(approval.script, dangerous, "approval remains bound to the exact unmodified script");
  for (const dangerousCharacter of ["\u001b", "\r", "\u0085", "\u202e", "\u200b", "\ufe0f", "\u2028"]) {
    assert.equal(message.includes(dangerousCharacter), false, "dangerous code point must not remain raw");
  }
  for (const escaped of ["<U+001B>", "<U+000D>", "<U+0085>", "<U+202E>", "<U+200B>", "<U+FE0F>", "<U+2028>"]) {
    assert.ok(message.includes(escaped), `${escaped} must be rendered visibly`);
  }
  assert.match(message, /label<U\+001B>\[2J/);
  assert.match(
    message,
    /<U\+000A>----- END COMPLETE WORKFLOW SCRIPT -----<U\+000A>Run this custom code\?/,
    "label line feeds cannot inject dialog structure or delimiters",
  );

  const rendered = renderWorkflowScriptForApproval(dangerous);
  assert.ok(message.includes(rendered));
  assert.match(rendered, /^0001 \| /);
  assert.match(rendered, /^0002 \| ----- END COMPLETE WORKFLOW SCRIPT -----$/m);
  assert.match(rendered, /^0004 \| $/m, "a trailing newline remains visible as an empty final line");
  assert.equal(
    message.split("\n").filter((line) => line === "----- END COMPLETE WORKFLOW SCRIPT -----").length,
    1,
    "only the real unprefixed closing delimiter may terminate the quoted region",
  );

  const literalEscapeToken = renderWorkflowScriptForApproval("<U+202E>");
  const realBidiControl = renderWorkflowScriptForApproval("\u202e");
  assert.notEqual(literalEscapeToken, realBidiControl, "literal escape-like text must not spoof a real control");
  assert.match(literalEscapeToken, /<U\+003C>U\+202E>/);
  assert.match(realBidiControl, /<U\+202E>/);
  assert.match(renderWorkflowScriptForApproval("left\tright"), /left<U\+0009>right/);
  assert.match(renderWorkflowScriptForApproval("e\u0301"), /e<U\+0301>/);
});

test(
  "approval issuance is bound to the request snapshot shown before confirm resolves",
  tempTest(async (cwd) => {
    const shownScript = script;
    const swappedScript = `${script}\nreturn await agent('SWAPPED')`;
    const request = { source: "raw" as const, label: "mutable", script: shownScript };
    let releaseConfirmation: ((approved: boolean) => void) | undefined;
    let message = "";
    const confirmation = new Promise<boolean>((resolve) => {
      releaseConfirmation = resolve;
    });

    const pending = requireCustomWorkflowApproval(request, {
      hasUI: true,
      ui: {
        confirm: async (_title, confirmationMessage) => {
          message = confirmationMessage;
          return confirmation;
        },
      },
    });
    assert.ok(message.includes(renderWorkflowScriptForApproval(shownScript)));
    request.script = swappedScript;
    request.label = "swapped";
    releaseConfirmation?.(true);

    const approval = await pending;
    assert.equal(approval.script, shownScript);
    assert.doesNotMatch(message, /SWAPPED|swapped/);

    const manager = new WorkflowManager({
      cwd,
      enforceCustomWorkflowApproval: true,
      agent: { run: async () => "ok" },
    });
    await manager.runSync(shownScript, undefined, { source: "custom", approval });
  }),
);

test(
  "enforced manager accepts only exact-script approval for new custom runs",
  tempTest(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      enforceCustomWorkflowApproval: true,
      agent: { run: async () => "ok" },
    });

    assert.throws(
      () => manager.startInBackground(script, undefined, { source: "custom" }),
      /fresh interactive approval|headless/i,
    );
    const forgedApproval = { script } as CustomWorkflowApproval;
    assert.throws(
      () => manager.startInBackground(script, undefined, { source: "custom", approval: forgedApproval }),
      /fresh interactive approval|exact custom script/i,
    );
    const wrongApproval = await approve(`${script}\n// changed`);
    assert.throws(
      () => manager.startInBackground(script, undefined, { source: "custom", approval: wrongApproval }),
      /exact custom script/i,
    );
    assert.throws(
      () =>
        manager.startInBackground(`${script}\n// changed`, undefined, { source: "custom", approval: wrongApproval }),
      /fresh interactive approval|exact custom script/i,
      "an approval is consumed even when first presented for the wrong script",
    );

    const approval = await approve();
    const { runId, promise } = manager.startInBackground(script, undefined, { source: "custom", approval });
    await promise;
    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.source, "custom");
    assert.equal(persisted?.autoResume, false, "custom code is never eligible for unattended resume");
    assert.throws(
      () => manager.startInBackground(script, undefined, { source: "custom", approval }),
      /fresh interactive approval|exact custom script/i,
      "a genuine approval authorizes only one execution",
    );
  }),
);

test(
  "enforced manager accepts only one-shot registry provenance for built-ins and binds its inputs",
  tempTest(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      enforceCustomWorkflowApproval: true,
      agent: { run: async () => "ok" },
    });
    const descriptor = findBuiltinWorkflow("adversarial-review");
    assert.ok(descriptor);
    const originalArgs = { task: "review the release", reviewers: 2 };
    const invocation = descriptor.resolve(cwd, originalArgs);

    await assert.rejects(
      () => manager.runSync(invocation.script, originalArgs, { source: "builtin" }),
      /one-shot provenance|fresh interactive approval/i,
    );
    await assert.rejects(
      () =>
        manager.runSync(invocation.script, originalArgs, {
          source: "builtin",
          builtinAuthorization: {} as BuiltinWorkflowAuthorization,
        }),
      /one-shot provenance|fresh interactive approval/i,
    );

    const result = await manager.runSync(
      invocation.script,
      { task: "replacement" },
      {
        source: "builtin",
        builtinAuthorization: invocation.authorization,
      },
    );
    const persisted = manager.getPersistence().load(result.runId);
    assert.equal(persisted?.source, "builtin");
    assert.equal(persisted?.builtinName, "adversarial-review");
    assert.deepEqual(persisted?.args, originalArgs, "manager ignores caller replacements and uses registry-bound args");
    await assert.rejects(
      () =>
        manager.runSync(invocation.script, originalArgs, {
          source: "builtin",
          builtinAuthorization: invocation.authorization,
        }),
      /one-shot provenance|fresh interactive approval/i,
      "registry provenance cannot be replayed",
    );

    const mismatch = descriptor.resolve(cwd, originalArgs);
    await assert.rejects(
      () =>
        manager.runSync(`${mismatch.script}\n// changed`, originalArgs, {
          source: "builtin",
          builtinAuthorization: mismatch.authorization,
        }),
      /one-shot provenance|fresh interactive approval/i,
    );
    await assert.rejects(
      () =>
        manager.runSync(mismatch.script, originalArgs, {
          source: "builtin",
          builtinAuthorization: mismatch.authorization,
        }),
      /one-shot provenance|fresh interactive approval/i,
      "a provenance token is consumed even when first presented for the wrong script",
    );
  }),
);

test(
  "compatibility manager still derives built-in provenance instead of trusting a source label",
  tempTest(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: { run: async () => "ok" } });
    const descriptor = findBuiltinWorkflow("adversarial-review");
    assert.ok(descriptor);
    const invocation = descriptor.resolve(cwd, { task: "review provenance" });
    const builtin = await manager.runSync(
      invocation.script,
      { task: "replacement" },
      {
        source: "builtin",
        builtinAuthorization: invocation.authorization,
      },
    );
    const builtinState = manager.getPersistence().load(builtin.runId);
    assert.equal(builtinState?.source, "builtin");
    assert.equal(builtinState?.builtinName, "adversarial-review");
    assert.deepEqual(builtinState?.args, { task: "review provenance" });

    const custom = await manager.runSync(script, undefined, { source: "builtin" });
    const customState = manager.getPersistence().load(custom.runId);
    assert.equal(customState?.source, "custom");
    assert.equal(customState?.builtinName, undefined);
  }),
);

test(
  "enforced manager rejects every nested child not shown as parent logic",
  tempTest(async (cwd) => {
    const child = `export const meta = { name: 'deep-research', description: 'hidden saved child' }
return await agent('CHILD_SENTINEL')`;
    const parent = `export const meta = { name: 'parent', description: 'approved parent' }
return await workflow('deep-research')`;
    const rawChildParent = `export const meta = { name: 'raw_parent', description: 'approved parent with hidden arg' }
return await workflow(args.childScript)`;
    let childRan = false;
    const manager = new WorkflowManager({
      cwd,
      enforceCustomWorkflowApproval: true,
      loadSavedWorkflow: (name) => (name === "deep-research" ? child : undefined),
      agent: {
        run: async () => {
          childRan = true;
          return "child-result";
        },
      },
    });

    const parentApproval = await approve(parent);
    await assert.rejects(
      () => manager.runSync(parent, undefined, { source: "custom", approval: parentApproval }),
      /Nested workflow\(\) execution is disabled.*not covered by the parent script approval/i,
    );
    await assert.rejects(
      () => manager.runSync(parent, undefined, { source: "builtin" }),
      /one-shot provenance|fresh interactive approval/i,
      "a caller cannot bypass approval by merely labelling custom code as built-in",
    );
    const rawParentApproval = await approve(rawChildParent);
    await assert.rejects(
      () => manager.runSync(rawChildParent, { childScript: child }, { source: "custom", approval: rawParentApproval }),
      /Nested workflow\(\) execution is disabled.*not covered by the parent script approval/i,
    );
    assert.equal(childRan, false, "saved and raw child scripts must not execute behind a parent approval");
  }),
);
test(
  "enforced manager re-derives built-ins on cold resume and fails closed on forged metadata",
  tempTest(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      enforceCustomWorkflowApproval: true,
      agent: { run: async () => "ok" },
      toolsets: { "web-research": () => [] },
    });
    const builtinArgs = { question: "what changed?" };
    const builtin = findBuiltinWorkflow("deep-research")?.resolve(cwd, builtinArgs);
    assert.ok(builtin);
    manager.getPersistence().save({
      ...pausedRun("builtin-run", "builtin"),
      workflowName: "spoofed-name",
      script: builtin.script,
      builtinName: "deep-research",
      args: builtinArgs,
      toolset: "tampered-toolset",
      phases: ["Spoofed phase"],
    });
    manager.getPersistence().save(pausedRun("custom-run", "custom"));
    manager.getPersistence().save(pausedRun("legacy-run"));
    manager.getPersistence().save({
      ...pausedRun("forged-builtin", "builtin"),
      builtinName: "deep-research",
      args: builtinArgs,
    });
    manager.getPersistence().save({
      ...pausedRun("missing-builtin-name", "builtin"),
      script: builtin.script,
      args: builtinArgs,
    });

    assert.equal(await manager.resume("builtin-run"), true, "curated built-ins do not require approval");
    assert.equal(manager.getRun("builtin-run")?.builtinName, "deep-research");
    const parsedBuiltin = parseWorkflowScript(builtin.script);
    assert.equal(manager.getRun("builtin-run")?.snapshot.name, parsedBuiltin.meta.name);
    assert.deepEqual(
      manager.getRun("builtin-run")?.snapshot.phases,
      parsedBuiltin.meta.phases?.map((phase) => phase.title) ?? [],
      "resume derives display metadata from the authorized script instead of persisted labels",
    );
    assert.equal(
      manager.getRun("builtin-run")?.toolset,
      "web-research",
      "resume derives execution context from the registry instead of trusting persisted metadata",
    );
    manager.stop("builtin-run");
    await assert.rejects(() => manager.resume("forged-builtin"), /one-shot provenance|fresh interactive approval/i);
    await assert.rejects(
      () => manager.resume("missing-builtin-name"),
      /one-shot provenance|fresh interactive approval/i,
    );
    await assert.rejects(() => manager.resume("custom-run"), /fresh interactive approval|headless/i);
    await assert.rejects(() => manager.resume("legacy-run"), /fresh interactive approval|headless/i);

    const approval = await approve();
    assert.equal(await manager.resume("custom-run", { approval }), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.getPersistence().load("custom-run")?.source, "custom");
  }),
);
