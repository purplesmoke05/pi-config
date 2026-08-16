import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolCallIndexer } from "../src/indexer.ts";
import { pruneMessages } from "../src/pruner.ts";
import { registerQueryTool } from "../src/query-tool.ts";
import { summarizerThinkingOptions } from "../src/summarizer.ts";
import { DEFAULT_CONFIG, type ContextPruneConfig } from "../src/types.ts";

describe("vendored pi-context-prune integration", () => {
  it("starts disabled and keeps the upstream conservative trigger", () => {
    assert.equal(DEFAULT_CONFIG.enabled, false);
    assert.equal(DEFAULT_CONFIG.pruneOn, "agent-message");
  });

  it("maps summarizer thinking without forcing a value for default/off", () => {
    const config = (summarizerThinking: ContextPruneConfig["summarizerThinking"]): ContextPruneConfig => ({
      ...DEFAULT_CONFIG,
      summarizerThinking,
    });
    assert.deepEqual(summarizerThinkingOptions(config("default")), {});
    assert.deepEqual(summarizerThinkingOptions(config("off")), { reasoningEffort: undefined });
    assert.deepEqual(summarizerThinkingOptions(config("low")), { reasoningEffort: "low" });
  });

  it("removes only indexed tool results from future context", () => {
    const indexer = new ToolCallIndexer();
    indexer.getIndex().set("call-1", {
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a.ts" },
      resultText: "full original output",
      isError: false,
      turnIndex: 1,
      timestamp: 1,
    });
    const messages = [
      { role: "assistant", content: [] },
      { role: "toolResult", toolCallId: "call-1", content: "prune me" },
      { role: "toolResult", toolCallId: "call-2", content: "keep me" },
    ];
    assert.deepEqual(pruneMessages(messages, indexer), [messages[0], messages[2]]);
  });

  it("registers the recovery tool with the repo's TypeBox runtime", async () => {
    const indexer = new ToolCallIndexer();
    indexer.getIndex().set("call-1", {
      toolCallId: "call-1",
      toolName: "grep",
      args: { pattern: "needle" },
      resultText: "needle found",
      isError: false,
      turnIndex: 2,
      timestamp: 2,
    });
    let tool: any;
    registerQueryTool({ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI, indexer);
    assert.equal(tool.name, "context_tree_query");
    const result = await tool.execute("test", { toolCallIds: ["call-1"] }, undefined, undefined, undefined);
    assert.match(result.content[0].text, /needle found/);
  });
});
