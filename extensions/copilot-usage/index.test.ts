import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import copilotUsageExtension from "./index.ts";

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function createHarness(
	initialBranch: Array<Record<string, unknown>> = [],
	provider = "github-copilot",
) {
	const handlers = new Map<string, EventHandler[]>();
	const widgets = new Map<string, string[] | undefined>();
	const widgetWrites: Array<{ key: string; value: string[] | undefined }> = [];
	const statuses = new Map<string, string | undefined>();
	const branch = [...initialBranch];
	const systemPrompt = [
		'<project_instructions path="/work/project/AGENTS.md">',
		"<github_copilot_instructions>",
		'<instruction path=".github/copilot-instructions.md" kind="repository-wide">',
		"</github_copilot_instructions>",
	].join("\n");

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/work/project",
		model: { provider, id: "gpt-5.6-luna" },
		sessionManager: { getBranch: () => branch },
		getSystemPrompt: () => systemPrompt,
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: (key: string, value: string[] | undefined) => {
				widgets.set(key, value);
				widgetWrites.push({ key, value });
			},
		},
	} as unknown as ExtensionContext;

	copilotUsageExtension(pi);
	const emit = (type: string, event: Record<string, unknown>): void => {
		for (const handler of handlers.get(type) ?? []) handler(event, ctx);
	};
	emit("session_start", { type: "session_start" });
	return { emit, statuses, systemPrompt, widgets, widgetWrites };
}

function showFirstRequestContext(harness: ReturnType<typeof createHarness>): void {
	harness.emit("message_start", {
		type: "message_start",
		message: {
			role: "user",
			content: '<file name="/work/project/src/input.ts">\ncontents\n</file>',
		},
	});
	harness.emit("before_provider_request", {
		type: "before_provider_request",
		payload: { instructions: harness.systemPrompt, input: [] },
	});
}

describe("Copilot usage extension UI lifecycle", () => {
	it("does not show Copilot UI for another provider", () => {
		const harness = createHarness([], "openai");
		showFirstRequestContext(harness);

		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
		assert.equal(harness.statuses.get("copilot-usage"), undefined);
	});

	it("uses the final system prompt, shows tagged files once, and clears them on the next regular turn", () => {
		const harness = createHarness();
		showFirstRequestContext(harness);

		assert.deepEqual(harness.widgets.get("copilot-initial-context"), [
			"Copilot first request · tagged files detected (3)",
			"automatic context:",
			"  AGENTS.md",
			"  .github/copilot-instructions.md",
			"prompt file tags:",
			"  src/input.ts",
		]);
		assert.match(harness.statuses.get("copilot-usage") ?? "", /Copilot sending≈/);
		assert.match(harness.statuses.get("copilot-usage") ?? "", /branch ≈0 cr, 0 in\/0 out tok/);

		const initialWidgetWrites = harness.widgetWrites.filter(
			(write) => write.key === "copilot-initial-context" && write.value !== undefined,
		).length;
		harness.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { instructions: harness.systemPrompt, input: [] },
		});
		assert.equal(
			harness.widgetWrites.filter(
				(write) => write.key === "copilot-initial-context" && write.value !== undefined,
			).length,
			initialWidgetWrites,
		);

		harness.emit("agent_end", { type: "agent_end", messages: [] });
		assert.notEqual(harness.widgets.get("copilot-initial-context"), undefined);

		harness.emit("message_start", {
			type: "message_start",
			message: { role: "user", content: "second turn" },
		});
		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
	});

	it("clears first-request context when a queued user message starts", () => {
		const harness = createHarness();
		showFirstRequestContext(harness);

		harness.emit("message_start", {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "queued follow-up" },
					{ type: "image", data: "omitted", mimeType: "image/png" },
				],
			},
		});
		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
	});

	it("suppresses the widget when resuming a branch that already has an assistant response", () => {
		const harness = createHarness([
			{ type: "message", message: { role: "assistant", provider: "github-copilot" } },
		]);
		showFirstRequestContext(harness);

		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
		assert.equal(
			harness.widgetWrites.filter(
				(write) => write.key === "copilot-initial-context" && write.value !== undefined,
			).length,
			0,
		);
	});

	it("clears stale first-request context when navigating the session tree", () => {
		const harness = createHarness();
		showFirstRequestContext(harness);

		harness.emit("session_tree", { type: "session_tree", newLeafId: "other", oldLeafId: "first" });
		assert.equal(harness.widgets.get("copilot-initial-context"), undefined);
	});
});
